import { z } from 'zod'
import { isValidPolishNip } from '@open-mercato/shared/lib/pl/validation'
import { isMappedFa3VatRate } from '../lib/fa3'

// 10 digits AND a valid NIP checksum, so a malformed NIP is rejected with a clear 422
// before send rather than silently dropped into a `<BrakID>` filing or bounced by KSeF.
const nipSchema = z
  .string()
  .regex(/^[0-9]{10}$/, 'NIP must be 10 digits')
  .refine((value) => isValidPolishNip(value), 'NIP checksum is invalid')
const vatRateSchema = z.union([z.number(), z.enum(['zw', 'np', 'oo'])])
const moneySchema = z.string().regex(/^-?\d+(\.\d{1,2})?$/, 'Amount must be a decimal with up to 2 fraction digits')

// FA(3) XSD string maxima: party Nazwa and the two address lines (AdresL1/AdresL2)
// are bounded at 512 chars. Enforcing them here raises a localized 422 before send
// rather than letting KSeF reject the document with a maxLength schema error.
export const fa3PartySchema = z.object({
  nip: nipSchema.optional(),
  euVatId: z.string().min(3).max(20).optional(),
  name: z.string().min(1).max(512),
  countryCode: z.string().length(2).default('PL'),
  addressLine1: z.string().min(1).max(512),
  addressLine2: z.string().max(512).optional(),
})

export const fa3VatEntrySchema = z.object({
  rate: vatRateSchema,
  net: moneySchema,
  vat: moneySchema,
})

/**
 * FA(3) `Adnotacje` flags carried through from the invoice's Polish VAT metadata.
 * All optional/additive — an absent `annotations` block reproduces the prior
 * schema-minimal defaults (every marker "does not apply").
 */
export const fa3AnnotationsSchema = z.object({
  /** Split-payment mechanism (mechanizm podzielonej płatności) → FA(3) field P_18A. */
  splitPayment: z.boolean().optional(),
  /** Reverse charge (odwrotne obciążenie) → FA(3) field P_18. */
  reverseCharge: z.boolean().optional(),
  /** VAT exemption legal basis → FA(3) Zwolnienie/P_19 + P_19C (free-text basis). */
  vatExemptionBasis: z.string().min(1).optional(),
})

export const fa3LineSchema = z.object({
  lineNumber: z.number().int().positive(),
  name: z.string().min(1).max(256),
  unit: z.string().max(256).optional(),
  quantity: z.string().min(1),
  unitNetPrice: moneySchema,
  netValue: moneySchema,
  vatRate: vatRateSchema,
})

export const fa3InvoiceSchema = z
  .object({
    invoiceNumber: z.string().min(1).max(256),
    issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    saleDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    currencyCode: z.string().length(3).default('PLN').transform((value) => value.toUpperCase()),
    invoiceKind: z.enum(['VAT', 'KOR', 'ZAL', 'ROZ', 'UPR']).optional(),
    seller: fa3PartySchema,
    buyer: fa3PartySchema,
    vatBreakdown: z.array(fa3VatEntrySchema).min(1),
    totalGross: moneySchema,
    lines: z.array(fa3LineSchema).min(1),
    annotations: fa3AnnotationsSchema.optional(),
  })
  // E1 send scope, enforced on the schema so BOTH the direct `POST /ksef/submissions`
  // (explicit FA(3) payload) path and the resolver's final parse reject anything the
  // structurally-minimal serializer cannot faithfully emit: a non-VAT kind
  // (KOR/ZAL/ROZ/UPR need correction/advance/settlement blocks), a non-PLN currency
  // (needs KursWaluty + PLN VAT), or a VAT rate with no FA(3) `P_13_x` mapping.
  .superRefine((invoice, ctx) => {
    if (invoice.invoiceKind && invoice.invoiceKind !== 'VAT') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invoiceKind'],
        message: 'Only standard VAT invoices can be submitted to KSeF yet (KOR/ZAL/ROZ/UPR unsupported).',
      })
    }
    if (invoice.currencyCode.toUpperCase() !== 'PLN') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currencyCode'],
        message: 'Only PLN invoices can be submitted to KSeF yet.',
      })
    }
    invoice.vatBreakdown.forEach((entry, index) => {
      if (!isMappedFa3VatRate(entry.rate)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['vatBreakdown', index, 'rate'],
          message: 'Unsupported VAT rate for KSeF FA(3).',
        })
      }
    })
    invoice.lines.forEach((line, index) => {
      if (!isMappedFa3VatRate(line.vatRate)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', index, 'vatRate'],
          message: 'Unsupported VAT rate for KSeF FA(3).',
        })
      }
    })
  })

export const ksefEnvironmentSchema = z.enum(['test', 'demo', 'prod'])

export const ksefSubmissionSendSchema = z.object({
  organizationId: z.string().uuid().optional(),
  tenantId: z.string().uuid().optional(),
  salesInvoiceId: z.string().uuid(),
  contextNip: nipSchema,
  environment: ksefEnvironmentSchema.optional(),
  invoice: fa3InvoiceSchema,
})

export const ksefSubmissionRetrySchema = z.object({
  id: z.string().uuid(),
})

export const sendFromInvoiceSchema = z.object({
  salesInvoiceId: z.string().uuid(),
})

export const ksefSubmissionListQuerySchema = z.object({
  ids: z.string().optional(),
  salesInvoiceId: z.string().uuid().optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
})

export type Fa3PartyInput = z.infer<typeof fa3PartySchema>
export type Fa3AnnotationsInput = z.infer<typeof fa3AnnotationsSchema>
export type Fa3InvoiceInput = z.infer<typeof fa3InvoiceSchema>
export type KsefSubmissionSendInput = z.infer<typeof ksefSubmissionSendSchema>
export type KsefSubmissionRetryInput = z.infer<typeof ksefSubmissionRetrySchema>
export type SendFromInvoiceInput = z.infer<typeof sendFromInvoiceSchema>
export type KsefSubmissionListQuery = z.infer<typeof ksefSubmissionListQuerySchema>
