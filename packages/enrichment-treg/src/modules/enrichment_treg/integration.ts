import { buildIntegrationDetailWidgetSpotId, type IntegrationDefinition } from '@open-mercato/shared/modules/integrations/types'
import { TREG_INTEGRATION_ID } from './lib/constants'

export const enrichmentTregDetailWidgetSpotId = buildIntegrationDetailWidgetSpotId(TREG_INTEGRATION_ID)

export const integration: IntegrationDefinition = {
  id: TREG_INTEGRATION_ID,
  title: 'treg Enrichment',
  description: 'Enrich CRM people and companies with job titles, firmographics and links from 100+ data providers via treg.to.',
  category: 'other',
  providerKey: 'treg',
  icon: 'sparkles',
  docsUrl: 'https://treg.to/docs',
  package: '@open-mercato/enrichment-treg',
  version: '0.1.0',
  author: 'Open Mercato Team',
  company: 'Open Mercato',
  license: 'MIT',
  tags: ['enrichment', 'crm', 'people', 'companies', 'firmographics'],
  detailPage: {
    widgetSpotId: enrichmentTregDetailWidgetSpotId,
  },
  credentials: {
    fields: [
      {
        key: 'apiToken',
        label: 'treg API token',
        type: 'secret',
        required: true,
        helpText: 'Org token from treg.to (Settings → API keys). Sent as X-Treg-Token.',
      },
      {
        key: 'orgSlug',
        label: 'treg team slug',
        type: 'text',
        required: false,
        helpText: 'Only needed for identity tokens. Sent as X-Treg-Org.',
      },
      {
        key: 'maxCostPerCallUsd',
        label: 'Max cost per call (USD)',
        type: 'text',
        required: false,
        placeholder: '0.05',
        helpText: 'Hard ceiling treg enforces on each enrichment call. Defaults to 0.05.',
      },
      {
        key: 'apiBaseUrl',
        label: 'API base URL',
        type: 'url',
        required: false,
        placeholder: 'https://treg.to',
        helpText: 'Leave empty for production.',
      },
    ],
  },
  healthCheck: { service: 'tregHealthCheck' },
}

export default integration
