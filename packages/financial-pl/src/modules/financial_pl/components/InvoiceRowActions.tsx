'use client'

import * as React from 'react'
import Link from 'next/link'
import { MoreHorizontal, type LucideIcon } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@open-mercato/ui/primitives/popover'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Button } from '@open-mercato/ui/primitives/button'
import { cn } from '@open-mercato/shared/lib/utils'
import { useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * One row-action entry. Mirrors the DS `RowActionItem` contract plus a leading Lucide `icon` — the
 * shared `RowActions` component has no icon slot, so invoice rows use this local, DS-primitive menu
 * (Popover + Button) to render icons while keeping every item on the same padding/height rhythm.
 */
export type InvoiceRowAction = {
  id: string
  label: string
  icon: LucideIcon
  href?: string
  onSelect?: () => void
  destructive?: boolean
}

// Single item recipe (matches the DS perspectives menu): ghost Button, left-aligned, icon + label.
const ITEM_CLASS = 'w-full shrink-0 justify-start h-auto gap-2 px-2 py-1.5 text-sm font-normal'

export function InvoiceRowActions({ items }: { items: InvoiceRowAction[] }) {
  const t = useT()
  const [open, setOpen] = React.useState(false)

  // Close on any scroll: the trigger lives in the sticky actions column, and Radix keeps the popover
  // anchored to it, so scrolling makes the menu jump around. Closing it is the cleaner behavior.
  React.useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('scroll', close, true)
    return () => window.removeEventListener('scroll', close, true)
  }, [open])

  if (!items.length) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          type="button"
          variant="ghost"
          aria-label={t('ui.rowActions.openActions', 'Open actions')}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex w-max min-w-32 flex-col p-1"
        onClick={(event) => event.stopPropagation()}
      >
        {items.map((item) => {
          const Icon = item.icon
          const body = (
            <>
              <Icon
                className={cn('size-4 shrink-0', item.destructive ? '' : 'text-muted-foreground')}
                aria-hidden="true"
              />
              <span className="whitespace-nowrap">{item.label}</span>
            </>
          )
          const className = cn(ITEM_CLASS, item.destructive && 'text-destructive')
          return item.href ? (
            <Button key={item.id} asChild variant="ghost" size="sm" className={className}>
              <Link href={item.href} onClick={() => setOpen(false)}>
                {body}
              </Link>
            </Button>
          ) : (
            <Button
              key={item.id}
              type="button"
              variant="ghost"
              size="sm"
              className={className}
              onClick={() => {
                setOpen(false)
                item.onSelect?.()
              }}
            >
              {body}
            </Button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

export default InvoiceRowActions
