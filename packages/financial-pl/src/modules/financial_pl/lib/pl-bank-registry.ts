import { normalizeAccountNumber } from './bank-account'

export type PolishBankInfo = { name: string; swift: string }

/** Registry keyed by the 4-digit Polish bank code. Unknown or uncertain codes are intentionally omitted. */
export const PL_BANK_REGISTRY: Readonly<Record<string, PolishBankInfo>> = {
  '1010': { name: 'Narodowy Bank Polski', swift: 'NBPLPLPW' },
  '1020': { name: 'PKO Bank Polski S.A.', swift: 'BPKOPLPW' },
  '1030': { name: 'Bank Handlowy w Warszawie S.A.', swift: 'CITIPLPX' },
  '1050': { name: 'ING Bank Slaski S.A.', swift: 'INGBPLPW' },
  '1090': { name: 'Santander Bank Polska S.A.', swift: 'WBKPPLPP' },
  '1130': { name: 'Bank Gospodarstwa Krajowego', swift: 'GOSKPLPW' },
  '1140': { name: 'mBank S.A.', swift: 'BREXPLPWMBK' },
  '1160': { name: 'Bank Millennium S.A.', swift: 'BIGBPLPW' },
  '1240': { name: 'Bank Pekao S.A.', swift: 'PKOPPLPW' },
  '1320': { name: 'Bank Pocztowy S.A.', swift: 'POCZPLP4' },
  '1540': { name: 'Bank Ochrony Srodowiska S.A.', swift: 'EBOSPLPW' },
  '1680': { name: 'Plus Bank S.A.', swift: 'IVSEPLPP' },
  '1870': { name: 'Nest Bank S.A.', swift: 'NESBPLPW' },
  '1930': { name: 'Bank Polskiej Spoldzielczosci S.A.', swift: 'POLUPLPR' },
  '1940': { name: 'Credit Agricole Bank Polska S.A.', swift: 'AGRIPLPR' },
  '2030': { name: 'BNP Paribas Bank Polska S.A.', swift: 'PPABPLPK' },
  '2120': { name: 'Santander Consumer Bank S.A.', swift: 'SCFBPLPW' },
  '2160': { name: 'Toyota Bank Polska S.A.', swift: 'TOBAPLPW' },
  '2190': { name: 'DNB Bank Polska S.A.', swift: 'MHBFPLPW' },
  '2480': { name: 'VeloBank S.A. (formerly Getin Noble Bank)', swift: 'GBGCPLPK' },
  '2490': { name: 'Alior Bank S.A.', swift: 'ALBPPLPW' },
} as const

/** Return Polish bank metadata for a bare 26-digit NRB or a PL-prefixed IBAN. */
export function lookupPolishBank(accountNumber: string | null | undefined): PolishBankInfo | null {
  const normalized = normalizeAccountNumber(accountNumber)
  const nrb = /^\d{26}$/.test(normalized)
    ? normalized
    : /^PL\d{26}$/.test(normalized)
      ? normalized.slice(2)
      : null
  if (!nrb) return null

  const bankCode = nrb.slice(2, 6)
  return PL_BANK_REGISTRY[bankCode] ?? null
}
