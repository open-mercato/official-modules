import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { KsefSubmission, type KsefEnvironmentColumn } from '../data/entities'
import { resolveKsefEnvironment } from '../config'
import { KsefClient } from '../lib/ksef-client'
import { submitInvoiceToKsef, type KsefSubmissionResult } from '../lib/submission-flow'
import { emitFinancialPlEvent } from '../events'

/**
 * Persistent (queue-backed, retried) subscriber that performs the actual KSeF
 * submission off the request thread: read encrypted credentials, run the
 * full auth -> send -> status -> UPO flow, and persist the outcome idempotently.
 */
export const metadata = {
  event: 'financial_pl.ksef_submission.queued',
  persistent: true,
  id: 'financial_pl:ksef-submit',
}

type Payload = {
  submissionId: string
  organizationId: string
  tenantId: string
}

type ResolverContext = {
  resolve: <T = unknown>(name: string) => T
}

type CredentialsService = {
  getRaw: (
    integrationId: string,
    scope: { organizationId: string; tenantId: string },
  ) => Promise<Record<string, unknown> | null>
}

async function readKsefCredentials(
  ctx: ResolverContext,
  scope: { organizationId: string; tenantId: string },
): Promise<{ token?: string; environment?: KsefEnvironmentColumn }> {
  try {
    const service = ctx.resolve<CredentialsService>('integrationCredentialsService')
    const creds = await service.getRaw('ksef_pl', scope)
    if (!creds) return {}
    const token = typeof creds.ksefToken === 'string' ? creds.ksefToken : undefined
    const environment =
      creds.environment === 'test' || creds.environment === 'demo' || creds.environment === 'prod'
        ? (creds.environment as KsefEnvironmentColumn)
        : undefined
    return { token, environment }
  } catch {
    return {}
  }
}

export default async function handler(payload: Payload, ctx: ResolverContext): Promise<void> {
  const { submissionId, organizationId, tenantId } = payload
  const scope = { organizationId, tenantId }
  const em = (ctx.resolve('em') as EntityManager).fork()

  // Atomic claim: exactly one handler may transition this submission from
  // `queued` to `processing`. A concurrent at-least-once redelivery that loses
  // the race claims 0 rows and bails, so the invoice is never sent twice; an
  // already-terminal (accepted/rejected) or in-flight (processing) submission
  // likewise fails the claim. `status` is not an encrypted column, so the
  // nativeUpdate CAS bypasses no encryption subscriber.
  const claimed = await em.nativeUpdate(
    KsefSubmission,
    { id: submissionId, organizationId, tenantId, status: 'queued', deletedAt: null },
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

  if (!creds.token) {
    submission.status = 'rejected'
    submission.lastErrorMessage = '[internal] KSeF credentials (ksefToken) not configured for this organization'
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
      ksefToken: creds.token,
      contextNip: submission.contextNip,
      invoiceXml: submission.invoiceXml,
    })
  } catch (err) {
    // A throw here (HTTP/transport timeout, 429, or an unexpected KSeF error)
    // happens AFTER the queued->processing claim. Reset to `queued` so the queue's
    // retry can re-claim and re-send (backoff) — the CAS claim only transitions
    // from `queued`, so without this reset the row would be stuck `processing` and
    // never retried. Record the error and rethrow to trigger the queue retry.
    submission.status = 'queued'
    submission.lastErrorMessage =
      err instanceof Error ? `[internal] KSeF send failed: ${err.message}` : '[internal] KSeF send failed'
    submission.updatedAt = new Date()
    await em.flush()
    throw err
  }

  submission.status = result.status
  submission.sessionReference = result.sessionReference ?? null
  submission.invoiceReference = result.invoiceReference ?? null
  submission.ksefNumber = result.ksefNumber ?? null
  submission.upoXml = result.upoXml ?? null
  submission.lastStatusCode = result.lastStatusCode ?? null
  submission.lastErrorMessage = result.errorMessage ?? null
  if (result.status === 'accepted') submission.acceptedAt = new Date()
  submission.updatedAt = new Date()
  await em.flush()

  if (result.status === 'accepted') {
    await emitFinancialPlEvent(
      'financial_pl.ksef_submission.accepted',
      { submissionId, organizationId, tenantId, ksefNumber: result.ksefNumber },
      { persistent: true },
    )
  } else if (result.status === 'rejected') {
    await emitFinancialPlEvent('financial_pl.ksef_submission.rejected', { submissionId, organizationId, tenantId }, { persistent: true })
  }
}
