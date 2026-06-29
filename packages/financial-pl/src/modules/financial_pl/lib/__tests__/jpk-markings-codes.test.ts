import {
  GTU_CODES,
  JPK_PROCEDURE_MARKINGS,
  JPK_TYP_DOKUMENTU,
  isGtuCode,
  isJpkProcedureMarking,
  isJpkTypDokumentu,
} from '../jpk-markings-codes'

describe('jpk-markings-codes', () => {
  it('exposes the 13 GTU codes GTU_01..GTU_13', () => {
    expect(GTU_CODES).toEqual([
      'GTU_01',
      'GTU_02',
      'GTU_03',
      'GTU_04',
      'GTU_05',
      'GTU_06',
      'GTU_07',
      'GTU_08',
      'GTU_09',
      'GTU_10',
      'GTU_11',
      'GTU_12',
      'GTU_13',
    ])
    expect(new Set(GTU_CODES).size).toBe(13)
  })

  it('exposes the 12 JPK procedure markings', () => {
    expect(JPK_PROCEDURE_MARKINGS).toEqual([
      'WSTO_EE',
      'IED',
      'TP',
      'TT_WNT',
      'TT_D',
      'MR_T',
      'MR_UZ',
      'I_42',
      'I_63',
      'B_SPV',
      'B_SPV_DOSTAWA',
      'B_MPV_PROWIZJA',
    ])
    expect(new Set(JPK_PROCEDURE_MARKINGS).size).toBe(12)
  })

  it('exposes the three TypDokumentu codes', () => {
    expect(JPK_TYP_DOKUMENTU).toEqual(['RO', 'WEW', 'FP'])
  })

  it('guards accept only known codes', () => {
    expect(isGtuCode('GTU_01')).toBe(true)
    expect(isGtuCode('GTU_14')).toBe(false)
    expect(isGtuCode('gtu_01')).toBe(false)
    expect(isGtuCode(undefined)).toBe(false)

    expect(isJpkProcedureMarking('WSTO_EE')).toBe(true)
    expect(isJpkProcedureMarking('B_MPV_PROWIZJA')).toBe(true)
    expect(isJpkProcedureMarking('SW')).toBe(false)

    expect(isJpkTypDokumentu('RO')).toBe(true)
    expect(isJpkTypDokumentu('WEW')).toBe(true)
    expect(isJpkTypDokumentu('FP')).toBe(true)
    expect(isJpkTypDokumentu('XX')).toBe(false)
  })
})
