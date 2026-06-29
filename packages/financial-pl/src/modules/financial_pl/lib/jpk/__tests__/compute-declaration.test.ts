import { computeJpkDeclaration, roundPlnFromScaled4 } from '../compute-declaration'
import { toScaled4 } from '../../fa3-mapping'
import type { JpkSprzedazRow, JpkZakupRow } from '../jpk-codes'

const ksef = { kind: 'NrKSeF' as const, value: '2481632647-20261005-3F8DD3400000-57' }

function sale(k: Record<string, string>, extra: Partial<JpkSprzedazRow> = {}): JpkSprzedazRow {
  return {
    nrKontrahenta: '3755747347', nazwaKontrahenta: 'Buyer', dowodSprzedazy: 'FV/1', dataWystawienia: '2026-10-05', ksef, k, ...extra,
  }
}
function purchase(k: Record<string, string>, extra: Partial<JpkZakupRow> = {}): JpkZakupRow {
  return { nrDostawcy: '5260001246', nazwaDostawcy: 'Supplier', dowodZakupu: 'FZ/1', dataZakupu: '2026-10-03', ksef, k, ...extra }
}

describe('roundPlnFromScaled4 (whole-PLN, half-up on magnitude)', () => {
  it('rounds <50gr down, >=50gr up, sign-aware', () => {
    expect(roundPlnFromScaled4(toScaled4('1000.49'))).toBe('1000')
    expect(roundPlnFromScaled4(toScaled4('1000.50'))).toBe('1001')
    expect(roundPlnFromScaled4(toScaled4('0.49'))).toBe('0')
    expect(roundPlnFromScaled4(toScaled4('-12.50'))).toBe('-13')
    expect(roundPlnFromScaled4(toScaled4('-0.40'))).toBe('0')
  })
})

describe('computeJpkDeclaration (worked example)', () => {
  it('aggregates K_ → P_, control sums, settlement chain', () => {
    const sprzedaz = [
      sale({ K_19: '1000.00', K_20: '230.00' }), // 23%
      sale({ K_17: '500.00', K_18: '40.00' }), //   8%
    ]
    const zakup = [purchase({ K_42: '200.00', K_43: '46.00' })] // other-goods input
    const { declaration: d, ctrl } = computeJpkDeclaration({ variant: 'V7M', sprzedaz, zakup })

    expect(ctrl.sprzedazCtrl).toEqual({ liczbaWierszy: 2, podatek: '270.00' }) // 230+40
    expect(ctrl.zakupCtrl).toEqual({ liczbaWierszy: 1, podatek: '46.00' })

    expect(d.P_19).toBe('1000')
    expect(d.P_20).toBe('230')
    expect(d.P_17).toBe('500')
    expect(d.P_18).toBe('40')
    expect(d.P_37).toBe('1500') // K_17(500)+K_19(1000)
    expect(d.P_38).toBe('270') //  K_18(40)+K_20(230)
    expect(d.P_42).toBe('200')
    expect(d.P_43).toBe('46')
    expect(d.P_48).toBe('46')
    expect(d.P_51).toBe('224') // 270 - 46
  })

  it('FP rows are excluded from the aggregates but kept as evidence rows', () => {
    const sprzedaz = [
      sale({ K_19: '1000.00', K_20: '230.00' }),
      sale({ K_19: '1000.00', K_20: '230.00' }, { typDokumentu: 'FP' }), // duplicate of an RO sale → excluded
    ]
    const { declaration: d, ctrl } = computeJpkDeclaration({ variant: 'V7M', sprzedaz, zakup: [] })
    expect(ctrl.sprzedazCtrl).toEqual({ liczbaWierszy: 2, podatek: '230.00' }) // count 2, tax only non-FP
    expect(d.P_38).toBe('230')
  })

  it('refund surplus: P_48 > P_38 → P_51=0, P_53 set', () => {
    const sprzedaz = [sale({ K_19: '100.00', K_20: '23.00' })]
    const zakup = [purchase({ K_42: '1000.00', K_43: '230.00' })]
    const { declaration: d } = computeJpkDeclaration({ variant: 'V7M', sprzedaz, zakup })
    expect(d.P_51).toBe('0')
    expect(d.P_53).toBe('207') // 230 - 23
  })

  it('art. 89a bad-debt: P_68/P_69 from KorektaPodstawyOpodt rows (<=0)', () => {
    const sprzedaz = [
      sale({ K_19: '-1000.00', K_20: '-230.00' }, { korektaPodstawyOpodt: true, terminPlatnosci: '2026-07-01' }),
    ]
    const { declaration: d } = computeJpkDeclaration({ variant: 'V7M', sprzedaz, zakup: [] })
    expect(d.P_68).toBe('-1000')
    expect(d.P_69).toBe('-230')
  })
})
