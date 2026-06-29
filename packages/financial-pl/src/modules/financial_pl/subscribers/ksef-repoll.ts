import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { KsefSubmission } from '../data/entities'
import { resolveKsefEnvironment } from '../config'
import { KsefClient } from '../lib/ksef-client'
import { repollSubmission, type KsefSubmissionResult } from '../lib/submission-flow'
import { buildKsefAuthConfig, readKsefCredentials, type ResolverContext } from '../lib/credentials'
import { emitFinancialPlEvent } from '../events'

/**
 * Persistent (queue-backed, retried) subscriber that RE-POLLS a KSeF submission
 * which already reached KSeF — its `sessionReference` + `invoiceReference` were
 * persisted — instead of re-sending it. Re-polling is read-only on the KSeF side,
 * so it is the strongest no-duplicate recovery: it asks KSeF for the invoice
 * status/UPO and finalizes the outcome.
 *
 * Fallback (no stranded rows): if KSeF has no record of the reference
 * (`result.notFound`) or the status stays non-terminal, the handler does NOT mark
 * the row terminal — it resets the row to `queued` and re-emits
 * `financial_pl.ksef_submission.queued` so the proven duplicate-safe re-send
 * (440-heal) recovers it. Resetting to `queued` is required so the submit
 * subscriber's `queued->processing` CAS claim can fire (matching how the reconcile
 * worker re-drives a row). A thrown transport error rethrows for the queue retry.
 *
 * Idempotent: the status poll is read-only KSeF-side; the finalize writes
 * (accepted/UPO) converge — two concurrent re-polls land on the same result.
 */
export const metadata = {
  event: 'financial_pl.ksef_submission.repoll',
  persistent: true,
  id: 'financial_pl:ksef-repoll',
}

type Payload = {
  submissionId: string
  organizationId: string
  tenantId: string
}

export default async function handler(payload: Payload, ctx: ResolverContext): Promise<void> {
  const { submissionId, organizationId, tenantId } = payload
  const scope = { organizationId, tenantId }
  const em = (ctx.resolve('em') as EntityManager).fork()

  const submission = await findOneWithDecryption(
    em,
    KsefSubmission,
    { id: submissionId, organizationId, tenantId, deletedAt: null },
    undefined,
    scope,
  )
  if (!submission) return

  // Only a `processing` row that already carries BOTH references can be re-polled.
  // Anything else (terminal, queued, or a true orphan with no references) is not
  // ours to recover here — return without touching the row.
  if (submission.status !== 'processing' || !submission.sessionReference || !submission.invoiceReference) {
    return
  }

  const creds = await readKsefCredentials(ctx, scope)
  const auth = buildKsefAuthConfig(creds, submission.contextNip)

  if (!auth) {
    // Missing credentials: hand off to the submit path so it reports the
    // missing-creds rejection in one place (this handler never sends). Reset to
    // `queued` FIRST — the submit subscriber's CAS claim fires only from `queued`,
    // so without the reset the re-emitted event would claim 0 rows and the
    // rejection would only surface after the breaker exhausts.
    submission.status = 'queued'
    submission.updatedAt = new Date()
    await em.flush()
    await emitFinancialPlEvent(
      'financial_pl.ksef_submission.queued',
      { submissionId, organizationId, tenantId },
      { persistent: true },
    )
    return
  }

  const envConfig = resolveKsefEnvironment(creds.environment ?? submission.environment)
  const client = new KsefClient(envConfig)

  let result: KsefSubmissionResult
  try {
    result = await repollSubmission(client, auth, {
      sessionReference: submission.sessionReference,
      invoiceReference: submission.invoiceReference,
    })
  } catch (err) {
    // Transient HTTP/transport error during the read-only poll. Record it and
    // rethrow so the queue retries (no terminal write — the row stays
    // `processing` and remains eligible for a later re-poll). Re-polling is
    // read-only, so a retry cannot duplicate a send.
    submission.lastErrorMessage =
      err instanceof Error ? `[internal] KSeF repoll failed: ${err.message}` : '[internal] KSeF repoll failed'
    submission.updatedAt = new Date()
    await em.flush()
    throw err
  }

  if (result.status === 'accepted') {
    submission.status = 'accepted'
    submission.ksefNumber = result.ksefNumber ?? null
    submission.upoXml = result.upoXml ?? null
    submission.lastStatusCode = result.lastStatusCode ?? null
    submission.lastErrorMessage = null
    submission.acceptedAt = new Date()
    submission.updatedAt = new Date()
    await em.flush()
    await emitFinancialPlEvent(
      'financial_pl.ksef_submission.accepted',
      { submissionId, organizationId, tenantId, ksefNumber: result.ksefNumber },
      { persistent: true },
    )
    return
  }

  if (result.status === 'rejected') {
    submission.status = 'rejected'
    submission.lastStatusCode = result.lastStatusCode ?? null
    submission.lastErrorMessage = result.errorMessage ?? null
    submission.updatedAt = new Date()
    await em.flush()
    await emitFinancialPlEvent(
      'financial_pl.ksef_submission.rejected',
      { submissionId, organizationId, tenantId },
      { persistent: true },
    )
    return
  }

  // Non-terminal (still processing) OR `notFound` (KSeF has no record of the
  // reference). Do NOT strand the row: reset to `queued` (so the submit
  // subscriber's CAS claim from `queued` can fire) and re-emit `queued` so the
  // proven duplicate-safe re-send (440-heal) recovers it. The reconcile breaker
  // (attemptCount/maxAttempts) bounds the total recovery attempts across paths.
  submission.status = 'queued'
  submission.lastStatusCode = result.lastStatusCode ?? null
  submission.lastErrorMessage = result.errorMessage ?? '[internal] KSeF repoll non-terminal; will re-send'
  submission.updatedAt = new Date()
  await em.flush()
  await emitFinancialPlEvent(
    'financial_pl.ksef_submission.queued',
    { submissionId, organizationId, tenantId },
    { persistent: true },
  )
}
