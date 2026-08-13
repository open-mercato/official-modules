import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CertificateListFailureState,
  CredentialHealthTokenIndicator,
  resolveCertificateListFailure,
} from '../CertificateStates'

const t = (_key: string, fallback: string) => fallback

describe('FinancialPlCertificatesPage Packet C regressions', () => {
  it('renders a certificate-list 409 as an informational empty state instead of a blocking error', () => {
    const failure = resolveCertificateListFailure(409)
    const markup = renderToStaticMarkup(<CertificateListFailureState failure={failure} t={t} />)

    expect(failure).toBe('certificate-missing')
    expect(markup).toContain('data-slot="empty-state"')
    expect(markup).toContain('No KSeF certificate enrolled yet')
    expect(markup).toContain('Token authorization is separate and may still be configured.')
    expect(markup).not.toContain('role="alert"')
  })

  it('renders token.present=true as the configured token indicator', () => {
    const markup = renderToStaticMarkup(
      <CredentialHealthTokenIndicator
        token={{ present: true, sunsetDate: '2026-12-31T00:00:00.000Z', daysToSunset: 139 }}
        formatDate={(iso) => iso?.slice(0, 10) ?? '—'}
        formatDays={(days) => (days === null ? '' : ` (${days} days)`)}
        t={t}
      />,
    )

    expect(markup).toContain('Token')
    expect(markup).toContain('Configured')
    expect(markup).toContain('139 days')
    expect(markup).not.toContain('Not configured')
  })
})
