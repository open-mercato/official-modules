import './commands'
import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'financial_pl',
  title: 'Polish Financials (KSeF)',
  version: '0.1.0',
  description: 'Polish KSeF 2.0 e-invoicing connector: FA(3) submission, status, and UPO retrieval.',
  author: 'Open Mercato Team',
  license: 'MIT',
}
