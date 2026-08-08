import type { APIRequestContext, APIResponse } from '@playwright/test'
import { apiRequest } from './api'

/** UI-facing template metadata as returned by GET /api/pdf-generators/templates. */
export interface TemplateMeta {
  id: string
  label: string
  description: string
  module: string
  resourceKind: string
  documentType: string
  tags: string[]
  note?: string
}

export interface TemplatesResponse {
  internal: TemplateMeta[]
  external: TemplateMeta[]
}

export async function listTemplates(
  request: APIRequestContext,
  token: string,
): Promise<TemplatesResponse> {
  const response = await apiRequest(request, 'GET', '/api/pdf-generators/templates', { token })
  if (!response.ok()) {
    const body = await response.text()
    throw new Error(`Failed to list templates: ${response.status()} ${body}`)
  }
  return response.json()
}

/**
 * Calls POST /api/pdf-generators/preview and returns the raw response so the
 * caller can assert on status, headers, and body — the endpoint streams a PDF
 * on success and returns JSON on error, so it must not be pre-parsed here.
 */
export async function previewDocument(
  request: APIRequestContext,
  token: string,
  body: { template_id?: string; data?: unknown },
): Promise<APIResponse> {
  return apiRequest(request, 'POST', '/api/pdf-generators/preview', { token, data: body })
}

/**
 * Calls POST /api/pdf-generators/generate and returns the raw response. Like
 * preview it streams a PDF on success and JSON on error; unlike preview it is
 * the production path (side effects land here in Phase 5) and drives the
 * download filename via Content-Disposition.
 */
export async function generateDocument(
  request: APIRequestContext,
  token: string,
  body: { template_id?: string; data?: unknown; resource_kind?: string; resource_id?: string; resource_label?: string },
): Promise<APIResponse> {
  return apiRequest(request, 'POST', '/api/pdf-generators/generate', { token, data: body })
}
