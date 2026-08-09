import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { NextResponse } from 'next/server'
import '../../../config/registry'
import { renderPdfToBuffer, pdfResponse } from '../../../lib/render-pdf'
import { templateRegistry } from '../../../lib/template-registry'
import { GenerationHistoryService } from '../../../services'
import { generateSchema } from '../../../data/validators'
import { parseJsonBody, requireOrganization } from '../../_shared/http'

export const metadata = {
  path: '/pdf-generators/generate',
  POST: { requireAuth: true, requireFeatures: ['pdf_generators.generate'] },
}

function findTemplateLabel(templateId: string): string {
  const { internal, external } = templateRegistry.listTemplates()
  return [...internal, ...external].find((t) => t.id === templateId)?.label ?? templateId
}

/**
 * Generates a PDF document with full side effects — logging, events, Phase 5 history.
 * For preview-only rendering without side effects use /preview.
 *
 * @param request - `{ template_id, data, resource_kind?, resource_id? }`
 * @returns PDF binary stream
 */
export async function POST(request: Request) {
  const container = await createRequestContainer()
  const auth = await getAuthFromRequest(request)

  const body = await parseJsonBody(request)
  if (!body.ok) return body.response

  const parsed = generateSchema.safeParse(body.value)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Missing template_id or data' }, { status: 400 })
  }
  const { template_id, data, resource_kind, resource_id } = parsed.data

  const org = requireOrganization(auth)
  if (!org.ok) return org.response

  let rendered: { buffer: Uint8Array; filename: string; resourceLabel?: string }
  try {
    rendered = await renderPdfToBuffer({ template_id, data }, { container, auth })
  } catch (err) {
    console.error('[generate] load failed:', err)
    return NextResponse.json({ error: `Unknown template: ${template_id}` }, { status: 400 })
  }

  // Best-effort history record — the source resource only needs kind + id.
  // The human label is derived server-side (e.g. order number), falling back to
  // the id. A persistence failure must not block the download.
  if (resource_kind && resource_id) {
    const em = container.resolve('em') as EntityManager
    const history = new GenerationHistoryService(em)
    try {
      await history.create({
        scope: org.value,
        templateId: template_id,
        templateLabel: findTemplateLabel(template_id),
        resourceKind: resource_kind,
        resourceId: resource_id,
        resourceLabel: rendered.resourceLabel ?? resource_id,
        generatedBy: auth!.userId ?? auth!.sub,
      })
    } catch (err) {
      console.error('[generation-history] failed to persist history record:', err)
    }
  }

  return pdfResponse(rendered.buffer, rendered.filename)
}

export const openApi: OpenApiRouteDoc = {
  methods: {
    POST: {
      summary: 'Generate PDF document with full side effects',
      responses: [
        { status: 200, description: 'PDF file stream' },
        { status: 400, description: 'Missing or invalid template_id / data' },
        { status: 401, description: 'Unauthorized' },
        { status: 409, description: 'No active organization (organization_required)' },
      ],
    },
  },
}
