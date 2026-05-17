import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { NextResponse } from 'next/server'
import '../../../config/registry'
import { renderPdf } from '../../../lib/render-pdf'
import type { TemplateId } from '../../../lib/types'

export const metadata = {
  path: '/pdf-generators/generate',
  POST: { requireAuth: true, requireFeatures: ['pdf_generators.view'] },
}

/**
 * Generates a PDF document with full side effects — logging, events, future persistence.
 * For preview-only rendering without side effects use /preview.
 *
 * @param request - `{ template_id, data, resource_kind?, resource_id?, resource_label? }`
 * @returns PDF binary stream
 */
export async function POST(request: Request) {
  const container = await createRequestContainer()

  let body: {
    template_id: TemplateId
    data: unknown
    resource_kind?: string
    resource_id?: string
    resource_label?: string
  }

  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { template_id, data } = body

  if (!template_id || !data) {
    return NextResponse.json({ error: 'Missing template_id or data' }, { status: 400 })
  }

  // TODO Phase 5: persist PdfGeneratedDocument + emit pdf_generators.document.generated event
  // const { resource_kind, resource_id, resource_label } = body

  return renderPdf({ template_id, data }, { container }, 'generate')
}

export const openApi: OpenApiRouteDoc = {
  methods: {
    POST: {
      summary: 'Generate PDF document with full side effects',
      responses: [
        { status: 200, description: 'PDF file stream' },
        { status: 400, description: 'Missing or invalid template_id / data' },
        { status: 401, description: 'Unauthorized' },
      ],
    },
  },
}
