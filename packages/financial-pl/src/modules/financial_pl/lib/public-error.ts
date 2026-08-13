import { NextResponse } from 'next/server'
import type { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'

const INTERNAL_PREFIX = '[internal]'
const GENERIC_KEY = 'financial_pl.errors.actionFailed'
const GENERIC_FALLBACK = 'The request could not be completed. Please try again or contact support.'

/**
 * Known internal-error `code`s that carry a translatable public message. Errors thrown as
 * `{ error: '[internal] …' }` without a mapped code fall back to the generic message — the invariant
 * is only that a raw `[internal]` diagnostic never reaches the client (QA #40).
 */
const PUBLIC_CODE_KEYS: Record<string, string> = {
  source_not_ready: 'financial_pl.errors.source_not_ready',
  credit_memo_not_linked: 'financial_pl.errors.credit_memo_not_linked',
  correction_reason_required: 'financial_pl.errors.correction_reason_required',
  seller_required: 'financial_pl.errors.seller_required',
  buyer_required: 'financial_pl.errors.buyer_required',
}

type Translate = (key: string, fallback: string) => string

/**
 * Sanitize a `CrudHttpError` body for the client: strip any `[internal]` diagnostic, replacing it
 * with a translated public message (by `code` when known, otherwise generic) and logging the
 * internal detail server-side only. A body carrying no `[internal]` marker is returned unchanged so
 * already-public, translated errors (e.g. `seller_required`) pass through verbatim. (QA #40)
 */
export function toPublicErrorBody(body: unknown, translate: Translate): Record<string, unknown> {
  const record: Record<string, unknown> =
    body && typeof body === 'object' && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {}
  const rawError = typeof record.error === 'string' ? record.error : ''
  if (!rawError.startsWith(INTERNAL_PREFIX)) return record
  const code = typeof record.code === 'string' ? record.code : undefined
  // Internal diagnostic detail stays in the server log; it must never be part of the response.
  // eslint-disable-next-line no-console
  console.error(`[financial_pl] internal error surfaced${code ? ` (code=${code})` : ''}: ${rawError}`)
  const key = code && PUBLIC_CODE_KEYS[code] ? PUBLIC_CODE_KEYS[code] : GENERIC_KEY
  record.error = translate(key, translate(GENERIC_KEY, GENERIC_FALLBACK))
  return record
}

/**
 * Build a `NextResponse` for a `CrudHttpError` with a sanitized, translated public body. Resolving
 * translations is best-effort (falls back to the English defaults) so error handling never throws.
 */
export async function respondPublicError(err: CrudHttpError): Promise<NextResponse> {
  let translate: Translate = (_key, fallback) => fallback
  try {
    const resolved = await resolveTranslations()
    translate = resolved.translate
  } catch {
    // Keep the identity fallback: the guarantee is that no [internal] string leaks, not localization.
  }
  return NextResponse.json(toPublicErrorBody(err.body, translate), { status: err.status })
}
