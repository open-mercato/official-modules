import { toPublicErrorBody } from '../public-error'

// Return a marker carrying the key so we can assert which message was selected.
const tr = (key: string, _fallback: string) => `T:${key}`

describe('toPublicErrorBody (QA #40 — no [internal] ever leaks)', () => {
  it('maps a known code to its public i18n key and drops the [internal] detail', () => {
    const out = toPublicErrorBody({ error: '[internal] credit memo not found', code: 'source_not_ready' }, tr)
    expect(out.error).toBe('T:financial_pl.errors.source_not_ready')
    expect(out.code).toBe('source_not_ready')
    expect(JSON.stringify(out)).not.toContain('[internal]')
  })

  it('falls back to the generic public message when there is no code', () => {
    const out = toPublicErrorBody({ error: '[internal] Organization scope is required' }, tr)
    expect(out.error).toBe('T:financial_pl.errors.actionFailed')
    expect(JSON.stringify(out)).not.toContain('[internal]')
  })

  it('falls back to generic for an unmapped code but preserves the code', () => {
    const out = toPublicErrorBody({ error: '[internal] boom', code: 'some_unmapped_code' }, tr)
    expect(out.error).toBe('T:financial_pl.errors.actionFailed')
    expect(out.code).toBe('some_unmapped_code')
    expect(JSON.stringify(out)).not.toContain('[internal]')
  })

  it('passes an already-public (non-[internal]) message through unchanged', () => {
    const out = toPublicErrorBody({ error: 'The KSeF seller details are not configured.', code: 'seller_required' }, tr)
    expect(out.error).toBe('The KSeF seller details are not configured.')
    expect(out.code).toBe('seller_required')
  })

  it('handles a null / non-object body without throwing', () => {
    expect(toPublicErrorBody(null, tr)).toEqual({})
    expect(toPublicErrorBody('nope', tr)).toEqual({})
  })

  it('never returns a body containing [internal] across a range of internal errors', () => {
    const samples = [
      { error: '[internal] UPO not available for this submission' },
      { error: '[internal] corrected original invoice not found' },
      { error: '[internal] credit memo not found for FA(3) KOR resolution', code: 'source_not_ready' },
      { error: '[internal] Organization scope is required' },
    ]
    for (const sample of samples) {
      expect(JSON.stringify(toPublicErrorBody(sample, tr))).not.toContain('[internal]')
    }
  })
})
