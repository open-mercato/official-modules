import { themes as prismThemes } from 'prism-react-renderer'
import type { Config } from '@docusaurus/types'

const siteUrl = process.env.DOCS_SITE_URL ?? 'https://modules.openmercato.com'
const editBaseUrl = process.env.DOCS_EDIT_BASE_URL ?? 'https://github.com/open-mercato/official-modules/tree/main/'

const config: Config = {
  title: 'Official Modules',
  tagline: 'Curated docs for installing and building Open Mercato modules.',
  favicon: 'https://raw.githubusercontent.com/open-mercato/open-mercato/main/apps/mercato/public/open-mercato.svg',
  url: siteUrl,
  baseUrl: '/',
  organizationName: 'open-mercato',
  projectName: 'official-modules',
  onBrokenLinks: 'throw',
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },
  plugins: [
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        language: ['en'],
        indexDocs: true,
        indexBlog: false,
      },
    ],
  ],
  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: require.resolve('./sidebars.ts'),
          routeBasePath: '/',
          editUrl: `${editBaseUrl}apps/docs/`,
          showLastUpdateAuthor: true,
          showLastUpdateTime: true,
        },
        blog: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      },
    ],
  ],
  themeConfig: {
    image: 'https://raw.githubusercontent.com/open-mercato/open-mercato/main/apps/mercato/public/open-mercato.svg',
    navbar: {
      title: 'Official Modules',
      logo: {
        alt: 'Open Mercato Logo',
        src: 'https://raw.githubusercontent.com/open-mercato/open-mercato/main/apps/mercato/public/open-mercato.svg',
        href: '/',
      },
      items: [
        {
          type: 'doc',
          docId: 'overview',
          label: 'Overview',
          position: 'left',
        },
        {
          type: 'doc',
          docId: 'using-modules',
          label: 'Using Modules',
          position: 'left',
        },
        {
          type: 'doc',
          docId: 'development-guide',
          label: 'Development Guide',
          position: 'left',
        },
        {
          type: 'doc',
          docId: 'modules/index',
          label: 'Modules',
          position: 'left',
        },
        {
          href: 'https://github.com/open-mercato/official-modules',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Overview', to: '/overview' },
            { label: 'Using Modules', to: '/using-modules' },
            { label: 'Development Guide', to: '/development-guide' },
            { label: 'Modules', to: '/modules' },
          ],
        },
        {
          title: 'Core Docs',
          items: [
            { label: 'Framework modules', href: 'https://docs.openmercato.com/framework/modules/overview' },
            { label: 'CLI reference', href: 'https://docs.openmercato.com/cli/overview' },
            { label: 'Standalone apps', href: 'https://docs.openmercato.com/customization/standalone-app' },
          ],
        },
        {
          title: 'Community',
          items: [
            { label: 'GitHub', href: 'https://github.com/open-mercato/official-modules' },
            { label: 'Main repository', href: 'https://github.com/open-mercato/open-mercato' },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Open Mercato. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.vsDark,
    },
  },
}

export default config
