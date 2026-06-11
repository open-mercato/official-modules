'use client'

import { Page, PageBody, PageHeader } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import React from 'react'
import type { ColumnDef } from '@tanstack/react-table'
import type { TemplateMeta } from '../../lib/interfaces'

type TemplatesResponse = { internal: TemplateMeta[]; external: TemplateMeta[] }

const columns: ColumnDef<TemplateMeta>[] = [
  {
    accessorKey: 'id',
    header: 'ID',
    meta: { maxWidth: 220, truncate: true },
  },
  {
    accessorKey: 'label',
    header: 'Label',
  },
  {
    accessorKey: 'resourceKind',
    header: 'Resource',
    meta: { maxWidth: 160 },
  },
  {
    accessorKey: 'documentType',
    header: 'Document Type',
    meta: { maxWidth: 140 },
  },
  {
    accessorKey: 'description',
    header: 'Description',
    meta: { truncate: true },
  },
  {
    accessorKey: 'note',
    header: 'Note',
    meta: { truncate: true },
  },
]

function groupByModule(internal: TemplateMeta[], external: TemplateMeta[]): Map<string, { internal: TemplateMeta[]; external: TemplateMeta[] }> {
  const modules = new Map<string, { internal: TemplateMeta[]; external: TemplateMeta[] }>()

  const ensure = (mod: string) => {
    if (!modules.has(mod)) modules.set(mod, { internal: [], external: [] })
    return modules.get(mod)!
  }

  for (const t of internal) ensure(t.module).internal.push(t)
  for (const t of external) ensure(t.module).external.push(t)

  return modules
}

export default function PdfGeneratorsPage() {
  const t = useT()
  const [internal, setInternal] = React.useState<TemplateMeta[]>([])
  const [external, setExternal] = React.useState<TemplateMeta[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    apiCall<TemplatesResponse>('/api/pdf-generators/templates', { method: 'GET' })
      .then(({ result }) => {
        setInternal(result?.internal ?? [])
        setExternal(result?.external ?? [])
      })
      .catch(() => setError(t('pdf_generators.page.error', 'Failed to load templates.')))
      .finally(() => setLoading(false))
  }, [])

  const grouped = groupByModule(internal, external)

  return (
    <Page>
      <PageHeader
        title={t('pdf_generators.page.title', 'Available templates')}
        description={t('pdf_generators.page.description', 'Registered PDF templates available in this application.')}
      />
      <PageBody>
        <div className="flex flex-col gap-10">
          {loading || error ? (
            <DataTable columns={columns} data={[]} isLoading={loading} error={error} disableRowClick />
          ) : (
            Array.from(grouped.entries()).map(([mod, { internal: intl, external: extl }]) => (
              <section key={mod}>
                <h2 className="mb-4 text-base font-semibold capitalize">{mod}</h2>
                <div className="flex flex-col gap-6 pl-4 border-l">
                  {intl.length > 0 && (
                    <div>
                      <h3 className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        {t('pdf_generators.page.internal', 'Internal')}
                      </h3>
                      <DataTable columns={columns} data={intl} disableRowClick />
                    </div>
                  )}
                  <div>
                    <h3 className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      {t('pdf_generators.page.external', 'External')}
                    </h3>
                    {extl.length > 0 ? (
                      <DataTable columns={columns} data={extl} disableRowClick />
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {t('pdf_generators.page.external_empty', 'No external templates registered.')}
                      </p>
                    )}
                  </div>
                </div>
              </section>
            ))
          )}
        </div>
      </PageBody>
    </Page>
  )
}
