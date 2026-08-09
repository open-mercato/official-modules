import React from 'react'
import { renderToBuffer, type DocumentProps } from '@react-pdf/renderer'
import { NextResponse } from 'next/server'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { AuthContext } from '@open-mercato/shared/lib/auth/server'
import { templateRegistry } from './template-registry'
import type { TemplateId } from './types'

export interface RenderPdfInput {
  // Any string is accepted; an unregistered id makes the registry throw.
  template_id: TemplateId | string
  data: unknown
}

/** Loads a template, renders it, and returns the raw PDF bytes + filename.
 *  Throws if the template id is not registered — callers decide how to surface it. */
export async function renderPdfToBuffer(
  input: RenderPdfInput,
  ctx: { container: AppContainer; auth: AuthContext | null }
): Promise<{ buffer: Uint8Array; filename: string; resourceLabel?: string }> {
  const template = await templateRegistry.load({ id: input.template_id, data: input.data }, ctx)
  const element = React.createElement(template.component, { data: template.data }) as React.ReactElement<DocumentProps>
  const buffer = await renderToBuffer(element)
  return { buffer: new Uint8Array(buffer), filename: template.filename, resourceLabel: template.resourceLabel }
}

/** Wraps rendered PDF bytes in a downloadable NextResponse. */
export function pdfResponse(buffer: Uint8Array, filename: string): NextResponse {
  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}

/** Loads and renders a PDF template to a NextResponse PDF stream. */
export async function renderPdf(
  input: RenderPdfInput,
  ctx: { container: AppContainer; auth: AuthContext | null },
  logPrefix: string
): Promise<NextResponse> {
  try {
    const { buffer, filename } = await renderPdfToBuffer(input, ctx)
    return pdfResponse(buffer, filename)
  } catch (err) {
    console.error(`[${logPrefix}] load failed:`, err)
    return NextResponse.json({ error: `Unknown template: ${input.template_id}` }, { status: 400 })
  }
}
