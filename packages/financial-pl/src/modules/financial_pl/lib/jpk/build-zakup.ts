/**
 * Build the evidence rows for a Polish VAT purchase record. SPEC-012.
 *
 * Every record yields a ZakupWiersz (input deduction, K_40..K_47). A self-assessed acquisition
 * (WNT / import of goods art.33a / import of services / import of services art.28b / domestic
 * reverse charge art.17) ALSO yields a SprzedazWiersz output row from the SAME document — the
 * output self-assessed VAT (K_23/24, K_25/26, K_27/28, K_29/30, K_31/32) — because that output
 * VAT is simultaneously the deductible input VAT (brochure UWAGA l.1734-1739). One doc → two rows.
 */
import type { JpkZakupRow, JpkSprzedazRow, JpkZakupK, JpkSprzedazK, JpkKsefNode, JpkDokumentZakupu } from './jpk-codes'

export type JpkTransactionClass =
  | 'domestic'
  | 'wnt'
  | 'import_goods'
  | 'import_services'
  | 'import_services_28b'
  | 'reverse_charge_domestic'

export type BuildZakupInput = {
  supplier: { nip?: string | null; name?: string | null; countryCode?: string | null }
  dowodZakupu: string
  dataZakupu: string
  dataWplywu?: string | null
  ksef: JpkKsefNode
  dokumentZakupu?: JpkDokumentZakupu | null
  imp?: boolean | null
  transactionClass: JpkTransactionClass
  // Input-side amounts (2-dp strings).
  netFixedAssets?: string | null // K_40
  vatFixedAssets?: string | null // K_41
  netOther?: string | null // K_42
  vatOther?: string | null // K_43
  corrFixedAssets?: string | null // K_44
  corrOther?: string | null // K_45
  corr89b1?: string | null // K_46 (in minus)
  corr89b4?: string | null // K_47 (in plus)
  marginGross?: string | null // ZakupVAT_Marza
  // Self-assessment output side (for non-domestic classes).
  selfAssessedNet?: string | null
  selfAssessedVat?: string | null
  /** VAT rate (%) for the self-assessment; used to derive the output VAT when it isn't captured. */
  selfAssessedRate?: string | null
}

// 2-dp decimal-string helpers (sign-aware) for the optional self-assessed-VAT derivation.
function toCents(s: string | null | undefined): bigint | null {
  if (s === undefined || s === null || s === '') return null
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim())
  if (!m) return null
  const frac = ((m[3] ?? '') + '00').slice(0, 2)
  return (m[1] === '-' ? -1n : 1n) * (BigInt(m[2]) * 100n + BigInt(frac))
}
function fromCents(c: bigint): string {
  const neg = c < 0n
  const a = neg ? -c : c
  return `${neg ? '-' : ''}${(a / 100n).toString()}.${(a % 100n).toString().padStart(2, '0')}`
}
/** Output VAT = net × rate%, rounded half-up to 2 dp; undefined when net or rate is absent. */
function deriveSelfAssessedVat(net?: string | null, rate?: string | null): string | undefined {
  const netCents = toCents(net)
  const rateCents = toCents(rate) // rate × 100 (a percent with up to 2 dp)
  if (netCents === null || rateCents === null) return undefined
  const num = netCents * rateCents // netCents × rate × 100
  const neg = num < 0n
  const mag = neg ? -num : num
  let cents = mag / 10000n
  if (mag % 10000n >= 5000n) cents += 1n
  return fromCents(neg ? -cents : cents)
}

const SELF_ASSESS_FIELDS: Record<Exclude<JpkTransactionClass, 'domestic'>, { net: JpkSprzedazK; vat: JpkSprzedazK }> = {
  wnt: { net: 'K_23', vat: 'K_24' },
  import_goods: { net: 'K_25', vat: 'K_26' },
  import_services: { net: 'K_27', vat: 'K_28' },
  import_services_28b: { net: 'K_29', vat: 'K_30' },
  reverse_charge_domestic: { net: 'K_31', vat: 'K_32' },
}

function put(k: Partial<Record<string, string>>, field: string, v?: string | null) {
  if (v !== undefined && v !== null && v !== '') k[field] = v
}

export function buildZakupRows(input: BuildZakupInput): { zakup: JpkZakupRow; sprzedaz?: JpkSprzedazRow } {
  const kz: Partial<Record<JpkZakupK, string>> = {}
  // K_40/K_41 and K_42/K_43 are XSD-grouped net/VAT pairs (<sequence minOccurs="0">): if the
  // group is present BOTH must be emitted (a net with no VAT → emit "0.00"), else XSD-invalid.
  const hasV = (v?: string | null) => v !== undefined && v !== null && v !== ''
  const putPair = (net: JpkZakupK, vat: JpkZakupK, nv?: string | null, vv?: string | null) => {
    if (hasV(nv) || hasV(vv)) {
      kz[net] = hasV(nv) ? (nv as string) : '0.00'
      kz[vat] = hasV(vv) ? (vv as string) : '0.00'
    }
  }
  putPair('K_40', 'K_41', input.netFixedAssets, input.vatFixedAssets)
  putPair('K_42', 'K_43', input.netOther, input.vatOther)
  put(kz, 'K_44', input.corrFixedAssets)
  put(kz, 'K_45', input.corrOther)
  put(kz, 'K_46', input.corr89b1)
  put(kz, 'K_47', input.corr89b4)

  const zakup: JpkZakupRow = {
    kodKrajuNadaniaTIN: input.supplier.countryCode ?? undefined,
    nrDostawcy: (input.supplier.nip && input.supplier.nip.trim()) || 'BRAK',
    nazwaDostawcy: (input.supplier.name && input.supplier.name.trim()) || 'BRAK',
    dowodZakupu: input.dowodZakupu,
    dataZakupu: input.dataZakupu,
    dataWplywu: input.dataWplywu ?? undefined,
    ksef: input.ksef,
    dokumentZakupu: input.dokumentZakupu ?? undefined,
    imp: input.imp ?? undefined,
    k: Object.keys(kz).length ? kz : undefined,
    zakupVatMarza: input.marginGross ?? undefined,
  }

  let sprzedaz: JpkSprzedazRow | undefined
  if (input.transactionClass !== 'domestic') {
    const fields = SELF_ASSESS_FIELDS[input.transactionClass]
    const ks: Partial<Record<JpkSprzedazK, string>> = {}
    put(ks, fields.net, input.selfAssessedNet)
    // Output VAT shows "0.00" where a base is filled but no tax arises (brochure l.1107-1110 etc.).
    // When the VAT isn't captured directly, derive it from the captured net × selfAssessedRate.
    const selfAssessedVat =
      input.selfAssessedVat && input.selfAssessedVat !== ''
        ? input.selfAssessedVat
        : deriveSelfAssessedVat(input.selfAssessedNet, input.selfAssessedRate)
    ks[fields.vat] = selfAssessedVat && selfAssessedVat !== '' ? selfAssessedVat : '0.00'
    sprzedaz = {
      kodKrajuNadaniaTIN: input.supplier.countryCode ?? undefined,
      nrKontrahenta: (input.supplier.nip && input.supplier.nip.trim()) || 'BRAK',
      nazwaKontrahenta: (input.supplier.name && input.supplier.name.trim()) || 'BRAK',
      dowodSprzedazy: input.dowodZakupu,
      dataWystawienia: input.dataZakupu,
      ksef: input.ksef,
      k: ks,
    }
  }
  return { zakup, sprzedaz }
}
