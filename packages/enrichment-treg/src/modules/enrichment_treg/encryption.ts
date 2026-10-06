import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

export const defaultEncryptionMaps: ModuleEncryptionMap[] = [
  {
    entityId: 'enrichment_treg:enrichment_record',
    fields: [
      { field: 'identity' },
      { field: 'proposal' },
      { field: 'summary' },
      { field: 'raw_payload' },
    ],
  },
  {
    entityId: 'enrichment_treg:enrichment_signal',
    fields: [
      { field: 'title' },
      { field: 'summary' },
      { field: 'payload' },
    ],
  },
]

export default defaultEncryptionMaps
