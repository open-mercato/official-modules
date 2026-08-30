import { readApiErrorMessage } from '../api-error-message'

describe('readApiErrorMessage', () => {
  it('prefers the zod detail over the generic category', () => {
    // The QA regression: the purchase register showed "Validation failed" and swallowed the
    // refine message that actually says what to fix.
    const body = {
      error: 'Validation failed',
      details: [{ path: ['purchaseDate'], message: 'The purchase date cannot be in the future.' }],
    }

    expect(readApiErrorMessage(body, 'fallback')).toBe('The purchase date cannot be in the future.')
  })

  it('skips issues that carry no usable message', () => {
    const body = {
      error: 'Validation failed',
      details: [{ message: '' }, { message: '   ' }, {}, { message: 'Document number is required.' }],
    }

    expect(readApiErrorMessage(body, 'fallback')).toBe('Document number is required.')
  })

  it('falls back to the top-level error when there are no details', () => {
    expect(readApiErrorMessage({ error: 'Supplier NIP is already registered' }, 'fallback')).toBe(
      'Supplier NIP is already registered',
    )
  })

  it('uses the localized fallback for empty, malformed and non-object bodies', () => {
    expect(readApiErrorMessage({ error: 'Validation failed', details: [{ message: '' }] }, 'fallback')).toBe(
      'Validation failed',
    )
    expect(readApiErrorMessage({ details: 'not-an-array' }, 'fallback')).toBe('fallback')
    expect(readApiErrorMessage({ error: '  ' }, 'fallback')).toBe('fallback')
    expect(readApiErrorMessage(undefined, 'fallback')).toBe('fallback')
    expect(readApiErrorMessage(null, 'fallback')).toBe('fallback')
    expect(readApiErrorMessage('boom', 'fallback')).toBe('fallback')
  })
})
