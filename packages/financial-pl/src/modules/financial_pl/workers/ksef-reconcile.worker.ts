import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { KsefSubmission } from '../data/entities'
import { emitFinancialPlEvent } from '../events'

/**
 * Periodic reconciliation sweep that recovers KSeF submissions which fell out of
 * the normal queued -> processing -> terminal flow without reaching KSeF:
 *  - `processing` rows orphaned by a worker crash AFTER the queued->processing
 *    CAS claim but BEFORE the terminal flush (so no session/invoice reference was
 *    ever persisted — the flow is one-shot and cannot be re-polled), and
 *  - `queued` rows whose dispatch event was lost (the send command flushes the
 *    row, then emits the event as a separate step).
 *
 * Recovery is a duplicate-safe re-drive: reset to `queued` and re-emit
 * `financial_pl.ksef_submission.queued`. The subscriber's atomic claim guarantees
 * single execution, and KSeF's native 440-duplicate detection resolves any
 * content-identical re-send to `accepted` with the original KSeF number + UPO, so
 * an invoice is never registered twice.
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
  // reconciler never needs them.
  const fields = ['id', 'status', 'attemptCount', 'submittedAt', 'updatedAt'] as const

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

  const now = new Date()
  let requeued = 0
  for (const candidate of [...orphanedProcessing, ...stuckQueued]) {
    const staleGuard: FilterQuery<KsefSubmission> =
      candidate.status === 'processing' ? { submittedAt: { $lt: cutoff } } : { updatedAt: { $lt: cutoff } }
    // CAS re-drive: status/updated_at/submitted_at/attempt_count are non-encrypted,
    // so this nativeUpdate safely bypasses the encryption subscriber (like the
    // ksef-submit subscriber's own reset). The `< cutoff` guard makes it a claim:
    // exactly one sweep run re-drives a given row. Incrementing attempt_count here
    // keeps the circuit breaker advancing even when a crash skipped the
    // subscriber's own increment.
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
    { organizationId, tenantId, deletedAt: null, status: { $in: ['queued', 'processing'] }, attemptCount: { $gte: maxAttempts } },
    { fields: ['id'], limit: CANDIDATE_BATCH },
  )

  if (requeued > 0 || gaveUpRows.length > 0) {
    const gaveUpIds = gaveUpRows.map((row) => row.id).join(',')
    // eslint-disable-next-line no-console
    console.warn(
      `[internal] financial_pl:ksef-reconcile org=${organizationId} requeued=${requeued} gaveUp=${gaveUpRows.length}${gaveUpIds ? ` ids=${gaveUpIds}` : ''}`,
    )
  }
}
