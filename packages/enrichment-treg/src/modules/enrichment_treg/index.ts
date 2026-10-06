import type { ModuleInfo } from '@open-mercato/shared/modules/registry'
import './commands'

export const metadata: ModuleInfo = {
  name: 'enrichment_treg',
  title: 'treg Enrichment',
  version: '0.1.0',
  description: 'Enrich CRM people and companies with profile data fetched through treg.to.',
  author: 'Open Mercato Team',
  license: 'MIT',
  ejectable: true,
}

export { features } from './acl'

export default metadata
