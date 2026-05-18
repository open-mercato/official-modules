import React from 'react'
import { renderToBuffer, type DocumentProps } from '@react-pdf/renderer'
import { NextResponse } from 'next/server'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { AuthContext } from '@open-mercato/shared/lib/auth/server'
import { templateRegistry } from './template-registry'
import type { TemplateId } from './types'

export interface RenderPdfInput {
  template_id: TemplateId
  data: unknown
}

/** Loads and renders a PDF template to a NextResponse PDF stream. */
export async function renderPdf(
  input: RenderPdfInput,
  ctx: { container: AppContainer; auth: AuthContext | null },
  logPrefix: string
): Promise<NextResponse> {
  const { template_id, data } = input

  let template
  try {
    template = await templateRegistry.load({ id: template_id, data }, ctx)
  } catch (err) {
    console.error(`[${logPrefix}] load failed:`, err)
    return NextResponse.json({ error: `Unknown template: ${template_id}` }, { status: 400 })
  }

  const element = React.createElement(template.component, { data: template.data }) as React.ReactElement<DocumentProps>
  const buffer = await renderToBuffer(element)

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${template.filename}"`,
    },
  })
}
