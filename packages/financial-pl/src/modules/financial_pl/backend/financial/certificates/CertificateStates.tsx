"use client"

import * as React from 'react'
import { Info } from 'lucide-react'
import { ErrorMessage } from '@open-mercato/ui/backend/detail/ErrorMessage'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { Tag } from '@open-mercato/ui/primitives/tag'

type Translate = (key: string, fallback: string) => string

export type CertificateListFailure = 'certificate-missing' | 'error'

type CredentialHealthToken = {
  present: boolean
  sunsetDate: string
  daysToSunset: number | null
}

export function resolveCertificateListFailure(status: number): CertificateListFailure {
  return status === 409 ? 'certificate-missing' : 'error'
}

export function CertificateListFailureState({
  failure,
  t,
}: {
  failure: CertificateListFailure
  t: Translate
}) {
  if (failure === 'certificate-missing') {
    return (
      <EmptyState
        size="sm"
        icon={<Info className="size-5 text-status-info-icon" />}
        title={t('financial_pl.certificates.noCertificate.title', 'No KSeF certificate enrolled yet')}
        description={t(
          'financial_pl.certificates.noCertificate.description',
          'Token authorization is separate and may still be configured. Check the Token indicator above.',
        )}
      />
    )
  }

  return <ErrorMessage label={t('financial_pl.certificates.errors.load', 'Failed to load KSeF certificates.')} />
}

export function CredentialHealthTokenIndicator({
  token,
  formatDate,
  formatDays,
  t,
}: {
  token: CredentialHealthToken
  formatDate: (iso: string | null) => string
  formatDays: (days: number | null) => string
  t: Translate
}) {
  const sunsetSoon = token.present && token.daysToSunset !== null && token.daysToSunset < 60

  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t('financial_pl.credentialHealth.token', 'Token')}</span>
        <Tag variant={!token.present ? 'neutral' : sunsetSoon ? 'warning' : 'info'} dot>
          {!token.present
            ? t('financial_pl.credentialHealth.missing', 'Missing')
            : sunsetSoon
              ? t('financial_pl.credentialHealth.sunsetSoon', 'Sunset soon')
              : t('financial_pl.credentialHealth.configured', 'Configured')}
        </Tag>
      </div>
      <span className="text-xs text-muted-foreground">
        {token.present
          ? `${t('financial_pl.credentialHealth.tokenSunset', 'Sunset')} ${formatDate(token.sunsetDate)}${formatDays(token.daysToSunset)}`
          : t('financial_pl.credentialHealth.notConfigured', 'Not configured')}
      </span>
    </div>
  )
}
