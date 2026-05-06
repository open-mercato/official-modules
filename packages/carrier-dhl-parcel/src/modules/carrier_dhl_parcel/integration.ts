import {
  buildIntegrationDetailWidgetSpotId,
  type IntegrationBundle,
  type IntegrationDefinition,
} from '@open-mercato/shared/modules/integrations/types'

export const carrierDhlParcelDetailWidgetSpotId =
  buildIntegrationDetailWidgetSpotId('carrier_dhl_parcel')

export const integration: IntegrationDefinition = {
  id: 'carrier_dhl_parcel',
  title: 'DHL Parcel',
  description:
    'Ship parcels via DHL Parcel eCommerce (Benelux / international) with label generation, rate calculation, and tracking.',
  category: 'shipping',
  hub: 'shipping_carriers',
  providerKey: 'dhl_parcel',
  icon: 'dhl-parcel',
  docsUrl: 'https://api-gw.dhlparcel.nl/docs/combined.json',
  package: '@open-mercato/carrier-dhl-parcel',
  version: '1.0.0',
  author: 'Open Mercato Team',
  company: 'Open Mercato',
  license: 'MIT',
  tags: ['dhl', 'parcel', 'benelux', 'nl', 'be', 'lu', 'eu', 'ecommerce', 'shipping'],
  detailPage: {
    widgetSpotId: carrierDhlParcelDetailWidgetSpotId,
  },
  credentials: {
    fields: [
      {
        key: 'userId',
        label: 'User ID',
        type: 'text',
        required: true,
        helpText:
          'UUID from My DHL Portal → Settings → API KEYS. Generated once — copy immediately.',
      },
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'secret',
        required: true,
        helpText:
          'Secret string from My DHL Portal → Settings → API KEYS. Shown only once — copy immediately.',
      },
      {
        key: 'accountNumber',
        label: 'Account Number',
        type: 'text',
        required: true,
        helpText:
          'e.g. 01234567 — visible in My DHL Portal account section.',
      },
      {
        key: 'apiBaseUrl',
        label: 'API Base URL',
        type: 'url',
        required: false,
        placeholder: 'https://api-gw.dhlparcel.nl',
        helpText:
          'Leave empty for production. DHL has no separate sandbox host — use test account numbers for sandbox mode.',
      },
      {
        key: 'senderCompanyName',
        label: 'Sender Company Name',
        type: 'text',
        required: false,
        helpText: 'Used as the default shipper company name on shipment requests.',
      },
      {
        key: 'senderFirstName',
        label: 'Sender First Name',
        type: 'text',
        required: false,
        helpText: 'Used as the default shipper first name on shipment requests.',
      },
      {
        key: 'senderLastName',
        label: 'Sender Last Name',
        type: 'text',
        required: false,
        helpText: 'Used as the default shipper last name on shipment requests.',
      },
      {
        key: 'senderEmail',
        label: 'Sender Email',
        type: 'text',
        required: false,
        helpText: 'Default sender email used in DHL shipment notifications.',
      },
      {
        key: 'senderPhone',
        label: 'Sender Phone',
        type: 'text',
        required: false,
        helpText: 'Default sender phone used in DHL shipment notifications.',
      },
    ],
  },
  healthCheck: { service: 'dhlParcelHealthCheck' },
}

export const integrations: IntegrationDefinition[] = [integration]
export const bundles: IntegrationBundle[] = []
export const bundle: IntegrationBundle | undefined = undefined
