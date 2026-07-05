import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { KsefSubmission } from '../data/entities'
import { chooseRecovery } from '../lib/recovery'
import { emitFinancialPlEvent } from '../events'
import { resolveKsefEnvironment } from '../config'
import { KsefClient, type KsefPublicKeyCertificate, type KsefTransport } from '../lib/ksef-client'
import { authenticate } from '../lib/ksef-auth'
import { buildKsefAuthConfig, readKsefCredentials, type ResolverContext } from '../lib/credentials'
import { evaluateInvoiceStatus, evaluateSessionStatus } from '../lib/status'

/**
 * Periodic reconciliation sweep that recovers KSeF submissions which fell out of
 * the normal queued -> processing -> terminal flow. Recovery is ROUTED per row by
 * `chooseRecovery` (whether the send already reached KSeF):
 *  - a stale `processing` row that carries BOTH `sessionReference` and
 *    `invoiceReference` provably reached KSeF, so it is recovered by RE-POLLING:
 *    a cutoff-guarded CAS bump (attemptCount/updatedAt) that KEEPS status
 *    `processing`, then a `financial_pl.ksef_submission.repoll_requested` emit. The repoll
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

type HandlerContext = ResolverContext

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
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const AUTH_POLL = { authMaxAttempts: 20, authDelayMs: 1500, wait } as const

type JsonRecord = Record<string, unknown>

type BatchSessionInvoice = {
  salesInvoiceId?: string
  fileName?: string
  invoiceReference?: string
  ksefNumber?: string
  statusCode: number
  errorCode?: string
  errorMessage?: string
}

function readPositiveInt(envValue: string | undefined, fallback: number): number {
  const parsed = Number(envValue)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pickString(record: JsonRecord | undefined, ...keys: string[]): string | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

function pickNumber(record: JsonRecord | undefined, ...keys: string[]): number | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function selectCertificate(
  certs: KsefPublicKeyCertificate[],
  usageNeedle: string,
): KsefPublicKeyCertificate | undefined {
  const matches = certs.filter(
    (cert) =>
      cert.certificate.trim().length > 0 &&
      cert.usage.some((usage) => usage.toLowerCase().includes(usageNeedle)),
  )
  return [...matches].sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? ''))[0]
}

function resolveOptional<T>(ctx: HandlerContext, name: string): T | undefined {
  try {
    return ctx.resolve<T>(name)
  } catch {
    return undefined
  }
}

function sessionInvoiceArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!isRecord(payload)) return []
  const direct = payload.invoices ?? payload.items ?? payload.results
  if (Array.isArray(direct)) return direct
  const data = payload.data
  if (isRecord(data)) {
    const nested = data.invoices ?? data.items ?? data.results
    if (Array.isArray(nested)) return nested
  }
  return []
}

function parseBatchSessionInvoices(payload: unknown): BatchSessionInvoice[] {
  return sessionInvoiceArray(payload).flatMap((item) => {
    if (!isRecord(item)) return []
    const status = isRecord(item.status) ? item.status : undefined
    const fileName = pickString(item, 'fileName', 'filename', 'invoiceFileName', 'originalFileName')
    return [
      {
        salesInvoiceId: pickString(item, 'salesInvoiceId', 'invoiceId'),
        fileName,
        invoiceReference: pickString(item, 'invoiceReference', 'invoiceReferenceNumber', 'referenceNumber'),
        ksefNumber: pickString(item, 'ksefNumber', 'KsefNumber', 'nrKsef'),
        statusCode: pickNumber(status, 'code') ?? pickNumber(item, 'statusCode', 'code') ?? 0,
        errorCode: pickString(status, 'errorCode', 'code') ?? pickString(item, 'errorCode'),
        errorMessage:
          pickString(status, 'description', 'message', 'errorMessage') ??
          pickString(item, 'description', 'message', 'errorMessage'),
      },
    ]
  })
}

function stripXmlSuffix(fileName: string | undefined): string | undefined {
  if (!fileName) return undefined
  return fileName.endsWith('.xml') ? fileName.slice(0, -4) : fileName
}

function findMatchingInvoiceStatus(
  row: KsefSubmission,
  statuses: BatchSessionInvoice[],
  usedIndexes: Set<number>,
  rowCount: number,
): { index: number; status: BatchSessionInvoice } | null {
  const expectedFileName = `${row.salesInvoiceId}.xml`
  for (let index = 0; index < statuses.length; index += 1) {
    if (usedIndexes.has(index)) continue
    const status = statuses[index]
    if (
      status.salesInvoiceId === row.salesInvoiceId ||
      status.fileName === expectedFileName ||
      stripXmlSuffix(status.fileName) === row.salesInvoiceId ||
      (row.invoiceReference && status.invoiceReference === row.invoiceReference)
    ) {
      return { index, status }
    }
  }
  if (rowCount === 1 && statuses.length === 1 && !usedIndexes.has(0)) {
    return { index: 0, status: statuses[0] }
  }
  return null
}

function groupBatchRows(rows: KsefSubmission[]): KsefSubmission[][] {
  const groups = new Map<string, KsefSubmission[]>()
  for (const row of rows) {
    const reference = row.batchReference ?? row.sessionReference
    if (!reference) continue
    const key = `${row.environment}:${row.contextNip}:${reference}`
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  return [...groups.values()]
}

async function recordBatchRowsError(
  em: EntityManager,
  rows: KsefSubmission[],
  scope: { organizationId: string; tenantId: string },
  errorMessage: string,
  statusCode?: number,
): Promise<void> {
  if (rows.length === 0) return
  await em.nativeUpdate(
    KsefSubmission,
    { id: { $in: rows.map((row) => row.id) }, organizationId: scope.organizationId, tenantId: scope.tenantId, deletedAt: null },
    {
      lastStatusCode: statusCode ?? null,
      lastErrorMessage: errorMessage,
      updatedAt: new Date(),
    },
  )
}

async function markBatchRowRejected(
  em: EntityManager,
  row: KsefSubmission,
  scope: { organizationId: string; tenantId: string },
  statusCode: number,
  errorCode: string | undefined,
  errorMessage: string | undefined,
): Promise<boolean> {
  const submission = await findOneWithDecryption(
    em,
    KsefSubmission,
    { id: row.id, organizationId: scope.organizationId, tenantId: scope.tenantId, deletedAt: null },
    undefined,
    scope,
  )
  if (!submission || submission.status !== 'processing') return false
  submission.status = 'rejected'
  submission.lastStatusCode = statusCode
  submission.lastErrorCode = errorCode ?? 'ksef_batch_invoice_rejected'
  submission.lastErrorMessage = errorMessage ?? '[internal] KSeF batch invoice rejected'
  submission.updatedAt = new Date()
  await em.flush()
  await emitFinancialPlEvent(
    'financial_pl.ksef_submission.rejected',
    { submissionId: submission.id, organizationId: scope.organizationId, tenantId: scope.tenantId },
    { persistent: true },
  )
  return true
}

async function markBatchRowAccepted(
  em: EntityManager,
  row: KsefSubmission,
  scope: { organizationId: string; tenantId: string },
  ksefNumber: string,
  upoXml: string,
  statusCode: number,
): Promise<boolean> {
  const submission = await findOneWithDecryption(
    em,
    KsefSubmission,
    { id: row.id, organizationId: scope.organizationId, tenantId: scope.tenantId, deletedAt: null },
    undefined,
    scope,
  )
  if (!submission || submission.status !== 'processing') return false
  submission.status = 'accepted'
  submission.ksefNumber = ksefNumber
  submission.upoXml = upoXml
  submission.lastStatusCode = statusCode
  submission.lastErrorCode = null
  submission.lastErrorMessage = null
  submission.acceptedAt = new Date()
  submission.updatedAt = new Date()
  await em.flush()
  await emitFinancialPlEvent(
    'financial_pl.ksef_submission.accepted',
    { submissionId: submission.id, organizationId: scope.organizationId, tenantId: scope.tenantId, ksefNumber },
    { persistent: true },
  )
  return true
}

async function reconcileBatchGroup(args: {
  em: EntityManager
  ctx: HandlerContext
  rows: KsefSubmission[]
  organizationId: string
  tenantId: string
  cutoff: Date
  maxAttempts: number
  now: Date
}): Promise<{ accepted: number; rejected: number }> {
  const { em, ctx, rows, organizationId, tenantId, cutoff, maxAttempts, now } = args
  const scope = { organizationId, tenantId }
  const claimedRows: KsefSubmission[] = []
  for (const row of rows) {
    const claimed = await em.nativeUpdate(
      KsefSubmission,
      {
        id: row.id,
        organizationId,
        tenantId,
        deletedAt: null,
        status: 'processing',
        mode: 'batch',
        batchReference: row.batchReference,
        submittedAt: { $lt: cutoff },
        attemptCount: { $lt: maxAttempts },
      },
      { submittedAt: now, updatedAt: now, attemptCount: (row.attemptCount ?? 0) + 1 },
    )
    if (claimed > 0) claimedRows.push(row)
  }
  if (claimedRows.length === 0) return { accepted: 0, rejected: 0 }

  const first = claimedRows[0]
  const referenceNumber = first.batchReference ?? first.sessionReference
  if (!referenceNumber || !first.contextNip) {
    await recordBatchRowsError(em, claimedRows, scope, '[internal] KSeF batch row is missing its session reference or context NIP')
    return { accepted: 0, rejected: 0 }
  }

  try {
    const creds = await readKsefCredentials(ctx, scope)
    const auth = buildKsefAuthConfig(creds, first.contextNip)
    if (!auth) {
      await recordBatchRowsError(em, claimedRows, scope, '[internal] KSeF credentials are not configured for batch reconcile')
      return { accepted: 0, rejected: 0 }
    }
    const client = new KsefClient(
      resolveKsefEnvironment(creds.environment ?? first.environment),
      resolveOptional<KsefTransport>(ctx, 'ksefTransport'),
    )
    const certs = await client.getPublicKeyCertificates()
    const authResult = await authenticate(client, selectCertificate(certs, 'token'), auth, AUTH_POLL)
    if (!authResult.ok) {
      await recordBatchRowsError(em, claimedRows, scope, authResult.errorMessage ?? '[internal] KSeF batch reconcile auth failed')
      return { accepted: 0, rejected: 0 }
    }

    const sessionStatus = await client.getSessionStatus({ accessToken: authResult.accessToken, sessionReference: referenceNumber })
    const sessionEvaluation = evaluateSessionStatus(sessionStatus.code)
    if (sessionEvaluation.status === 'processing') {
      await recordBatchRowsError(
        em,
        claimedRows,
        scope,
        sessionStatus.description ?? '[internal] KSeF batch session is still processing',
        sessionStatus.code,
      )
      return { accepted: 0, rejected: 0 }
    }
    if (sessionEvaluation.status === 'rejected') {
      let rejected = 0
      for (const row of claimedRows) {
        if (await markBatchRowRejected(em, row, scope, sessionStatus.code, 'ksef_batch_session_rejected', sessionStatus.description)) {
          rejected += 1
        }
      }
      return { accepted: 0, rejected }
    }

    const statuses = parseBatchSessionInvoices(
      await client.getSessionInvoices({ accessToken: authResult.accessToken, referenceNumber }),
    )
    const usedIndexes = new Set<number>()
    let accepted = 0
    let rejected = 0
    for (const row of claimedRows) {
      const match = findMatchingInvoiceStatus(row, statuses, usedIndexes, claimedRows.length)
      if (!match) {
        await recordBatchRowsError(em, [row], scope, '[internal] KSeF batch session did not return a matching invoice status')
        continue
      }
      usedIndexes.add(match.index)
      const invoiceEvaluation = evaluateInvoiceStatus(match.status.statusCode)
      if (invoiceEvaluation.status === 'processing') continue
      if (invoiceEvaluation.status === 'rejected') {
        if (
          await markBatchRowRejected(
            em,
            row,
            scope,
            match.status.statusCode,
            match.status.errorCode,
            match.status.errorMessage,
          )
        ) {
          rejected += 1
        }
        continue
      }
      if (!match.status.ksefNumber) {
        await recordBatchRowsError(
          em,
          [row],
          scope,
          '[internal] KSeF batch invoice was accepted without a KSeF number',
          match.status.statusCode,
        )
        continue
      }
      try {
        const upoXml = await client.getInvoiceUpoByKsefNumber({
          accessToken: authResult.accessToken,
          sessionReference: referenceNumber,
          ksefNumber: match.status.ksefNumber,
        })
        if (await markBatchRowAccepted(em, row, scope, match.status.ksefNumber, upoXml, match.status.statusCode)) {
          accepted += 1
        }
      } catch (err) {
        await recordBatchRowsError(
          em,
          [row],
          scope,
          err instanceof Error ? `[internal] KSeF batch UPO fetch failed: ${err.message}` : '[internal] KSeF batch UPO fetch failed',
          match.status.statusCode,
        )
      }
    }
    return { accepted, rejected }
  } catch (err) {
    await recordBatchRowsError(
      em,
      claimedRows,
      scope,
      err instanceof Error ? `[internal] KSeF batch reconcile failed: ${err.message}` : '[internal] KSeF batch reconcile failed',
    )
    return { accepted: 0, rejected: 0 }
  }
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
    'mode',
    'sessionReference',
    'batchReference',
    'invoiceReference',
    'contextNip',
    'environment',
    'salesInvoiceId',
    'offlineSendDeadlineAt',
  ] as const

  // Orphaned `processing` rows are keyed on `submittedAt` (set at the CAS claim),
  // so a freshly-claimed row a live worker is still processing is excluded — only
  // claims older than the staleness window match. `queued` rows are keyed on
  // `updatedAt`; re-emitting one is always safe because the subscriber claim
  // deduplicates. Over-ceiling rows are excluded from the candidate set so they
  // can never starve recoverable rows out of the bounded batch.
  const scope = { organizationId, tenantId }
  const orphanedProcessing = await findWithDecryption(
    em,
    KsefSubmission,
    { organizationId, tenantId, deletedAt: null, status: 'processing', attemptCount: { $lt: maxAttempts }, submittedAt: { $lt: cutoff } },
    { fields, limit: CANDIDATE_BATCH },
    scope,
  )
  const stuckQueued = await findWithDecryption(
    em,
    KsefSubmission,
    { organizationId, tenantId, deletedAt: null, status: 'queued', attemptCount: { $lt: maxAttempts }, updatedAt: { $lt: cutoff } },
    { fields, limit: CANDIDATE_BATCH },
    scope,
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
  const offlineIssued = await findWithDecryption(
    em,
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
    scope,
  )

  const now = new Date()
  let requeued = 0
  let repolled = 0
  let offlineSent = 0
  let batchAccepted = 0
  let batchRejected = 0

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
        'financial_pl.ksef_submission.offline_send_requested',
        { submissionId: candidate.id, organizationId, tenantId },
        { persistent: true },
      )
    }
  }

  const batchProcessing = orphanedProcessing.filter((candidate) => candidate.mode === 'batch' && Boolean(candidate.batchReference))
  const batchProcessingIds = new Set(batchProcessing.map((candidate) => candidate.id))
  // `orphanedProcessing` is field-projected (em.find `{ fields }`), so its element type is a partial
  // `Loaded<KsefSubmission, …>` not the full entity. The batch reconcile only READS the projected
  // fields and WRITES via `em.nativeUpdate` (never mutates the entity instance), so these are
  // runtime-correct managed rows — widen the static type to the entity for grouping/reconcile.
  const batchRows = batchProcessing as unknown as KsefSubmission[]
  for (const group of groupBatchRows(batchRows)) {
    const result = await reconcileBatchGroup({ em, ctx, rows: group, organizationId, tenantId, cutoff, maxAttempts, now })
    batchAccepted += result.accepted
    batchRejected += result.rejected
  }

  for (const candidate of [...orphanedProcessing, ...stuckQueued]) {
    if (batchProcessingIds.has(candidate.id)) continue
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
          'financial_pl.ksef_submission.repoll_requested',
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
  const gaveUpRows = await findWithDecryption(
    em,
    KsefSubmission,
    { organizationId, tenantId, deletedAt: null, status: { $in: ['queued', 'processing', 'offline_issued'] }, attemptCount: { $gte: maxAttempts } },
    { fields: ['id'], limit: CANDIDATE_BATCH },
    scope,
  )

  if (requeued > 0 || repolled > 0 || offlineSent > 0 || batchAccepted > 0 || batchRejected > 0 || gaveUpRows.length > 0) {
    const gaveUpIds = gaveUpRows.map((row) => row.id).join(',')
    // eslint-disable-next-line no-console
    console.warn(
      `[internal] financial_pl:ksef-reconcile org=${organizationId} requeued=${requeued} repolled=${repolled} offlineSent=${offlineSent} batchAccepted=${batchAccepted} batchRejected=${batchRejected} gaveUp=${gaveUpRows.length}${gaveUpIds ? ` ids=${gaveUpIds}` : ''}`,
    )
  }
}
