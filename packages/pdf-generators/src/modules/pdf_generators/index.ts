import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'pdf_generators',
  title: 'PDF Generators',
  description: 'Generates PDF sales documents.',
}

export { features } from './acl'
export default metadata
