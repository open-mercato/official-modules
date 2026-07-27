'use client'

import * as React from 'react'

/**
 * Card shell used by every section across the Financials (PL) screens.
 *
 * Extracted from the invoice form once a second and third screen needed the same treatment: the
 * headings had started as bare 14px text floating above the first field, indistinguishable from a
 * field label. A ruled header band with a leading icon separates "what this card is" from "what you
 * type", and keeping one component means the screens cannot drift apart again.
 */
export function FormSection({
  icon,
  title,
  description,
  actions,
  className,
  bodyClassName,
  children,
}: {
  icon: React.ReactNode
  title: string
  /** Optional one-line explanation under the title. */
  description?: string
  /** Optional controls pinned to the right of the header band. */
  actions?: React.ReactNode
  className?: string
  bodyClassName?: string
  children: React.ReactNode
}) {
  return (
    <section className={`overflow-hidden rounded-lg border bg-card ${className ?? ''}`}>
      <header className="flex items-start gap-2 border-b border-border/60 bg-muted/30 px-4 py-2.5">
        <span aria-hidden="true" className="mt-0.5 text-muted-foreground">
          {icon}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="text-[15px] font-semibold leading-none text-foreground">{title}</h3>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </header>
      <div className={bodyClassName ?? 'space-y-3 p-4'}>{children}</div>
    </section>
  )
}

export default FormSection
