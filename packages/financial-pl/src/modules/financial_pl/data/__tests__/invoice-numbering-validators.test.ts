import { invoiceSettingsPutSchema } from '../validators'

const validSeries = {
  id: 'series-1',
  code: 'FV',
  name: 'Domestic sales',
  format: 'FV/{seq}/{mm}/{yyyy}',
  isDefault: true,
  isActive: true,
}

describe('invoiceSettingsPutSchema — numberingSeries', () => {
  it('accepts a valid series list', () => {
    const parsed = invoiceSettingsPutSchema.parse({ numberingSeries: [validSeries] })
    expect(parsed.numberingSeries).toHaveLength(1)
    expect(parsed.numberingSeries?.[0]?.code).toBe('FV')
  })

  it('normalizes the code to uppercase so counters are casing-stable', () => {
    const parsed = invoiceSettingsPutSchema.parse({
      numberingSeries: [{ ...validSeries, code: ' fv-exp ' }],
    })
    expect(parsed.numberingSeries?.[0]?.code).toBe('FV-EXP')
  })

  it('accepts null to clear the list and omission to leave it alone', () => {
    expect(invoiceSettingsPutSchema.parse({ numberingSeries: null }).numberingSeries).toBeNull()
    expect(invoiceSettingsPutSchema.parse({}).numberingSeries).toBeUndefined()
  })

  it('rejects a code with characters that do not belong in a document-kind key', () => {
    for (const code of ['F V', 'FV/2026', 'ĄĘ', '', 'X'.repeat(13)]) {
      expect(invoiceSettingsPutSchema.safeParse({ numberingSeries: [{ ...validSeries, code }] }).success).toBe(false)
    }
  })

  it('rejects a format without {seq}', () => {
    const res = invoiceSettingsPutSchema.safeParse({
      numberingSeries: [{ ...validSeries, format: 'FV/{mm}/{yyyy}' }],
    })
    expect(res.success).toBe(false)
  })

  it('rejects non-deterministic tokens in the format', () => {
    const res = invoiceSettingsPutSchema.safeParse({
      numberingSeries: [{ ...validSeries, format: 'FV/{seq}-{rand}' }],
    })
    expect(res.success).toBe(false)
  })

  it('rejects duplicate codes across the list', () => {
    const res = invoiceSettingsPutSchema.safeParse({
      numberingSeries: [validSeries, { ...validSeries, id: 'series-2', code: 'fv', format: 'X/{seq}' }],
    })
    expect(res.success).toBe(false)
  })

  it('rejects duplicate formats across the list', () => {
    const res = invoiceSettingsPutSchema.safeParse({
      numberingSeries: [validSeries, { ...validSeries, id: 'series-2', code: 'EXP' }],
    })
    expect(res.success).toBe(false)
  })

  it('rejects the reserved system-default format', () => {
    const res = invoiceSettingsPutSchema.safeParse({
      numberingSeries: [{ ...validSeries, format: 'INV-{yyyy}{mm}{dd}-{seq:5}' }],
    })
    expect(res.success).toBe(false)
  })

  it('rejects two defaults among active series', () => {
    const res = invoiceSettingsPutSchema.safeParse({
      numberingSeries: [validSeries, { ...validSeries, id: 'series-2', code: 'EXP', format: 'E/{seq}' }],
    })
    expect(res.success).toBe(false)
  })

  it('caps the list length', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      ...validSeries,
      id: `s-${i}`,
      code: `S${i}`,
      format: `S${i}/{seq}`,
      isDefault: i === 0,
    }))
    expect(invoiceSettingsPutSchema.safeParse({ numberingSeries: many }).success).toBe(false)
  })
})
