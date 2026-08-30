'use client'

import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'

/** The invoice an email is being composed for. `null` = dialog closed. */
export type InvoiceEmailTarget = { id: string; invoiceNumber: string }

type InvoiceEmailResponse = { ok?: boolean; code?: string; error?: string }

// KSeF invoices carry no buyer email (buyers are identified by NIP), so the recipient is entered by
// hand — validate it client-side before hitting the endpoint.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type InvoiceEmailDialogProps = {
  target: InvoiceEmailTarget | null
  onClose: () => void
}

/**
 * Compose-and-send dialog for emailing an invoice PDF. The PDF is attached server-side; this surface
 * only collects recipient/subject/message. Delivery runs through the invoice-email endpoint, which
 * currently reports `EMAIL_NOT_CONFIGURED` / `EMAIL_SEND_NOT_IMPLEMENTED` until a transport is wired —
 * both are surfaced as a non-alarming info message rather than an error.
 */
export function InvoiceEmailDialog({ target, onClose }: InvoiceEmailDialogProps) {
  const t = useT()
  const [to, setTo] = React.useState('')
  const [subject, setSubject] = React.useState('')
  const [message, setMessage] = React.useState('')
  const [sending, setSending] = React.useState(false)

  // Seed subject / clear fields whenever a new invoice opens the dialog.
  React.useEffect(() => {
    if (!target) return
    setTo('')
    setMessage('')
    setSubject(
      t('financial_pl.invoices.email.defaultSubject', 'Invoice {number}', { number: target.invoiceNumber }),
    )
  }, [target, t])

  const open = target !== null

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next && !sending) onClose()
    },
    [onClose, sending],
  )

  const handleSend = React.useCallback(async () => {
    if (!target) return
    const recipient = to.trim()
    if (!EMAIL_PATTERN.test(recipient)) {
      flash(t('financial_pl.invoices.email.invalidRecipient', 'Enter a valid email address.'), 'error')
      return
    }
    setSending(true)
    try {
      const call = await apiCall<InvoiceEmailResponse>('/api/financial_pl/ksef/invoice-email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          salesInvoiceId: target.id,
          to: recipient,
          subject: subject.trim(),
          message: message.trim() || undefined,
        }),
      })
      if (call.ok && call.result?.ok) {
        flash(t('financial_pl.invoices.email.success', 'Invoice sent to {to}.', { to: recipient }), 'success')
        onClose()
        return
      }
      const code = call.result?.code
      if (code === 'EMAIL_NOT_CONFIGURED' || code === 'EMAIL_SEND_NOT_IMPLEMENTED') {
        flash(
          t('financial_pl.invoices.email.notConfigured', 'Email delivery is not configured in this environment.'),
          'info',
        )
        return
      }
      flash(t('financial_pl.invoices.email.error', 'Failed to send the invoice.'), 'error')
    } catch {
      flash(t('financial_pl.invoices.email.error', 'Failed to send the invoice.'), 'error')
    } finally {
      setSending(false)
    }
  }, [message, onClose, subject, t, target, to])

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void handleSend()
      }
    },
    [handleSend],
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle>{t('financial_pl.invoices.email.title', 'Email invoice')}</DialogTitle>
          <DialogDescription>
            {t('financial_pl.invoices.email.attachmentNote', 'The invoice PDF will be attached.')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invoice-email-to">
              {t('financial_pl.invoices.email.recipient', 'Recipient email')}
            </Label>
            <Input
              id="invoice-email-to"
              type="email"
              autoFocus
              value={to}
              onChange={(event) => setTo(event.target.value)}
              placeholder={t('financial_pl.invoices.email.recipientPlaceholder', 'e.g. billing@customer.com')}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invoice-email-subject">
              {t('financial_pl.invoices.email.subject', 'Subject')}
            </Label>
            <Input
              id="invoice-email-subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invoice-email-message">
              {t('financial_pl.invoices.email.message', 'Message (optional)')}
            </Label>
            <Textarea
              id="invoice-email-message"
              rows={4}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={t('financial_pl.invoices.email.messagePlaceholder', 'A short note to the recipient…')}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            {t('financial_pl.invoices.email.cancel', 'Cancel')}
          </Button>
          <Button
            onClick={() => {
              void handleSend()
            }}
            disabled={sending}
          >
            {sending
              ? t('financial_pl.invoices.email.sending', 'Sending…')
              : t('financial_pl.invoices.email.send', 'Send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default InvoiceEmailDialog
