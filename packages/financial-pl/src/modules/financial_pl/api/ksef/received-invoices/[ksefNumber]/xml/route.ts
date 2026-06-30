import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { ReceivedInvoice } from '../../../../../data/entities'
import { resolveKsefEnvironment } from '../../../../../config'
import {
  KsefClient,
  type KsefPublicKeyCertificate,
} from '../../../../../lib/ksef-client'
import { authenticate } from '../../../../../lib/ksef-auth'
import {
  buildKsefAuthConfig,
  readKsefCredentials,
  type ResolverContext,
} from '../../../../../lib/credentials'

type RouteProps = { params: { ksefNumber?: string } }
type RequestContainer = { resolve: <T = unknown>(name: string) => T }
type CredentialsService = {
  getRaw: (
    integrationId: string,
    scope: { organizationId: string; tenantId: string },
  ) => Promise<Record<string, unknown> | null>
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const AUTH_POLL = { authMaxAttempts: 20, authDelayMs: 1500, wait } as const
const paramSchema = z.object({ ksefNumber: z.string().min(1) })

function credString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function selectTokenCertificate(certs: KsefPublicKeyCertificate[]): KsefPublicKeyCertificate | undefined {
  const matches = certs.filter((cert) => cert.usage.some((usage) => usage.toLowerCase().includes('token')))
  return [...matches].sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? ''))[0]
}

function containerResolver(container: RequestContainer): ResolverContext {
  return {
    resolve: <T = unknown>(name: string): T => container.resolve(name),
  }
}

async function readContextNip(
  container: RequestContainer,
  scope: { organizationId: string; tenantId: string },
): Promise<{ contextNip?: string; environment?: string }> {
  try {
    const service = container.resolve<CredentialsService>('integrationCredentialsService')
    const creds = await service.getRaw('ksef_pl', scope)
    if (!creds) return {}
    const nipDigits = typeof creds.contextNip === 'string' ? creds.contextNip.replace(/[^0-9]/g, '') : ''
    return {
      contextNip: /^[0-9]{10}$/.test(nipDigits) ? nipDigits : undefined,
      environment: credString(creds.environment),
    }
  } catch {
    return {}
  }
}

async function authenticateKsef(
  container: RequestContainer,
  scope: { organizationId: string; tenantId: string },
  preferredContextNip?: string | null,
): Promise<{ client: KsefClient; accessToken: string }> {
  const details = await readContextNip(container, scope)
  const creds = await readKsefCredentials(containerResolver(container), scope)
  const contextNip = preferredContextNip ?? details.contextNip
  if (!contextNip) {
    throw new CrudHttpError(409, {
      error: '[internal] KSeF credentials are not configured for this organization.',
      code: 'ksef_credentials_missing',
    })
  }
  const auth = buildKsefAuthConfig(creds, contextNip)
  if (!auth) {
    throw new CrudHttpError(409, {
      error: '[internal] KSeF credentials are not configured for this organization (token or certificate).',
      code: 'ksef_auth_missing',
    })
  }

  const client = new KsefClient(resolveKsefEnvironment(creds.environment ?? details.environment))
  const result = await authenticate(client, selectTokenCertificate(await client.getPublicKeyCertificates()), auth, AUTH_POLL)
  if (!result.ok) throw new CrudHttpError(502, { error: result.errorMessage, code: 'ksef_auth_failed' })
  return { client, accessToken: result.accessToken }
}

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['financial_pl.view'] },
}

export async function GET(req: Request, props: RouteProps) {
  try {
    const parsed = paramSchema.parse({ ksefNumber: props.params.ksefNumber })
    const container = await createRequestContainer()
    const auth = await getAuthFromRequest(req)
    if (!auth || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const orgIds = scope ? scope.filterIds : auth.orgId ? [auth.orgId] : null
    if (Array.isArray(orgIds) && orgIds.length === 0) {
      throw new CrudHttpError(404, { error: '[internal] received invoice not found' })
    }

    const filter: FilterQuery<ReceivedInvoice> = {
      tenantId: auth.tenantId,
      ksefNumber: parsed.ksefNumber,
      deletedAt: null,
    }
    if (Array.isArray(orgIds) && orgIds.length > 0) filter.organizationId = { $in: orgIds }

    const em = (container.resolve('em') as EntityManager).fork()
    const invoice = await findOneWithDecryption(
      em,
      ReceivedInvoice,
      filter,
      undefined,
      { tenantId: auth.tenantId, organizationId: auth.orgId ?? null },
    )
    if (!invoice) throw new CrudHttpError(404, { error: '[internal] received invoice not found' })

    let xml = invoice.fa3Xml ?? null
    if (!xml) {
      const live = await authenticateKsef(
        container,
        { organizationId: invoice.organizationId, tenantId: invoice.tenantId },
        invoice.contextNip ?? null,
      )
      xml = await live.client.downloadInvoiceByKsefNumber({
        accessToken: live.accessToken,
        ksefNumber: invoice.ksefNumber,
      })
      invoice.fa3Xml = xml
      invoice.fetchedAt = new Date()
      await em.flush()
    }

    return new NextResponse(xml, {
      status: 200,
      headers: {
        'content-type': 'application/xml; charset=utf-8',
        'content-disposition': `attachment; filename="ksef-${invoice.ksefNumber}.xml"`,
      },
    })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    if (err instanceof z.ZodError) return NextResponse.json({ error: 'Validation failed', details: err.issues }, { status: 400 })
    console.error('[internal] financial_pl.ksef received-invoice XML failed', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const xmlResponseSchema = z.string()
const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Polish Financials (KSeF)',
  summary: 'Download received KSeF invoice XML',
  methods: {
    GET: {
      summary: 'Download received invoice FA(3) XML',
      description:
        'Returns the stored FA(3) XML for a received invoice, or fetches it live from KSeF when the row has metadata only.',
      responses: [{ status: 200, description: 'FA(3) XML', schema: xmlResponseSchema }],
      errors: [{ status: 404, description: 'Received invoice not found', schema: errorSchema }],
    },
  },
}
