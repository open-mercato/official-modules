import { chooseRecovery } from '../recovery'

describe('chooseRecovery', () => {
  it("returns 'repoll' when BOTH references are present (the send reached KSeF)", () => {
    expect(chooseRecovery({ sessionReference: 'sess-1', invoiceReference: 'inv-1' })).toBe('repoll')
  })

  it("returns 'resend' when the invoice reference is missing", () => {
    expect(chooseRecovery({ sessionReference: 'sess-1', invoiceReference: null })).toBe('resend')
    expect(chooseRecovery({ sessionReference: 'sess-1', invoiceReference: undefined })).toBe('resend')
    expect(chooseRecovery({ sessionReference: 'sess-1' })).toBe('resend')
  })

  it("returns 'resend' when the session reference is missing", () => {
    expect(chooseRecovery({ sessionReference: null, invoiceReference: 'inv-1' })).toBe('resend')
    expect(chooseRecovery({ sessionReference: undefined, invoiceReference: 'inv-1' })).toBe('resend')
    expect(chooseRecovery({ invoiceReference: 'inv-1' })).toBe('resend')
  })

  it("returns 'resend' when BOTH references are missing", () => {
    expect(chooseRecovery({})).toBe('resend')
    expect(chooseRecovery({ sessionReference: null, invoiceReference: null })).toBe('resend')
    expect(chooseRecovery({ sessionReference: undefined, invoiceReference: undefined })).toBe('resend')
  })

  it("treats empty strings as missing (a blank reference is not a real KSeF record)", () => {
    expect(chooseRecovery({ sessionReference: '', invoiceReference: '' })).toBe('resend')
    expect(chooseRecovery({ sessionReference: '', invoiceReference: 'inv-1' })).toBe('resend')
    expect(chooseRecovery({ sessionReference: 'sess-1', invoiceReference: '' })).toBe('resend')
  })
})
