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

/** One corrected-invoice reference → FA(3) `DaneFaKorygowanej`. */
export const fa3CorrectionReferenceSchema = z.object({
  correctedIssueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  correctedInvoiceNumber: z.string().min(1).max(256),
  /** The corrected invoice's KSeF number; absent ⇒ original issued outside KSeF (NrKSeFN). */
  correctedKsefNumber: z.string().min(1).max(64).optional(),
})

/** FA(3) correction block, required when `invoiceKind === 'KOR'`. */
export const fa3CorrectionSchema = z.object({
  reason: z.string().min(1).max(1000).optional(),
  /** TypKorekty: 1 = original-date effect, 2 = correction-date effect, 3 = other/mixed. */
  correctionType: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  correctedInvoices: z.array(fa3CorrectionReferenceSchema).min(1),
  period: z.string().min(1).max(256).optional(),
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
    invoiceKind: z.enum(['VAT', 'KOR', 'ZAL', 'ROZ', 'UPR', 'KOR_ZAL', 'KOR_ROZ']).optional(),
    seller: fa3PartySchema,
    buyer: fa3PartySchema,
    vatBreakdown: z.array(fa3VatEntrySchema).min(1),
    totalGross: moneySchema,
    lines: z.array(fa3LineSchema).min(1),
    annotations: fa3AnnotationsSchema.optional(),
    /** Required iff invoiceKind === 'KOR' (correction). Forbidden otherwise. */
    correction: fa3CorrectionSchema.optional(),
  })
  // Send scope, enforced on the schema so BOTH the direct `POST /ksef/submissions`
  // (explicit FA(3) payload) path and the resolvers' final parse reject anything the
  // serializer cannot faithfully emit. Supported kinds: VAT (standard) and KOR
  // (correction). ZAL/ROZ/UPR and the advance/settlement-correction variants
  // (KOR_ZAL/KOR_ROZ) still need advance/settlement blocks that do not exist yet; a
  // non-PLN currency needs KursWaluty + PLN VAT; a VAT rate must map to an FA(3) `P_13_x`.
  .superRefine((invoice, ctx) => {
    const kind = invoice.invoiceKind ?? 'VAT'
    if (kind !== 'VAT' && kind !== 'KOR') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['invoiceKind'],
        message: 'Only standard VAT invoices and corrections (KOR) can be submitted to KSeF yet (ZAL/ROZ/UPR/KOR_ZAL/KOR_ROZ unsupported).',
      })
    }
    // The correction block is required for a KOR and forbidden for a non-correction,
    // so the serializer never emits a DaneFaKorygowanej without a RodzajFaktury=KOR
    // (or a KOR without its mandatory corrected-invoice reference).
    if (kind === 'KOR' && !invoice.correction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['correction'],
        message: 'A correction (KOR) invoice requires the correction block referencing the corrected invoice.',
      })
    }
    if (kind !== 'KOR' && invoice.correction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['correction'],
        message: 'The correction block is only valid for a KOR (correction) invoice.',
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

export const ksefSubmissionDocumentKindSchema = z.enum(['invoice', 'credit_memo'])

export const ksefSubmissionSendSchema = z.object({
  organizationId: z.string().uuid().optional(),
  tenantId: z.string().uuid().optional(),
  // For an invoice submission: the invoice id. For a correction: the CORRECTED original invoice id.
  salesInvoiceId: z.string().uuid(),
  // Discriminates a standard invoice from a correction (credit memo → FA(3) KOR). Default 'invoice'.
  documentKind: ksefSubmissionDocumentKindSchema.optional(),
  // The credit memo id; required (and only set) when documentKind === 'credit_memo'.
  creditMemoId: z.string().uuid().optional(),
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

export const sendFromCreditMemoSchema = z.object({
  creditMemoId: z.string().uuid(),
  /** Confirm the corrected ORIGINAL invoice was lawfully issued outside KSeF (→ NrKSeFN). */
  originalOutsideKsef: z.boolean().optional(),
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
export type Fa3CorrectionInput = z.infer<typeof fa3CorrectionSchema>
export type Fa3InvoiceInput = z.infer<typeof fa3InvoiceSchema>
export type KsefSubmissionSendInput = z.infer<typeof ksefSubmissionSendSchema>
export type KsefSubmissionRetryInput = z.infer<typeof ksefSubmissionRetrySchema>
export type SendFromInvoiceInput = z.infer<typeof sendFromInvoiceSchema>
export type SendFromCreditMemoInput = z.infer<typeof sendFromCreditMemoSchema>
export type KsefSubmissionListQuery = z.infer<typeof ksefSubmissionListQuerySchema>
