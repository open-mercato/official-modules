"use client"

import * as React from 'react'
import { BriefcaseBusiness, ExternalLink, Newspaper, Radar } from 'lucide-react'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { formatDateTime, formatRelativeTime } from '@open-mercato/shared/lib/time'
import type { AppEventPayload } from '@open-mercato/shared/modules/widgets/injection'
import { apiCall, readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useAppEvent } from '@open-mercato/ui/backend/injection/useAppEvent'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { LoadingMessage } from '@open-mercato/ui/backend/detail'
import { Alert } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { Checkbox } from '@open-mercato/ui/primitives/checkbox'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'

type SignalKind = 'hiring' | 'news'

type SignalRefresh = {
  id: string
  status: 'pending' | 'running' | 'completed' | 'no_match' | 'failed'
  failureReason: string | null
  servedBy: string | null
  costMicro: number
  summary: Record<string, unknown> | null
  fetchedAt: string | null
  createdAt: string
}

type Signal = {
  id: string
  signalType: SignalKind
  title: string
  summary: string | null
  url: string | null
  location: string | null
  occurredAt: string | null
  source: string | null
  firstSeenAt: string
}

type SignalsResponse = {
  items: Signal[]
  total: number
  refreshes: Partial<Record<SignalKind, SignalRefresh | null>>
}

type SignalsSectionProps = {
  companyId: string
  context: Record<string, unknown>
}

const SIGNAL_KINDS: SignalKind[] = ['hiring', 'news']
const WORST_CASE_COST_MICRO_PER_KIND = 40_000
const RE_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000
const POLL_INTERVAL_MS = 2000
const POLL_MAX_ATTEMPTS = 45
const PAGE_SIZE = 50

const KIND_ICON: Record<SignalKind, React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>> = {
  hiring: BriefcaseBusiness,
  news: Newspaper,
}

const KIND_VARIANT: Record<SignalKind, StatusBadgeVariant> = {
  hiring: 'info',
  news: 'neutral',
}

function formatUsd(costMicro: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(costMicro / 1_000_000)
}

function isInFlight(refresh: SignalRefresh | null | undefined): boolean {
  return refresh?.status === 'pending' || refresh?.status === 'running'
}

function refreshedRecently(refresh: SignalRefresh | null | undefined, now: number): boolean {
  if (!refresh || (refresh.status !== 'completed' && refresh.status !== 'no_match')) return false
  const at = Date.parse(refresh.fetchedAt ?? refresh.createdAt)
  return Number.isFinite(at) && now - at < RE_REFRESH_WINDOW_MS
}

