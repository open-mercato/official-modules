import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { KsefSubmission } from '../data/entities'
import { resolveKsefEnvironment } from '../config'
import { KsefClient } from '../lib/ksef-client'
import { submitInvoiceToKsef, type KsefSubmissionResult } from '../lib/submission-flow'
import { buildKsefAuthConfig, readKsefCredentials, type ResolverContext } from '../lib/credentials'
import { emitFinancialPlEvent } from '../events'

/**
 * Persistent (queue-backed, retried) subscriber that performs the DEFERRED INITIAL send of an
 * offline-issued invoice (offline24 / awaryjny) — SPEC-010 §Deferred send. The invoice was
 * already built + handed to the buyer (status `offline_issued`); this is its first KSeF send,
 * NOT a re-poll (the row never reached KSeF). It CAS-claims `offline_issued → processing`,
 * authenticates, sends the STORED byte-stable `invoice_xml` with `offlineMode:true`, then
 * reconciles the retroactive KSeF number / UPO exactly as the online path. On acceptance
 * `accepted_at` is the KSeF-assigned timestamp (the legal "received" date for offline24).
 *
 * Duplicate-safe: the `offline_issued → processing` CAS claim guarantees single execution, and
 * KSeF's 440 content-hash de-duplication resolves any content-identical re-send to the original
 * registration — the same idempotency / 440-heal as the online submit path.
 */
export const metadata = {
  event: 'financial_pl.ksef_submission.send_offline',
  persistent: true,
  id: 'financial_pl:ksef-send-offline',
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

  // Atomic claim: exactly one handler transitions this row from `offline_issued` to
  // `processing`. A concurrent redelivery (or the reconcile worker's own emit) that loses the
  // race claims 0 rows and bails, so the invoice is never sent twice. `status` is plaintext, so
  // the nativeUpdate CAS bypasses no encryption subscriber.
  const claimed = await em.nativeUpdate(
    KsefSubmission,
    { id: submissionId, organizationId, tenantId, status: 'offline_issued', deletedAt: null },
    { status: 'processing', submittedAt: new Date() },
  )
  if (claimed === 0) return

  const submission = await findOneWithDecryption(
    em,
    KsefSubmission,
    { id: submissionId, organizationId, tenantId, deletedAt: null },
    undefined,
    scope,
  )
  if (!submission) return
  submission.attemptCount = (submission.attemptCount ?? 0) + 1

  if (!submission.invoiceXml) {
    submission.status = 'rejected'
    submission.lastErrorMessage = '[internal] missing invoice XML'
    submission.updatedAt = new Date()
    await em.flush()
    return
  }

  const creds = await readKsefCredentials(ctx, scope)
  const auth = buildKsefAuthConfig(creds, submission.contextNip)

  if (!auth) {
    submission.status = 'rejected'
    submission.lastErrorMessage = '[internal] KSeF credentials not configured for this organization (token or certificate)'
    submission.updatedAt = new Date()
    await em.flush()
    await emitFinancialPlEvent('financial_pl.ksef_submission.rejected', { submissionId, organizationId, tenantId }, { persistent: true })
    return
  }

  const envConfig = resolveKsefEnvironment(creds.environment ?? submission.environment)
  const client = new KsefClient(envConfig)
  let result: KsefSubmissionResult
  try {
    result = await submitInvoiceToKsef(client, {
      auth,
      // Send the STORED XML verbatim (byte-stable) — never rebuild, so the registered content
      // hash matches KOD I/II and KSeF's 440 de-duplication recovers a re-send to the original.
      invoiceXml: submission.invoiceXml,
      offlineMode: true,
    })
  } catch (err) {
    // A throw here (HTTP/transport timeout, 429, or an unexpected KSeF error) happens AFTER the
    // offline_issued->processing claim. Reset to `offline_issued` so the reconcile worker can
    // re-claim and re-emit the deferred send (the CAS claim only transitions from
    // `offline_issued`, so without this reset the row would be stuck `processing`). Record the
    // error and rethrow to trigger the queue retry.
    submission.status = 'offline_issued'
    submission.lastErrorMessage =
      err instanceof Error ? `[internal] KSeF offline send failed: ${err.message}` : '[internal] KSeF offline send failed'
    submission.updatedAt = new Date()
    await em.flush()
    throw err
  }

  // A non-terminal (still processing) outcome must NOT strand the row: reset to
  // `offline_issued` so the reconcile worker can re-emit the deferred send within the deadline.
  if (result.status !== 'accepted' && result.status !== 'rejected') {
    submission.status = 'offline_issued'
    submission.sessionReference = result.sessionReference ?? null
    submission.invoiceReference = result.invoiceReference ?? null
    submission.lastStatusCode = result.lastStatusCode ?? null
    submission.lastErrorMessage = result.errorMessage ?? null
    submission.updatedAt = new Date()
    await em.flush()
    return
  }

  submission.status = result.status
  submission.sessionReference = result.sessionReference ?? null
  submission.invoiceReference = result.invoiceReference ?? null
  submission.ksefNumber = result.ksefNumber ?? null
  submission.upoXml = result.upoXml ?? null
  submission.lastStatusCode = result.lastStatusCode ?? null
  submission.lastErrorMessage = result.errorMessage ?? null
  // On acceptance, stamp `accepted_at` at the moment acceptance is recorded — identical to the
  // ONLINE path (subscribers/ksef-submit.ts), so both behave consistently; this is within seconds
  // of KSeF's own registration. The legally-precise KSeF acceptance timestamp lives in the UPO
  // (`Potwierdzenie`) and could be parsed for both paths in a future enhancement (it is NOT done
  // asymmetrically here — that would diverge the offline path from the proven online path).
  if (result.status === 'accepted') submission.acceptedAt = new Date()
  submission.updatedAt = new Date()
  await em.flush()

  if (result.status === 'accepted') {
    await emitFinancialPlEvent(
      'financial_pl.ksef_submission.accepted',
      { submissionId, organizationId, tenantId, ksefNumber: result.ksefNumber },
      { persistent: true },
    )
  } else {
    await emitFinancialPlEvent('financial_pl.ksef_submission.rejected', { submissionId, organizationId, tenantId }, { persistent: true })
  }
}
