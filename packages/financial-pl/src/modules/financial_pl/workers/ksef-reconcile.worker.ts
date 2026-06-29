import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { KsefSubmission } from '../data/entities'
import { chooseRecovery } from '../lib/recovery'
import { emitFinancialPlEvent } from '../events'

/**
 * Periodic reconciliation sweep that recovers KSeF submissions which fell out of
 * the normal queued -> processing -> terminal flow. Recovery is ROUTED per row by
 * `chooseRecovery` (whether the send already reached KSeF):
 *  - a stale `processing` row that carries BOTH `sessionReference` and
 *    `invoiceReference` provably reached KSeF, so it is recovered by RE-POLLING:
 *    a cutoff-guarded CAS bump (attemptCount/updatedAt) that KEEPS status
 *    `processing`, then a `financial_pl.ksef_submission.repoll` emit. The repoll
 *    subscriber asks KSeF for the status/UPO (read-only — never re-sends) and, if
 *    KSeF has no record / the status stays non-terminal, falls back to a re-send.
 *  - a stale `processing` row WITHOUT both references (a true orphan: the send
 *    never landed, or crashed before references were persisted) OR a stale
 *    `queued` row whose dispatch event was lost is recovered by RE-SENDING: reset
 *    to `queued` and re-emit `financial_pl.ksef_submission.queued`.
 *
 * Re-sending is duplicate-safe: the subscriber's atomic claim guarantees single
 * execution, and KSeF's native 440-duplicate detection resolves any
 * content-identical re-send to `accepted` with the original KSeF number + UPO, so
 * an invoice is never registered twice.
 *
 * In both paths the cutoff-guarded CAS bump (`< cutoff`) makes the re-drive a
 * claim (exactly one sweep run re-drives a given row) and advances the circuit
 * breaker (attemptCount/maxAttempts) so an unrecoverable row eventually surfaces
 * as gave-up rather than looping across the repoll/re-send paths.
 *
 * The worker context (DI resolve, queue job wrapper) is typed structurally rather
 * than importing `@open-mercato/queue` — this module does not declare it as a
 * dependency, mirroring how the ksef-submit subscriber types its context.
 */
type ReconcilePayload = {
  scope?: { organizationId?: string; tenantId?: string }
  organizationId?: string
  tenantId?: string
}

type ReconcileJob = { payload: ReconcilePayload }

type HandlerContext = {
  resolve: <T = unknown>(name: string) => T
}

export const metadata = {
  queue: 'financial-pl-ksef-reconcile',
  id: 'financial_pl:ksef-reconcile',
  concurrency: 1,
}

const DEFAULT_STALE_MINUTES = 15
const DEFAULT_MAX_ATTEMPTS = 6
const CANDIDATE_BATCH = 100
// How far ahead of the statutory deadline the deferred offline send is triggered. The
// offline-issued row never reached KSeF, so it needs its INITIAL send within the deadline; we
// pick it up once the deadline is within this lookahead (or already past) and prioritize the
// most-urgent rows first (soonest deadline). Overridable so an operator can widen the window.
const DEFAULT_OFFLINE_LOOKAHEAD_HOURS = 24

