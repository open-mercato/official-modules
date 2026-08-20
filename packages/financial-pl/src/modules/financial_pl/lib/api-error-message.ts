/**
 * Pick the most specific human-readable message out of an API error body.
 *
 * Zod-backed routes in this module answer `{ error: 'Validation failed', details: ZodIssue[] }`.
 * The top-level `error` is a category, not an explanation — rendering it alone tells the user
 * *that* the save failed but never *what* to change. QA hit this on the purchase register's
 * future-date rule, where the refine already produces "The purchase date cannot be in the
 * future." but the screen showed a bare "Validation failed".
 *
 * Preference order: the first issue that carries a message, then the top-level `error`, then
 * the caller's localized fallback.
 */
export function readApiErrorMessage(result: unknown, fallback: string): string {
  if (result && typeof result === 'object') {
    const body = result as { error?: unknown; details?: unknown }

    if (Array.isArray(body.details)) {
      for (const issue of body.details) {
        const message = (issue as { message?: unknown } | null)?.message
        if (typeof message === 'string' && message.trim()) return message
      }
    }

    if (typeof body.error === 'string' && body.error.trim()) return body.error
  }

  return fallback
}
