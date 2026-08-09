import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { NextResponse } from 'next/server'
import '../../../config/registry'
import { renderPdf } from '../../../lib/render-pdf'
import { previewSchema } from '../../../data/validators'
import { parseJsonBody, requireOrganization } from '../../_shared/http'

export const metadata = {
  path: '/pdf-generators/preview',
  POST: { requireAuth: true, requireFeatures: ['pdf_generators.view'] },
}

/**
 * Renders a PDF for preview purposes — no logging, no events, no persistence.
 * Use /generate for production generation with full side effects.
 *
 * @param request - `{ template_id: TemplateId, data: unknown }`
 * @returns PDF binary stream
 */
export async function POST(request: Request) {
  const container = await createRequestContainer()
  const auth = await getAuthFromRequest(request)

  const body = await parseJsonBody(request)
  if (!body.ok) return body.response

  const parsed = previewSchema.safeParse(body.value)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Missing template_id or data' }, { status: 400 })
  }
  const { template_id, data } = parsed.data

  const org = requireOrganization(auth)
  if (!org.ok) return org.response

  return renderPdf({ template_id, data }, { container, auth }, 'preview')
}

export const openApi: OpenApiRouteDoc = {
  methods: {
    POST: {
      summary: 'Render PDF for preview — no side effects',
      responses: [
        { status: 200, description: 'PDF file stream' },
        { status: 400, description: 'Missing or invalid template_id / data' },
        { status: 401, description: 'Unauthorized' },
      ],
    },
  },
}
