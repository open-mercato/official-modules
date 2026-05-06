"use client"

import * as React from 'react'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { ExternalLink } from 'lucide-react'

export default function DhlConfigWidget(props: InjectionWidgetComponentProps) {
  const t = useT()
  const integrationId = (props.context as Record<string, unknown> | undefined)?.integrationId as string | undefined
  const credentialsHref = integrationId
    ? `/backend/integrations/${integrationId}/credentials`
    : '/backend/integrations'

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <p className="text-sm text-muted-foreground">
        {t(
          'carrier_dhl_parcel.config.help',
          'Configure your DHL Parcel credentials in Integration credentials. Credentials are provisioned once through My DHL Portal.',
        )}
      </p>
      <div className="space-y-2 text-sm">
        <p className="font-medium">
          {t('carrier_dhl_parcel.config.requiredCredentials', 'Required credentials:')}
        </p>
        <ul className="list-inside list-disc space-y-1 text-muted-foreground">
          <li>
            {t(
              'carrier_dhl_parcel.config.credential.userId',
              'User ID — UUID from My DHL Portal → Settings → API KEYS',
            )}
          </li>
          <li>
            {t(
              'carrier_dhl_parcel.config.credential.apiKey',
              'API Key — secret from My DHL Portal → Settings → API KEYS (shown once only)',
            )}
          </li>
          <li>
            {t(
              'carrier_dhl_parcel.config.credential.accountNumber',
              'Account Number — e.g. 01234567, visible in My DHL Portal account section',
            )}
          </li>
        </ul>
      </div>
      <Button asChild variant="outline" size="sm">
        <a href={credentialsHref}>
          <ExternalLink className="mr-2 h-4 w-4" />
          {t('carrier_dhl_parcel.config.action.configureCredentials', 'Configure credentials')}
        </a>
      </Button>
    </div>
  )
}
