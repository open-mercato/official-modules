"use client"

import * as React from 'react'
import { RefreshCw, Sparkles } from 'lucide-react'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { formatDateTime, formatRelativeTime } from '@open-mercato/shared/lib/time'
import type { AppEventPayload, InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { apiCall, readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useAppEvent } from '@open-mercato/ui/backend/injection/useAppEvent'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { ErrorMessage, LoadingMessage, TabEmptyState } from '@open-mercato/ui/backend/detail'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { Checkbox } from '@open-mercato/ui/primitives/checkbox'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@open-mercato/ui/primitives/table'
import SignalsSection from '../../../components/SignalsSection'

type SubjectType = 'person' | 'company'

type EnrichmentContext = {
  resourceKind?: string
  resourceId?: string
  retryLastMutation?: () => Promise<boolean>
}

type EnrichmentRecord = {
  id: string
  status: 'pending' | 'running' | 'completed' | 'no_match' | 'failed'
  failureReason: string | null
  servedBy: string | null
  costMicro: number
  proposal: Record<string, string> | null
  summary: Record<string, unknown> | null
  appliedFields: string[] | null
  appliedAt: string | null
  fetchedAt: string | null
  createdAt: string
}

type SubjectData = {
  person?: { updatedAt?: string | null; updated_at?: string | null } | null
  company?: { updatedAt?: string | null; updated_at?: string | null; description?: string | null } | null
  profile?: Record<string, unknown> | null
}

const SUBJECT_BY_RESOURCE: Record<string, SubjectType> = {
  'customers.person': 'person',
  'customers.company': 'company',
}

const FIELDS_BY_SUBJECT: Record<SubjectType, string[]> = {
  person: ['jobTitle', 'linkedInUrl'],
  company: ['brandName', 'domain', 'websiteUrl', 'industry', 'sizeBucket', 'description'],
}

const CUSTOMERS_API: Record<SubjectType, string> = {
  person: '/api/customers/people',
  company: '/api/customers/companies',
}

const STATUS_VARIANT: Record<EnrichmentRecord['status'], StatusBadgeVariant> = {
  pending: 'info',
  running: 'info',
  completed: 'success',
  no_match: 'neutral',
  failed: 'error',
}

const POLL_INTERVAL_MS = 2000
const POLL_MAX_ATTEMPTS = 45

function readCurrentValue(subjectType: SubjectType, data: SubjectData | null, field: string): string {
  if (subjectType === 'company' && field === 'description') {
    return typeof data?.company?.description === 'string' ? data.company.description : ''
  }
  const value = data?.profile?.[field]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function readUpdatedAt(subjectType: SubjectType, data: SubjectData | null): string | null {
  const source = subjectType === 'person' ? data?.person : data?.company
  return source?.updatedAt ?? source?.updated_at ?? null
}

function sameValue(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

function formatUsd(costMicro: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(costMicro / 1_000_000)
}

export default function EnrichmentTabWidget(props: InjectionWidgetComponentProps<EnrichmentContext, SubjectData>) {
  const subjectType = props.context?.resourceKind ? SUBJECT_BY_RESOURCE[props.context.resourceKind] : undefined
  const subjectId = typeof props.context?.resourceId === 'string' ? props.context.resourceId : null
  if (subjectType !== 'company' || !subjectId) return <ProfileEnrichment {...props} />
  return (
    <div className="space-y-6">
      <ProfileEnrichment {...props} />
      <SignalsSection companyId={subjectId} context={props.context ?? {}} />
    </div>
  )
}

function ProfileEnrichment({
  context,
  data,
  onDataChange,
}: InjectionWidgetComponentProps<EnrichmentContext, SubjectData>) {
  const t = useT()
  const locale = useLocale()
  const subjectType = context?.resourceKind ? SUBJECT_BY_RESOURCE[context.resourceKind] : undefined
  const subjectId = typeof context?.resourceId === 'string' ? context.resourceId : null
  const subjectData = (data ?? null) as SubjectData | null

  const [record, setRecord] = React.useState<EnrichmentRecord | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [starting, setStarting] = React.useState(false)
  const [applying, setApplying] = React.useState(false)
  const [stalled, setStalled] = React.useState(false)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const pollAttempts = React.useRef(0)

  const { runMutation } = useGuardedMutation<EnrichmentContext>({
    contextId: `enrichment_treg:${subjectType ?? 'unknown'}:${subjectId ?? 'none'}`,
  })

  const loadLatest = React.useCallback(async () => {
    if (!subjectType || !subjectId) return
    setLoadError(null)
    try {
      const params = new URLSearchParams({ subjectType, subjectId, pageSize: '1' })
      const payload = await readApiResultOrThrow<{ items: EnrichmentRecord[] }>(
        `/api/enrichment_treg/records?${params.toString()}`,
        undefined,
        { errorMessage: t('enrichment_treg.tab.errors.load', 'Failed to load enrichment results.') },
      )
      setRecord(payload.items?.[0] ?? null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('enrichment_treg.tab.errors.load', 'Failed to load enrichment results.'))
    } finally {
      setLoading(false)
    }
  }, [subjectId, subjectType, t])

  React.useEffect(() => {
    void loadLatest()
  }, [loadLatest])

  useAppEvent(
    'enrichment_treg.record.*',
    (event: AppEventPayload) => {
      if (event.payload?.subjectId === subjectId) void loadLatest()
    },
    [loadLatest, subjectId],
  )

  const inFlight = record?.status === 'pending' || record?.status === 'running'
  React.useEffect(() => {
    if (!inFlight) {
      pollAttempts.current = 0
      setStalled(false)
      return
    }
    if (pollAttempts.current >= POLL_MAX_ATTEMPTS) {
      setStalled(true)
      return
    }
    const timer = setTimeout(() => {
      pollAttempts.current += 1
      void loadLatest()
    }, POLL_INTERVAL_MS)
    return () => clearTimeout(timer)
  }, [inFlight, loadLatest, record?.id, record?.status, loadError])

  const refreshNow = React.useCallback(() => {
    pollAttempts.current = 0
    setStalled(false)
    void loadLatest()
  }, [loadLatest])

  const rows = React.useMemo(() => {
    if (!subjectType || !record?.proposal) return []
    return FIELDS_BY_SUBJECT[subjectType]
      .filter((field) => typeof record.proposal?.[field] === 'string')
      .map((field) => {
        const proposed = record.proposal![field]
        const current = readCurrentValue(subjectType, subjectData, field)
        return {
          field,
          current,
          proposed,
          identical: current.length > 0 && sameValue(current, proposed),
          applied: Boolean(record.appliedFields?.includes(field)),
        }
      })
  }, [record, subjectData, subjectType])

  React.useEffect(() => {
    setSelected(new Set(rows.filter((row) => !row.identical && !row.applied && row.current.length === 0).map((row) => row.field)))
  }, [rows])

  const startEnrichment = React.useCallback(async () => {
    if (!subjectType || !subjectId) return
    setStarting(true)
    try {
      const call = await runMutation({
        operation: () =>
          apiCall<{ record?: EnrichmentRecord; error?: string }>('/api/enrichment_treg/enrich', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subjectType, subjectId }),
          }),
        mutationPayload: { subjectType, subjectId },
        context: context ?? {},
      })
      if (call.ok && call.result?.record) {
        pollAttempts.current = 0
        setStalled(false)
        setRecord(call.result.record)
        return
      }
      const code = call.result?.error ?? 'unexpected'
      flash(t(`enrichment_treg.tab.errors.${code}`, t('enrichment_treg.tab.errors.unexpected', 'Enrichment could not be started.')), 'error')
    } catch {
      flash(t('enrichment_treg.tab.errors.unexpected', 'Enrichment could not be started.'), 'error')
    } finally {
      setStarting(false)
    }
  }, [context, runMutation, subjectId, subjectType, t])

  const refreshSubject = React.useCallback(async () => {
    if (!subjectType || !subjectId || !onDataChange) return
    try {
      const refreshed = await readApiResultOrThrow<SubjectData>(`${CUSTOMERS_API[subjectType]}/${encodeURIComponent(subjectId)}`)
      onDataChange(refreshed)
    } catch {
      flash(t('enrichment_treg.tab.refreshHint', 'Saved. Reload the page to see the updated record.'), 'info')
    }
  }, [onDataChange, subjectId, subjectType, t])

  const applySelected = React.useCallback(async () => {
    if (!subjectType || !subjectId || !record?.proposal || selected.size === 0) return
    const fields = [...selected]
    const patch: Record<string, string> = {}
    for (const field of fields) patch[field] = record.proposal[field]
    setApplying(true)
    try {
      await runMutation({
        operation: async () => {
          await withScopedApiRequestHeaders(buildOptimisticLockHeader(readUpdatedAt(subjectType, subjectData)), () =>
            readApiResultOrThrow(
              CUSTOMERS_API[subjectType],
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: subjectId, ...patch }),
              },
              { errorMessage: t('enrichment_treg.tab.errors.apply', 'Could not update the record.') },
            ),
          )
          const marked = await readApiResultOrThrow<{ record: EnrichmentRecord }>(
            `/api/enrichment_treg/records/${encodeURIComponent(record.id)}/applied`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fields }),
            },
            { errorMessage: t('enrichment_treg.tab.errors.apply', 'Could not update the record.') },
          )
          setRecord(marked.record)
        },
        mutationPayload: { id: subjectId, ...patch },
        context: context ?? {},
      })
    } catch (err) {
      if (!(err && typeof err === 'object' && (err as { status?: number }).status === 409)) {
        flash(err instanceof Error ? err.message : t('enrichment_treg.tab.errors.apply', 'Could not update the record.'), 'error')
      }
      setApplying(false)
      return
    }
    flash(t('enrichment_treg.tab.applied', 'Selected fields were saved.'), 'success')
    await refreshSubject()
    setApplying(false)
  }, [context, record, refreshSubject, runMutation, selected, subjectData, subjectId, subjectType, t])

  const toggleField = React.useCallback((field: string, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (checked) next.add(field)
      else next.delete(field)
      return next
    })
  }, [])

  if (!subjectType || !subjectId) return null
  if (loading) return <LoadingMessage label={t('enrichment_treg.tab.loading', 'Loading enrichment…')} />

  const retryButton = (
    <Button type="button" variant="outline" size="sm" onClick={refreshNow}>
      {t('enrichment_treg.tab.retry', 'Retry')}
    </Button>
  )

  if (loadError && !record) return <ErrorMessage label={loadError} action={retryButton} />

  const busy = starting || (inFlight && !stalled)
  const enrichLabel = busy
    ? t('enrichment_treg.tab.running', 'Enriching…')
    : record
      ? t('enrichment_treg.tab.reEnrich', 'Enrich again')
      : t('enrichment_treg.tab.enrich', 'Enrich with treg')

  if (!record) {
    return (
      <TabEmptyState
        title={t('enrichment_treg.tab.emptyTitle', 'No enrichment yet')}
        description={t(
          `enrichment_treg.tab.emptyDescription.${subjectType}`,
          'Look up this record on treg.to and review proposed values before saving them.',
        )}
        action={{
          label: enrichLabel,
          onClick: () => void startEnrichment(),
          icon: <Sparkles className="size-4" aria-hidden />,
          disabled: busy,
        }}
      />
    )
  }

  const summary = record.summary ?? {}
  const summaryItems = (['name', 'company', 'companyDomain', 'location', 'employees', 'founded'] as const)
    .map((key) => ({ key, value: summary[key] }))
    .filter((item) => typeof item.value === 'string' || typeof item.value === 'number')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StatusBadge variant={STATUS_VARIANT[record.status]} dot>
            {t(`enrichment_treg.status.${record.status}`, record.status)}
          </StatusBadge>
          {record.fetchedAt ? (
            <span title={formatDateTime(record.fetchedAt) ?? undefined}>
              {formatRelativeTime(record.fetchedAt, { locale })}
            </span>
          ) : null}
          {record.servedBy ? (
            <span>{t('enrichment_treg.tab.servedBy', 'via {provider}', { provider: record.servedBy })}</span>
          ) : null}
          {record.costMicro > 0 ? (
            <span>{t('enrichment_treg.tab.cost', 'cost {amount}', { amount: formatUsd(record.costMicro, locale) })}</span>
          ) : null}
        </div>
        <Button type="button" variant="outline" onClick={startEnrichment} disabled={busy}>
          <RefreshCw className="size-4" aria-hidden />
          {enrichLabel}
        </Button>
      </div>

      {loadError ? (
        <Alert status="error" style="light" size="sm" action={retryButton}>
          {loadError}
        </Alert>
      ) : null}

      {stalled ? (
        <Alert
          status="warning"
          style="light"
          size="sm"
          action={
            <Button type="button" variant="outline" size="sm" onClick={refreshNow}>
              {t('enrichment_treg.tab.refresh', 'Refresh')}
            </Button>
          }
        >
          {t('enrichment_treg.tab.stalled', 'The lookup is taking longer than expected. Refresh to check again.')}
        </Alert>
      ) : null}

      {record.status === 'failed' ? (
        <Alert status="error" style="light" size="sm">
          {t(
            `enrichment_treg.tab.failure.${record.failureReason ?? 'unexpected'}`,
            t('enrichment_treg.tab.failure.unexpected', 'The lookup failed. Try again later.'),
          )}
        </Alert>
      ) : null}

      {record.status === 'no_match' ? (
        <p className="text-sm text-muted-foreground">
          {t('enrichment_treg.tab.noMatch', 'treg found no match for this record. Add an email, LinkedIn URL or domain and try again.')}
        </p>
      ) : null}

      {summaryItems.length > 0 ? (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {summaryItems.map((item) => (
            <div key={item.key} className="flex gap-2">
              <dt className="text-muted-foreground">{t(`enrichment_treg.summary.${item.key}`, item.key)}</dt>
              <dd className="font-medium">{String(item.value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {rows.length > 0 ? (
        <div className="space-y-3">
          <Table>
            <TableCaption className="sr-only">{t('enrichment_treg.tab.caption', 'Proposed field updates from treg')}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <span className="sr-only">{t('enrichment_treg.tab.select', 'Select')}</span>
                </TableHead>
                <TableHead>{t('enrichment_treg.tab.field', 'Field')}</TableHead>
                <TableHead>{t('enrichment_treg.tab.current', 'Current')}</TableHead>
                <TableHead>{t('enrichment_treg.tab.proposed', 'Proposed')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const fieldLabel = t(`enrichment_treg.fields.${row.field}`, row.field)
                return (
                  <TableRow key={row.field}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(row.field)}
                        disabled={row.identical || applying}
                        onCheckedChange={(checked) => toggleField(row.field, checked === true)}
                        aria-label={t('enrichment_treg.tab.selectField', 'Apply {field}', { field: fieldLabel })}
                      />
                    </TableCell>
                    <TableCell className="font-medium">{fieldLabel}</TableCell>
                    <TableCell className="text-muted-foreground">{row.current || '—'}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="break-words">{row.proposed}</span>
                        {row.identical ? (
                          <StatusBadge variant="neutral">{t('enrichment_treg.tab.same', 'same')}</StatusBadge>
                        ) : row.applied ? (
                          <StatusBadge variant="neutral">{t('enrichment_treg.tab.alreadyApplied', 'applied')}</StatusBadge>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          <div className="flex justify-end">
            <Button type="button" onClick={applySelected} disabled={applying || selected.size === 0}>
              {applying
                ? t('enrichment_treg.tab.applying', 'Saving…')
                : t('enrichment_treg.tab.apply', 'Apply selected ({count})', { count: selected.size })}
            </Button>
          </div>
        </div>
      ) : record.status === 'completed' ? (
        <p className="text-sm text-muted-foreground">
          {t('enrichment_treg.tab.nothingToApply', 'treg returned no fields that map to this record.')}
        </p>
      ) : null}
    </div>
  )
}
