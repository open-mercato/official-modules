import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

/**
 * KSeF documents carry the taxpayer's invoices and acceptance receipts — both
 * compliance-sensitive — so the FA(3) payload and the signed UPO are encrypted
 * at rest. KSeF credentials (token/cert) are stored via IntegrationCredentialsService,
 * which encrypts them independently. The generated JPK_VAT XML is likewise
 * compliance-sensitive (carries the full sales+purchase register), so it is encrypted too.
 */
export const defaultEncryptionMaps: ModuleEncryptionMap[] = [
  {
    entityId: 'financial_pl:ksef_submission',
    fields: [{ field: 'invoice_xml' }, { field: 'upo_xml' }],
  },
  {
    // Entity-id is toSnake(className) — the JpkVatFiling CLASS, not its table name
    // (financial_pl_jpk_filing) — matching how KsefSubmission → ksef_submission resolves.
    entityId: 'financial_pl:jpk_vat_filing',
    fields: [{ field: 'generated_xml' }],
  },
]

export default defaultEncryptionMaps