export default function SignalsSection({ companyId, context }: SignalsSectionProps) {
  const t = useT()
  const locale = useLocale()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [data, setData] = React.useState<SignalsResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [starting, setStarting] = React.useState(false)
  const [stalled, setStalled] = React.useState(false)
  const [kinds, setKinds] = React.useState<Set<SignalKind>>(new Set(SIGNAL_KINDS))
  const [filter, setFilter] = React.useState<SignalKind | 'all'>('all')
  const pollAttempts = React.useRef(0)

  const { runMutation } = useGuardedMutation<Record<string, unknown>>({
    contextId: `enrichment_treg:signals:${companyId}`,
  })

  const load = React.useCallback(async () => {
    setLoadError(null)
    try {
      const params = new URLSearchParams({ subjectId: companyId, pageSize: String(PAGE_SIZE) })
      const payload = await readApiResultOrThrow<SignalsResponse>(
        `/api/enrichment_treg/signals?${params.toString()}`,
        undefined,
        { errorMessage: t('enrichment_treg.signals.errors.load', 'Failed to load company signals.') },
      )
      setData(payload)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('enrichment_treg.signals.errors.load', 'Failed to load company signals.'))
    } finally {
      setLoading(false)
    }
  }, [companyId, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const reloadOnEvent = React.useCallback(
    (event: AppEventPayload) => {
      if (event.payload?.subjectId === companyId) void load()
    },
    [companyId, load],
  )
  useAppEvent('enrichment_treg.signal.*', reloadOnEvent, [reloadOnEvent])
  useAppEvent('enrichment_treg.record.*', reloadOnEvent, [reloadOnEvent])

  const inFlight = SIGNAL_KINDS.some((kind) => isInFlight(data?.refreshes?.[kind]))
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
      void load()
    }, POLL_INTERVAL_MS)
    return () => clearTimeout(timer)
  }, [data, inFlight, load])

  const toggleKind = React.useCallback((kind: SignalKind, checked: boolean) => {
    setKinds((previous) => {
      const next = new Set(previous)
      if (checked) next.add(kind)
      else next.delete(kind)
      return next
    })
  }, [])

  const startRefresh = React.useCallback(async () => {
    const selected = SIGNAL_KINDS.filter((kind) => kinds.has(kind))
    if (selected.length === 0) return
    const recent = selected.filter((kind) => refreshedRecently(data?.refreshes?.[kind], Date.now()))
    if (recent.length > 0) {
      const proceed = await confirm({
        title: t('enrichment_treg.signals.confirm.title', 'Refresh again?'),
        description: t(
          'enrichment_treg.signals.confirm.description',
          'These signals were refreshed in the last 24 hours. Another lookup costs money and rarely finds anything new.',
        ),
        confirmText: t('enrichment_treg.signals.confirm.action', 'Refresh anyway'),
      })
      if (!proceed) return
    }
    setStarting(true)
    try {
      const call = await runMutation({
        operation: () =>
          apiCall<{ records?: SignalRefresh[]; skipped?: Array<{ kind: SignalKind }>; error?: string }>(
            '/api/enrichment_treg/signals/refresh',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ subjectId: companyId, kinds: selected }),
            },
          ),
        mutationPayload: { subjectId: companyId, kinds: selected },
        context,
      })
      if (call.ok && call.result?.records) {
        if (call.result.skipped?.length) {
          flash(t('enrichment_treg.signals.skippedNews', 'News needs a company domain. Add one to look up news.'), 'info')
        }
        pollAttempts.current = 0
        setStalled(false)
        await load()
        return
      }
      const code = call.result?.error ?? 'unexpected'
      const fallback = t('enrichment_treg.signals.errors.unexpected', 'Signal refresh could not be started.')
      flash(t(`enrichment_treg.signals.errors.${code}`, t(`enrichment_treg.tab.errors.${code}`, fallback)), 'error')
    } catch {
      flash(t('enrichment_treg.signals.errors.unexpected', 'Signal refresh could not be started.'), 'error')
    } finally {
      setStarting(false)
    }
  }, [companyId, confirm, context, data, kinds, load, runMutation, t])

  const refreshNow = React.useCallback(() => {
    pollAttempts.current = 0
    setStalled(false)
    void load()
  }, [load])

  const items = React.useMemo(
    () => (data?.items ?? []).filter((item) => filter === 'all' || item.signalType === filter),
    [data, filter],
  )

  const busy = starting || (inFlight && !stalled)
  const estimate = formatUsd(WORST_CASE_COST_MICRO_PER_KIND * kinds.size, locale)

  return (
    <section className="space-y-4 border-t border-border pt-4" aria-labelledby={`treg-signals-${companyId}`}>
      {ConfirmDialogElement}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 id={`treg-signals-${companyId}`} className="flex items-center gap-2 text-sm font-semibold">
            <Radar className="size-4" aria-hidden />
            {t('enrichment_treg.signals.title', 'Company signals')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t('enrichment_treg.signals.description', 'Open roles and recent news about this company, found by treg.to.')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {SIGNAL_KINDS.map((kind) => (
            <label key={kind} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={kinds.has(kind)}
                disabled={busy}
                onCheckedChange={(checked) => toggleKind(kind, checked === true)}
              />
              {t(`enrichment_treg.signals.kind.${kind}`, kind)}
            </label>
          ))}
          <Button type="button" variant="outline" onClick={startRefresh} disabled={busy || kinds.size === 0}>
            <Radar className="size-4" aria-hidden />
            {busy
              ? t('enrichment_treg.signals.refreshing', 'Refreshing…')
              : t('enrichment_treg.signals.refresh', 'Refresh signals')}
          </Button>
        </div>
      </div>

      {kinds.size > 0 && !busy ? (
        <p className="text-xs text-muted-foreground">
          {t('enrichment_treg.signals.estimate', 'Up to {amount} per refresh. Lookups with no results are free.', { amount: estimate })}
        </p>
      ) : null}

      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
        {SIGNAL_KINDS.map((kind) => {
          const refresh = data?.refreshes?.[kind]
          const at = refresh?.fetchedAt ?? null
          return (
            <div key={kind} className="flex gap-1">
              <dt>{t(`enrichment_treg.signals.kind.${kind}`, kind)}:</dt>
              <dd title={at ? formatDateTime(at) ?? undefined : undefined}>
                {!refresh
                  ? t('enrichment_treg.signals.neverRefreshed', 'never refreshed')
                  : isInFlight(refresh)
                    ? t('enrichment_treg.status.running', 'Running')
                    : refresh.status === 'failed'
                      ? t('enrichment_treg.status.failed', 'Failed')
                      : refresh.status === 'no_match'
                        ? t('enrichment_treg.signals.nothingFound', 'nothing found {when}', { when: at ? formatRelativeTime(at, { locale }) ?? '' : '' })
                        : t('enrichment_treg.signals.refreshedAt', 'refreshed {when}', { when: at ? formatRelativeTime(at, { locale }) ?? '' : '' })}
              </dd>
            </div>
          )
        })}
      </dl>

      {SIGNAL_KINDS.map((kind) => {
        const refresh = data?.refreshes?.[kind]
        if (refresh?.status !== 'failed') return null
        return (
          <Alert key={kind} status="error" style="light" size="sm">
            {t('enrichment_treg.signals.failedKind', '{kind} lookup failed.', { kind: t(`enrichment_treg.signals.kind.${kind}`, kind) })}{' '}
            {t(
              `enrichment_treg.tab.failure.${refresh.failureReason ?? 'unexpected'}`,
              t('enrichment_treg.tab.failure.unexpected', 'The lookup failed. Try again later.'),
            )}
          </Alert>
        )
      })}

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

      {loadError ? (
        <Alert
          status="error"
          style="light"
          size="sm"
          action={
            <Button type="button" variant="outline" size="sm" onClick={refreshNow}>
              {t('enrichment_treg.tab.retry', 'Retry')}
            </Button>
          }
        >
          {loadError}
        </Alert>
      ) : null}

      {loading ? (
        <LoadingMessage label={t('enrichment_treg.signals.loading', 'Loading signals…')} />
      ) : (data?.items.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('enrichment_treg.signals.empty', 'No signals yet. Refresh to look up open roles and recent news.')}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('enrichment_treg.signals.filterLabel', 'Filter signals')}>
            {(['all', ...SIGNAL_KINDS] as const).map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={filter === value ? 'default' : 'outline'}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {value === 'all'
                  ? t('enrichment_treg.signals.filterAll', 'All ({count})', { count: data?.items.length ?? 0 })
                  : `${t(`enrichment_treg.signals.kind.${value}`, value)} (${data?.items.filter((item) => item.signalType === value).length ?? 0})`}
              </Button>
            ))}
          </div>
          <ul className="divide-y divide-border rounded-md border border-border">
            {items.map((item) => {
              const Icon = KIND_ICON[item.signalType]
              const when = item.occurredAt ?? item.firstSeenAt
              return (
                <li key={item.id} className="flex gap-3 p-3">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {item.url ? (
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
                        >
                          <span className="break-words">{item.title}</span>
                          <ExternalLink className="size-3 shrink-0" aria-hidden />
                        </a>
                      ) : (
                        <span className="break-words text-sm font-medium">{item.title}</span>
                      )}
                      <StatusBadge variant={KIND_VARIANT[item.signalType]}>
                        {t(`enrichment_treg.signals.kind.${item.signalType}`, item.signalType)}
                      </StatusBadge>
                    </div>
                    {item.summary && item.summary !== item.title ? (
                      <p className="line-clamp-2 text-xs text-muted-foreground">{item.summary}</p>
                    ) : null}
                    <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                      <span title={formatDateTime(when) ?? undefined}>{formatRelativeTime(when, { locale })}</span>
                      {item.location ? <span>{item.location}</span> : null}
                      {item.source ? <span>{t('enrichment_treg.tab.servedBy', 'via {provider}', { provider: item.source })}</span> : null}
                    </p>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}
