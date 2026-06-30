import type { IntegrationBundle, IntegrationDefinition } from '@open-mercato/shared/modules/integrations/types'

/**
 * KSeF 2.0 e-invoicing provider registration. Credentials are stored encrypted
 * via IntegrationCredentialsService. Two authentication methods are supported and
 * coexist during the transition: the token path is transitional (valid through
 * 2026-12-31), and certificate/XAdES auth is now SUPPORTED (the durable credential,
 * required from 2027-01-01). Select the active method via `authMethod`.
 */
export const integration: IntegrationDefinition = {
  id: 'ksef_pl',
  title: 'KSeF (Krajowy System e-Faktur)',
  description: 'Polish national e-invoicing system — submit FA(3) invoices, poll status, and retrieve UPO.',
  category: 'other',
  providerKey: 'ksef_pl',
  icon: 'file-invoice',
  docsUrl: 'https://ksef.podatki.gov.pl/integratorzy-it/',
  package: '@open-mercato/financial-pl',
  version: '0.1.0',
  author: 'Open Mercato Team',
  company: 'Open Mercato',
  license: 'MIT',
  tags: ['poland', 'tax', 'invoice', 'compliance', 'ksef'],
  apiVersions: [
    { id: '2.0', label: 'KSeF 2.0 (FA(3))', status: 'stable', default: true },
  ],
  credentials: {
    fields: [
      {
        key: 'environment',
        label: 'Environment',
        type: 'text',
        required: true,
        placeholder: 'test',
        helpText: 'One of: test, demo, prod. Use "test" for the Ministry of Finance test environment.',
      },
      {
        key: 'contextNip',
        label: 'Taxpayer NIP',
        type: 'text',
        required: true,
        placeholder: '1234567890',
        helpText: 'The 10-digit NIP that owns the KSeF context.',
      },
      {
        key: 'ksefToken',
        label: 'KSeF Authorization Token',
        type: 'secret',
        required: true,
        helpText: 'Authorization token issued for the context NIP from the KSeF portal.',
      },
      {
        key: 'sellerName',
        label: 'Seller name (Podmiot1)',
        type: 'text',
        required: false,
        placeholder: 'Acme Sp. z o.o.',
        helpText: 'Legal seller name printed on FA(3) invoices. Required before submitting an invoice to KSeF.',
      },
      {
        key: 'sellerAddressLine1',
        label: 'Seller address',
        type: 'text',
        required: false,
        placeholder: 'ul. Przykładowa 1, 00-001 Warszawa',
        helpText: 'Seller street address. Required before submitting an invoice to KSeF.',
      },
      {
        key: 'sellerAddressLine2',
        label: 'Seller address (line 2)',
        type: 'text',
        required: false,
        helpText: 'Optional second seller address line.',
      },
      {
        key: 'authMethod',
        label: 'Authentication method',
        type: 'text',
        required: false,
        placeholder: 'token',
        helpText:
          "Authentication method: 'token' (transitional, valid until 2026-12-31) or 'certificate' (KSeF certificate, required from 2027-01-01).",
      },
      {
        key: 'certificatePem',
        label: 'KSeF certificate (PEM)',
        type: 'text',
        required: false,
        helpText: 'KSeF Authentication certificate (PEM). Used when authMethod=certificate.',
      },
      {
        key: 'certificatePrivateKeyPem',
        label: 'KSeF certificate private key (PEM)',
        type: 'secret',
        required: false,
        helpText: 'Private key (PEM) for the KSeF certificate. Stored encrypted; never displayed.',
      },
      {
        key: 'jpkSignerCertPem',
        label: 'JPK signer certificate (PEM)',
        type: 'text',
        required: false,
        helpText:
          'Separate qualified/Trusted-Profile JPK signer certificate (PEM). Use a self-signed certificate only on the MF TEST gateway.',
      },
      {
        key: 'jpkSignerPrivateKeyPem',
        label: 'JPK signer private key (PEM)',
        type: 'secret',
        required: false,
        helpText:
          'Private key (PEM) for the separate qualified/Trusted-Profile JPK signer. Stored encrypted; never displayed.',
      },
      {
        key: 'certificateSerialNumber',
        label: 'KSeF certificate serial number',
        type: 'text',
        required: false,
        helpText: 'Serial number of the active KSeF certificate.',
      },
      {
        key: 'offlineCertificatePem',
        label: 'KSeF offline certificate (PEM)',
        type: 'text',
        required: false,
        helpText: 'KSeF Offline certificate (PEM). Signs the KOD II offline QR; separate from the Authentication certificate.',
      },
      {
        key: 'offlineCertificatePrivateKeyPem',
        label: 'KSeF offline certificate private key (PEM)',
        type: 'secret',
        required: false,
        helpText: 'Private key (PEM) for the KSeF Offline certificate. Stored encrypted; never displayed.',
      },
      {
        key: 'offlineCertificateSerialNumber',
        label: 'KSeF offline certificate serial number',
        type: 'text',
        required: false,
        helpText: 'Serial number of the KSeF Offline certificate.',
      },
    ],
  },
  healthCheck: { service: 'ksefHealthCheck' },
}

export const integrations: IntegrationDefinition[] = [integration]

// No integration bundles for KSeF (single provider). Both `bundles` (array) and `bundle`
// (single) are declared explicitly so the generated module runtime's typed
// `bundles ?? (bundle ? [bundle] : [])` access resolves under strict typechecking.
export const bundles: IntegrationBundle[] = []
export const bundle: IntegrationBundle | undefined = undefined
