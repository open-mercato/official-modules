import type { SidebarsConfig } from '@docusaurus/plugin-content-docs'

const sidebars: SidebarsConfig = {
  docs: [
    'overview',
    'using-modules',
    'development-guide',
    {
      type: 'category',
      label: 'Modules',
      items: [
        'modules/index'
      ],
    },
  ],
}

export default sidebars
