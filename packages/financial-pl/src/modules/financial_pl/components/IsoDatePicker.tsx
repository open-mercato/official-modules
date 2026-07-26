'use client'

import * as React from 'react'
import { DatePicker } from '@open-mercato/ui/primitives/date-picker'
import { de as deLocale, enUS, es as esLocale, pl as plLocale } from 'date-fns/locale'
import { useLocale } from '@open-mercato/shared/lib/i18n/context'

const DATE_LOCALES = { pl: plLocale, en: enUS, de: deLocale, es: esLocale } as const

/** Polish invoices are read in `dd.mm.yyyy`; the ISO form is a storage detail. */
export const PL_DATE_DISPLAY_FORMAT = 'dd.MM.yyyy'

/** `Date` → `yyyy-mm-dd` in LOCAL time; `toISOString()` can shift the day across a timezone. */
export function toIsoDateLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parseIsoDate(raw: string | null | undefined): Date | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  const parsed = new Date(`${text}T00:00:00`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export type IsoDatePickerProps = {
  id?: string
  /** `yyyy-mm-dd`, or empty. */
  value: string | null | undefined
  onChange: (next: string) => void
  disabled?: boolean
  className?: string
  'aria-invalid'?: boolean
  'aria-label'?: string
}

/**
 * DS `DatePicker` speaking the `yyyy-mm-dd` strings the invoice payloads carry.
 *
 * Several fields still used a bare `<input type="date">`, which renders the BROWSER's calendar —
 * its own blue accent and its own "Dzisiaj / Wyczyść" footer — inside a form built entirely from
 * the design system. This wrapper exists so the conversion is done once rather than repeated (and
 * drifted) at every call site.
 */
export function IsoDatePicker({
  id,
  value,
  onChange,
  disabled,
  className,
  'aria-invalid': ariaInvalid,
  'aria-label': ariaLabel,
}: IsoDatePickerProps) {
  const locale = useLocale()
  const dateLocale = DATE_LOCALES[locale as keyof typeof DATE_LOCALES] ?? plLocale
  return (
    <DatePicker
      id={id}
      value={parseIsoDate(value)}
      onChange={(next) => onChange(next ? toIsoDateLocal(next) : '')}
      disabled={disabled}
      displayFormat={PL_DATE_DISPLAY_FORMAT}
      locale={dateLocale}
      className={className}
      aria-invalid={ariaInvalid}
      aria-label={ariaLabel}
    />
  )
}

export default IsoDatePicker
