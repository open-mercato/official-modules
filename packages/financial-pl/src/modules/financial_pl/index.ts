import './commands'
import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'financial_pl',
  title: 'Polish Financials (KSeF)',
  version: '0.1.0',
  description: 'Polish KSeF 2.0 e-invoicing & VAT compliance: FA(3) send/receive, JPK_V7, PDF, offline, corrections.',
  author: 'Open Mercato Team',
  license: 'MIT',
  ejectable: true,
}

export { features } from './acl'

export default metadata
