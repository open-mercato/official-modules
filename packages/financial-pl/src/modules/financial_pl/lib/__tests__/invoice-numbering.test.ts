import {
  findActiveSeries,
  normalizeSeriesCode,
  renderInvoiceNumberTemplate,
  seriesDocumentKind,
  validateSeriesFormat,
  validateSeriesList,
} from '../invoice-numbering'
import type { InvoiceNumberingSeries } from '../../data/entities'

const series = (over: Partial<InvoiceNumberingSeries> = {}): InvoiceNumberingSeries => ({
  id: over.id ?? 's-1',
  code: over.code ?? 'FV',
  name: over.name ?? null,
  format: over.format ?? 'FV/{seq}/{mm}/{yyyy}',
  isDefault: over.isDefault,
  isActive: over.isActive,
})

describe('seriesDocumentKind', () => {
  it('namespaces the series code under the invoice kind', () => {
    expect(seriesDocumentKind('FV')).toBe('invoice:FV')
  })

  it('normalizes the code so the counter row is stable regardless of input casing', () => {
    expect(seriesDocumentKind(' fv-exp ')).toBe('invoice:FV-EXP')
    expect(seriesDocumentKind('fv-exp')).toBe(seriesDocumentKind('FV-EXP'))
  })
})

describe('normalizeSeriesCode', () => {
  it('trims and uppercases', () => {
    expect(normalizeSeriesCode('  fv ')).toBe('FV')
  })
})

describe('renderInvoiceNumberTemplate', () => {
  // Local-constructed date read with local getters — TZ-independent.
  const date = new Date(2026, 6, 31, 14, 5)

  it('renders the Polish-style template with padded sequence', () => {
    expect(renderInvoiceNumberTemplate('FV/{seq:4}/{mm}/{yyyy}', 7, date)).toBe('FV/0007/07/2026')
  })

  it('renders unpadded {seq}, {yy}, {dd} and {hh}', () => {
    expect(renderInvoiceNumberTemplate('{yy}{dd}{hh}-{seq}', 123, date)).toBe('263114-123')
  })

  it('parses tokens case-insensitively', () => {
    expect(renderInvoiceNumberTemplate('FV/{SEQ:3}/{YYYY}', 4, date)).toBe('FV/004/2026')
  })

  it('leaves unknown tokens as-is so core-owned templates render without guessing', () => {
    expect(renderInvoiceNumberTemplate('INV-{rand:4}-{seq}', 9, date)).toBe('INV-{rand:4}-9')
  })
})

describe('validateSeriesFormat', () => {
  it('accepts a typical domestic template', () => {
    expect(validateSeriesFormat('FV/{seq}/{mm}/{yyyy}')).toEqual({ ok: true })
  })

  it('accepts padded sequence and all deterministic date tokens', () => {
    expect(validateSeriesFormat('{yyyy}{yy}{mm}{dd}{hh}-{seq:5}')).toEqual({ ok: true })
  })

  it('rejects an empty template', () => {
    expect(validateSeriesFormat('   ')).toEqual({ ok: false, issue: 'empty' })
  })

  it('rejects a template without a sequence token — numbers would repeat', () => {
    expect(validateSeriesFormat('FV/{mm}/{yyyy}')).toEqual({ ok: false, issue: 'missingSeq' })
  })

  it('rejects non-deterministic tokens a VAT series must not use', () => {
    for (const bad of ['{rand}', '{rand:6}', '{nanoid}', '{guid}', '{kind}']) {
      expect(validateSeriesFormat(`FV/{seq}/${bad}`)).toEqual({ ok: false, issue: 'invalidToken', token: bad })
    }
  })

  it('rejects unknown tokens so a typo cannot render literally into filed numbers', () => {
    expect(validateSeriesFormat('FV/{sq}/{yyyy}/{seq}')).toEqual({ ok: false, issue: 'invalidToken', token: '{sq}' })
  })

  it('rejects a malformed sequence width', () => {
    expect(validateSeriesFormat('FV/{seq:abc}')).toEqual({ ok: false, issue: 'invalidToken', token: '{seq:abc}' })
  })

  it('rejects an overlong template', () => {
    expect(validateSeriesFormat(`${'X'.repeat(70)}{seq}`)).toEqual({ ok: false, issue: 'tooLong' })
  })
})

describe('findActiveSeries', () => {
  it('finds an active series by id (isActive defaults to true when absent)', () => {
    const list = [series({ id: 'a' }), series({ id: 'b', code: 'EXP' })]
    expect(findActiveSeries(list, 'b')?.code).toBe('EXP')
  })

  it('does not return a deactivated series — claiming from it must fail closed', () => {
    const list = [series({ id: 'a', isActive: false })]
    expect(findActiveSeries(list, 'a')).toBeNull()
  })

  it('returns null for an unknown id or empty list', () => {
    expect(findActiveSeries([], 'a')).toBeNull()
    expect(findActiveSeries(null, 'a')).toBeNull()
    expect(findActiveSeries([series({ id: 'a' })], 'zzz')).toBeNull()
  })
})

describe('validateSeriesList', () => {
  it('accepts distinct codes and formats with one default', () => {
    const list = [
      series({ id: 'a', code: 'FV', isDefault: true }),
      series({ id: 'b', code: 'EXP', format: 'EXP/{seq}/{yyyy}' }),
    ]
    expect(validateSeriesList(list)).toEqual({ ok: true })
  })

  it('rejects duplicate codes case-insensitively — both would claim the same counter', () => {
    const list = [series({ id: 'a', code: 'FV' }), series({ id: 'b', code: 'fv', format: 'F/{seq}' })]
    expect(validateSeriesList(list)).toEqual({ ok: false, issue: 'duplicateCode', value: 'FV' })
  })

  it('rejects duplicate formats — independent counters would render colliding numbers', () => {
    const list = [
      series({ id: 'a', code: 'FV' }),
      series({ id: 'b', code: 'EXP', format: 'FV/{seq}/{mm}/{yyyy}' }),
    ]
    expect(validateSeriesList(list)).toEqual({ ok: false, issue: 'duplicateFormat', value: 'FV/{seq}/{mm}/{yyyy}' })
  })

  it('rejects a format reserved by the system default — it would collide with core-assigned numbers', () => {
    const list = [series({ id: 'a', code: 'FV', format: 'INV-{yyyy}{mm}{dd}-{seq:5}' })]
    expect(validateSeriesList(list, { reservedFormats: ['INV-{yyyy}{mm}{dd}-{seq:5}'] })).toEqual({
      ok: false,
      issue: 'reservedFormat',
      value: 'INV-{yyyy}{mm}{dd}-{seq:5}',
    })
  })

  it('rejects more than one default among active series', () => {
    const list = [
      series({ id: 'a', code: 'FV', isDefault: true }),
      series({ id: 'b', code: 'EXP', format: 'E/{seq}', isDefault: true }),
    ]
    expect(validateSeriesList(list)).toEqual({ ok: false, issue: 'multipleDefaults' })
  })

  it('ignores a default flag on a deactivated series', () => {
    const list = [
      series({ id: 'a', code: 'FV', isDefault: true }),
      series({ id: 'b', code: 'EXP', format: 'E/{seq}', isDefault: true, isActive: false }),
    ]
    expect(validateSeriesList(list)).toEqual({ ok: true })
  })
})