function readPositiveInt(envValue: string | undefined, fallback: number): number {
  const parsed = Number(envValue)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export default async function handle(job: ReconcileJob, ctx: HandlerContext): Promise<void> {
  const organizationId = job.payload.scope?.organizationId ?? job.payload.organizationId
  const tenantId = job.payload.scope?.tenantId ?? job.payload.tenantId
  if (!organizationId || !tenantId) return

  const em = (ctx.resolve('em') as EntityManager).fork()
  const staleMinutes = readPositiveInt(process.env.OM_KSEF_RECONCILE_STALE_MINUTES, DEFAULT_STALE_MINUTES)
  const maxAttempts = readPositiveInt(process.env.OM_KSEF_RECONCILE_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS)
  const cutoff = new Date(Date.now() - staleMinutes * 60_000)

  // Project only plaintext columns so the encrypted invoice_xml/upo_xml are not
  // loaded (and not auto-decrypted by the on-load encryption subscriber) — the
  // reconciler never needs them. `sessionReference`/`invoiceReference` are
  // plaintext and required to route a stale `processing` row (repoll vs re-send).
  const fields = [
    'id',
    'status',
    'attemptCount',
    'submittedAt',
    'updatedAt',
    'sessionReference',
    'invoiceReference',
    'offlineSendDeadlineAt',
  ] as const

  // Orphaned `processing` rows are keyed on `submittedAt` (set at the CAS claim),
  // so a freshly-claimed row a live worker is still processing is excluded — only
  // claims older than the staleness window match. `queued` rows are keyed on
  // `updatedAt`; re-emitting one is always safe because the subscriber claim
  // deduplicates. Over-ceiling rows are excluded from the candidate set so they
  // can never starve recoverable rows out of the bounded batch.
  const orphanedProcessing = await em.find(
    KsefSubmission,
    { organizationId, tenantId, deletedAt: null, status: 'processing', attemptCount: { $lt: maxAttempts }, submittedAt: { $lt: cutoff } },
    { fields, limit: CANDIDATE_BATCH },
  )
  const stuckQueued = await em.find(
    KsefSubmission,
    { organizationId, tenantId, deletedAt: null, status: 'queued', attemptCount: { $lt: maxAttempts }, updatedAt: { $lt: cutoff } },
    { fields, limit: CANDIDATE_BATCH },
  )

  // Offline-issued rows (offline24 / awaryjny) need their INITIAL send within the statutory
  // deadline (distinct from the SPEC-007 re-poll, which is for `processing` rows that already
  // reached KSeF). Pick them up once the deadline is within the lookahead window or already
  // past, soonest-deadline first, so the most-urgent invoices are sent before they breach.
  const offlineLookaheadHours = readPositiveInt(
    process.env.OM_KSEF_OFFLINE_LOOKAHEAD_HOURS,
    DEFAULT_OFFLINE_LOOKAHEAD_HOURS,
  )
  const offlineHorizon = new Date(Date.now() + offlineLookaheadHours * 60 * 60_000)
  // `submittedAt` (set at the claim below) keys re-drive staleness: a freshly-claimed offline row
  // a live subscriber is still sending is excluded (only never-claimed or stale-claim rows match),
  // mirroring how `processing` rows are gated. A never-sent row has `submittedAt = null`.
  const offlineIssued = await em.find(
    KsefSubmission,
    {
      organizationId,
      tenantId,
      deletedAt: null,
      status: 'offline_issued',
      attemptCount: { $lt: maxAttempts },
      offlineSendDeadlineAt: { $lte: offlineHorizon },
      $or: [{ submittedAt: null }, { submittedAt: { $lt: cutoff } }],
    },
    { fields, limit: CANDIDATE_BATCH, orderBy: { offlineSendDeadlineAt: 'asc' } },
  )

  const now = new Date()
  let requeued = 0
  let repolled = 0
  let offlineSent = 0

  // Deferred offline INITIAL send: CAS-claim the offline-issued row (bump submitted_at/updated_at/
  // attempt_count, KEEP status `offline_issued` so the send subscriber's own offline_issued->processing
  // claim fires) and emit `send_offline`. The staleness guard (submittedAt null or `< cutoff`) makes
  // the nativeUpdate a claim — exactly one sweep re-drives a given row; the subscriber's claim
  // deduplicates and KSeF's 440 content-hash heal keeps a re-send duplicate-safe.
  for (const candidate of offlineIssued) {
    const staleGuard: FilterQuery<KsefSubmission> = { $or: [{ submittedAt: null }, { submittedAt: { $lt: cutoff } }] }
    const claimed = await em.nativeUpdate(
      KsefSubmission,
      { id: candidate.id, organizationId, tenantId, deletedAt: null, status: 'offline_issued', attemptCount: { $lt: maxAttempts }, ...staleGuard },
      { submittedAt: now, updatedAt: now, attemptCount: (candidate.attemptCount ?? 0) + 1 },
    )
    if (claimed > 0) {
      offlineSent += 1
      await emitFinancialPlEvent(
        'financial_pl.ksef_submission.send_offline',
        { submissionId: candidate.id, organizationId, tenantId },
        { persistent: true },
      )
    }
  }

  for (const candidate of [...orphanedProcessing, ...stuckQueued]) {
    const isProcessing = candidate.status === 'processing'
    const staleGuard: FilterQuery<KsefSubmission> =
      isProcessing ? { submittedAt: { $lt: cutoff } } : { updatedAt: { $lt: cutoff } }
    // A stale `processing` row that already carries BOTH references reached KSeF —
    // recover it by RE-POLLING (no re-send, the strongest no-duplicate guarantee).
    // Everything else (a true orphan with no references, or a stuck `queued` row) is
    // recovered by the duplicate-safe RE-SEND path.
    const route = isProcessing ? chooseRecovery(candidate) : 'resend'

    if (route === 'repoll') {
      // CAS-claim WITHOUT resetting status: keep `processing` and bump
      // submitted_at/updated_at/attempt_count so the row is not re-selected before
      // the repoll subscriber runs, and the breaker keeps advancing. (status/dates/
      // attempt_count are non-encrypted, so this bypasses no encryption subscriber.)
      const claimed = await em.nativeUpdate(
        KsefSubmission,
        { id: candidate.id, organizationId, tenantId, deletedAt: null, status: 'processing', attemptCount: { $lt: maxAttempts }, ...staleGuard },
        { submittedAt: now, updatedAt: now, attemptCount: (candidate.attemptCount ?? 0) + 1 },
      )
      if (claimed > 0) {
        repolled += 1
        await emitFinancialPlEvent(
          'financial_pl.ksef_submission.repoll',
          { submissionId: candidate.id, organizationId, tenantId },
          { persistent: true },
        )
      }
      continue
    }

    // RE-SEND: reset to `queued` and re-emit. The `< cutoff` guard makes the
    // nativeUpdate a claim (exactly one sweep re-drives a given row); the subscriber's
    // queued->processing claim deduplicates, and KSeF's 440 content de-duplication
    // resolves a content-identical re-send to the original number — never a double send.
    const claimed = await em.nativeUpdate(
      KsefSubmission,
      {
        id: candidate.id,
        organizationId,
        tenantId,
        deletedAt: null,
        status: candidate.status,
        attemptCount: { $lt: maxAttempts },
        ...staleGuard,
      },
      { status: 'queued', updatedAt: now, attemptCount: (candidate.attemptCount ?? 0) + 1 },
    )
    if (claimed > 0) {
      requeued += 1
      await emitFinancialPlEvent(
        'financial_pl.ksef_submission.queued',
        { submissionId: candidate.id, organizationId, tenantId },
        { persistent: true },
      )
    }
  }

  // Rows that exhausted the attempt ceiling are left untouched but surfaced so the
  // give-up is never silent: they stay visible in the submissions list (status +
  // lastErrorMessage + attemptCount) and their ids are named in the log here so an
  // operator knows exactly which invoices need manual attention.
  const gaveUpRows = await em.find(
    KsefSubmission,
    { organizationId, tenantId, deletedAt: null, status: { $in: ['queued', 'processing', 'offline_issued'] }, attemptCount: { $gte: maxAttempts } },
    { fields: ['id'], limit: CANDIDATE_BATCH },
  )

  if (requeued > 0 || repolled > 0 || offlineSent > 0 || gaveUpRows.length > 0) {
    const gaveUpIds = gaveUpRows.map((row) => row.id).join(',')
    // eslint-disable-next-line no-console
    console.warn(
      `[internal] financial_pl:ksef-reconcile org=${organizationId} requeued=${requeued} repolled=${repolled} offlineSent=${offlineSent} gaveUp=${gaveUpRows.length}${gaveUpIds ? ` ids=${gaveUpIds}` : ''}`,
    )
  }
}
