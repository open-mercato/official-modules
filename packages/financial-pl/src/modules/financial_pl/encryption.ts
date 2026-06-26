import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

/**
 * KSeF documents carry the taxpayer's invoices and acceptance receipts — both
 * compliance-sensitive — so the FA(3) payload and the signed UPO are encrypted
 * at rest. KSeF credentials (token/cert) are stored via IntegrationCredentialsService,
 * which encrypts them independently.
 */
export const defaultEncryptionMaps: ModuleEncryptionMap[] = [
  {
    entityId: 'financial_pl:ksef_submission',
    fields: [{ field: 'invoice_xml' }, { field: 'upo_xml' }],
  },
]

export default defaultEncryptionMaps
