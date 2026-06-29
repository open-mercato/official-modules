import { z } from 'zod'
import { isValidPolishNip } from '../lib/nip'
import { isMappedFa3VatRate } from '../lib/fa3'
import { isStructurallyValidKsefNumber } from '../lib/ksef-number'
import { GTU_CODES, JPK_PROCEDURE_MARKINGS, JPK_TYP_DOKUMENTU, type JpkProcedureMarking } from '../lib/jpk-markings-codes'
import type { AdvanceInvoiceRef, AdvancePaymentSnapshot, InvoiceKindColumn, OrderSnapshot } from './entities'

// 10 digits AND a valid NIP checksum, so a malformed NIP is rejected with a clear 422
// before send rather than silently dropped into a `<BrakID>` filing or bounced by KSeF.
const nipSchema = z
  .string()
  .regex(/^[0-9]{10}$/, 'NIP must be 10 digits')
  .refine((value) => isValidPolishNip(value), 'NIP checksum is invalid')
const vatRateSchema = z.union([z.number(), z.enum(['zw', 'np', 'oo'])])
const moneySchema = z.string().regex(/^-?\d+(\.\d{1,2})?$/, 'Amount must be a decimal with up to 2 fraction digits')

// FA(3) simplified-invoice (UPR) statutory threshold: total ≤ 450 PLN (art. 106e ust. 5 pkt 3).
// An EUR/OSS invoice is PLN-converted via the resolved rate for the threshold check, or
// compared against ≤ 100 EUR when no rate is resolvable for a pure-OSS EUR document.
export const UPR_THRESHOLD_PLN = 450
export const UPR_THRESHOLD_EUR = 100

// FA(3) XSD string maxima: party Nazwa and the two address lines (AdresL1/AdresL2)
// are bounded at 512 chars. Enforcing them here raises a localized 422 before send
// rather than letting KSeF reject the document with a maxLength schema error.
// `name` and `addressLine1` are schema-optional so a UPR (simplified-invoice) buyer may carry a
// NIP-only identity (no Nazwa/Adres). For every other document kind both are REQUIRED — that is
// enforced per-kind in `fa3InvoiceSchema`'s superRefine (seller always required; non-UPR buyer
// required), so a standard VAT/KOR invoice still rejects a nameless/addressless party.
export const fa3PartySchema = z.object({
  nip: nipSchema.optional(),
  euVatId: z.string().min(3).max(20).optional(),
  name: z.string().min(1).max(512).optional(),
  countryCode: z.string().length(2).default('PL'),
  addressLine1: z.string().min(1).max(512).optional(),
  addressLine2: z.string().max(512).optional(),
})

// VAT-summary bucket. `rate` accepts the synthetic `'oss'` key (the single P_13_5/P_14_5
// OSS / WSTO_EE bucket) in addition to the Polish rates; `vatPln` is the PLN-converted output
// VAT (`P_14_xW`, art. 106e ust. 11) emitted for a Polish-rate bucket on a foreign-currency
// invoice. The OSS bucket never carries a `W` variant.
const vatBucketKeySchema = z.union([z.number(), z.enum(['zw', 'np', 'oo', 'oss'])])
export const fa3VatEntrySchema = z.object({
  rate: vatBucketKeySchema,
  net: moneySchema,
  vat: moneySchema,
  vatPln: moneySchema.optional(),
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
  /** Self-billing (samofakturowanie, art. 106d) → FA(3) field P_17. */
  selfBilling: z.boolean().optional(),
})

/** One corrected-invoice reference → FA(3) `DaneFaKorygowanej`. */
export const fa3CorrectionReferenceSchema = z.object({
  correctedIssueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  correctedInvoiceNumber: z.string().min(1).max(256),
  /**
   * The corrected invoice's KSeF number; absent ⇒ original issued outside KSeF (NrKSeFN).
   * Structurally validated (35-char `TNumerKSeF` layout, hyphenated or bare) so a malformed
   * stored number is rejected here with a clear 422 instead of being bounced by KSeF (450).
   */
  correctedKsefNumber: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => isStructurallyValidKsefNumber(value), 'Corrected invoice KSeF number is structurally invalid')
    .optional(),
})

/** FA(3) correction block, required when `invoiceKind === 'KOR'`. */
export const fa3CorrectionSchema = z.object({
  reason: z.string().min(1).max(1000).optional(),
  /** TypKorekty: 1 = original-date effect, 2 = correction-date effect, 3 = other/mixed. */
  correctionType: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  correctedInvoices: z.array(fa3CorrectionReferenceSchema).min(1),
  period: z.string().min(1).max(256).optional(),
  /**
   * P_15ZK — for KOR_ZAL/KOR_ROZ, the payment amount (ZAL) / amount-remaining (ROZ) before the
   * correction. Required for KOR_ZAL/KOR_ROZ (enforced per-kind in `fa3InvoiceSchema`).
   */
  preCorrectionPaymentAmount: moneySchema.optional(),
  /** KursWalutyZK — FX rate accompanying `P_15ZK` for a foreign-currency correction. */
  preCorrectionFxRate: z.string().min(1).optional(),
})

export const fa3LineSchema = z.object({
  lineNumber: z.number().int().positive(),
  name: z.string().min(1).max(256),
  unit: z.string().max(256).optional(),
  quantity: z.string().min(1),
  unitNetPrice: moneySchema,
  netValue: moneySchema,
  vatRate: vatRateSchema,
  /**
   * OSS / WSTO_EE destination-country VAT rate as a decimal string (e.g. '19' for DE 19%). When
   * set, the line is an OSS line: `P_12` is omitted and `P_12_XII` + `Procedura=WSTO_EE` are
   * emitted instead. The closed Polish `vatRate` is then NOT mapped to a `P_13_x` bucket.
   */
  ossRate: z.string().min(1).optional(),
  /** Line procedure marker. Only `WSTO_EE` (OSS) is FA(3)-native at the line level. */
  procedure: z.literal('WSTO_EE').optional(),
  /** Foreign-currency exchange rate to PLN (→ `KursWaluty`) for an FX invoice. */
  fxRate: z.string().min(1).optional(),
})

/** One ordered position inside the FA(3) `Zamowienie` block (ZAL / KOR_ZAL). */
export const fa3OrderLineSchema = z.object({
  lineNumber: z.number().int().positive(),
  name: z.string().min(1).max(256).optional(),
  unit: z.string().max(256).optional(),
  quantity: z.string().min(1).optional(),
  unitNetPrice: moneySchema.optional(),
  netValue: moneySchema.optional(),
  vatValue: moneySchema.optional(),
  vatRate: vatRateSchema.optional(),
  gtu: z.string().min(1).max(16).optional(),
  stanPrzed: z.boolean().optional(),
})

/** The FA(3) `Zamowienie` (order) block carried by an advance (ZAL / KOR_ZAL). */
export const fa3OrderSchema = z.object({
  totalValue: moneySchema,
  lines: z.array(fa3OrderLineSchema).min(1),
})

/** A received-advance payment row → FA(3) `ZaliczkaCzesciowa` (ZAL). */
export const fa3AdvancePaymentSchema = z.object({
  receivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: moneySchema,
  fxRate: z.string().min(1).optional(),
})

/**
 * A reference to a prior advance invoice → FA(3) `FakturaZaliczkowa` (ROZ). A KSeF-issued advance
 * carries `ksefNumber` (→ `NrKSeFFaZaliczkowej`); an outside-KSeF advance carries `invoiceNumber`
 * (→ `NrKSeFZN=1` + `NrFaZaliczkowej`). At least one of the two must be present.
 */
export const fa3AdvanceRefSchema = z
  .object({
    ksefNumber: z
      .string()
      .min(1)
      .max(64)
      .refine((value) => isStructurallyValidKsefNumber(value), 'Advance invoice KSeF number is structurally invalid')
      .optional(),
    invoiceNumber: z.string().min(1).max(256).optional(),
  })
  .refine((ref) => Boolean(ref.ksefNumber) || Boolean(ref.invoiceNumber), {
    message: 'An advance reference requires either a KSeF number or an invoice number.',
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
    // FaWiersz is optional for an advance (ZAL / KOR_ZAL) that carries its detail in the
    // `order` block instead; every other kind requires at least one line — enforced per-kind
    // in the superRefine below.
    lines: z.array(fa3LineSchema),
    annotations: fa3AnnotationsSchema.optional(),
    /** Required for the correction kinds (KOR / KOR_ZAL / KOR_ROZ). Forbidden otherwise. */
    correction: fa3CorrectionSchema.optional(),
    /** FA(3) `Zamowienie` order block — required for an advance (ZAL / KOR_ZAL). */
    order: fa3OrderSchema.optional(),
    /** FA(3) `ZaliczkaCzesciowa` received-advance payments documented by a ZAL invoice. */
    advancePayments: z.array(fa3AdvancePaymentSchema).optional(),
    /** FA(3) `FakturaZaliczkowa` references to the prior advances netted by a ROZ settlement. */
    advanceInvoiceRefs: z.array(fa3AdvanceRefSchema).optional(),
    /** Self-billing (art. 106d) shortcut; folded into `annotations.selfBilling` (P_17). */
    selfBilling: z.boolean().optional(),
    /**
     * Resolved exchange rate to PLN for a foreign-currency invoice. Required when a non-PLN
     * invoice carries any Polish-rate (domestic) bucket needing the PLN-converted `P_14_xW`
     * (art. 106e ust. 11); a pure-OSS FX invoice needs no rate (jury resolution 1).
     */
    exchangeRate: z.string().min(1).optional(),
  })
  // Send scope, enforced on the schema so BOTH the direct `POST /ksef/submissions`
  // (explicit FA(3) payload) path and the resolvers' final parse reject anything the
  // serializer cannot faithfully emit. SPEC-009 replaced the blanket VAT/KOR-only and
  // PLN-only gates with PER-KIND requirement checks and a foreign-currency-with-rate path:
  // every `RodzajFaktury` value (VAT/KOR/ZAL/ROZ/UPR/KOR_ZAL/KOR_ROZ) is now serializable
  // once its required blocks are present; OSS / WSTO_EE lines and pure-OSS foreign currency
  // are accepted; only genuinely-unsupported combinations are rejected.
  .superRefine((invoice, ctx) => {
    const kind = invoice.invoiceKind ?? 'VAT'
    const isCorrectionKind = kind === 'KOR' || kind === 'KOR_ZAL' || kind === 'KOR_ROZ'

    // --- Per-kind structural requirements ---------------------------------------------------
    // ZAL / KOR_ZAL: the order (Zamowienie) block is required; FaWiersz is optional (the
    // detail lives in the order block instead).
    if ((kind === 'ZAL' || kind === 'KOR_ZAL') && !invoice.order) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['order'],
        message: 'An advance invoice (ZAL/KOR_ZAL) requires the order (Zamowienie) block.',
      })
    }
    // ROZ: a settlement nets and references prior advances (FakturaZaliczkowa) and carries the
    // full FaWiersz detail.
    if (kind === 'ROZ') {
      if (!invoice.advanceInvoiceRefs || invoice.advanceInvoiceRefs.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['advanceInvoiceRefs'],
          message: 'A settlement invoice (ROZ) requires references to the prior advance invoices.',
        })
      }
      if (invoice.lines.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines'],
          message: 'A settlement invoice (ROZ) requires at least one line (FaWiersz).',
        })
      }
    }
    // Every kind EXCEPT an advance carrying its order block requires at least one FaWiersz.
    const advanceWithOrder = (kind === 'ZAL' || kind === 'KOR_ZAL') && Boolean(invoice.order)
    if (!advanceWithOrder && invoice.lines.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lines'],
        message: 'An invoice requires at least one line (FaWiersz).',
      })
    }

    // --- Correction block --------------------------------------------------------------------
    if (isCorrectionKind && !invoice.correction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['correction'],
        message: 'A correction invoice (KOR/KOR_ZAL/KOR_ROZ) requires the correction block referencing the corrected invoice.',
      })
    }
    if (!isCorrectionKind && invoice.correction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['correction'],
        message: 'The correction block is only valid for a correction (KOR/KOR_ZAL/KOR_ROZ) invoice.',
      })
    }
    // KOR_ZAL/KOR_ROZ carry the correction-tail pre-correction amount (P_15ZK).
    if ((kind === 'KOR_ZAL' || kind === 'KOR_ROZ') && invoice.correction?.preCorrectionPaymentAmount === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['correction', 'preCorrectionPaymentAmount'],
        message: 'An advance/settlement correction (KOR_ZAL/KOR_ROZ) requires the pre-correction payment amount (P_15ZK).',
      })
    }

    // --- Party identity (UPR allows a NIP-only buyer) ---------------------------------------
    // The seller (Podmiot1) always requires a real name + address.
    if (!invoice.seller.name || !invoice.seller.addressLine1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['seller'],
        message: 'The seller (Podmiot1) requires a name and address.',
      })
    }
    // A UPR (simplified) buyer may be NIP-only (no Nazwa/Adres); it then requires a NIP. Every
    // other kind requires the buyer's name + address.
    if (kind === 'UPR') {
      const nipOnly = !invoice.buyer.name || !invoice.buyer.addressLine1
      if (nipOnly && !invoice.buyer.nip) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['buyer'],
          message: 'A simplified-invoice (UPR) buyer must carry at least a NIP when name/address are omitted.',
        })
      }
    } else if (!invoice.buyer.name || !invoice.buyer.addressLine1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['buyer'],
        message: 'The buyer (Podmiot2) requires a name and address.',
      })
    }

    // --- UPR threshold (art. 106e ust. 5 pkt 3) ---------------------------------------------
    // ≤ 450 PLN; an EUR invoice is PLN-converted via the resolved rate, or compared ≤ 100 EUR
    // when no rate is resolvable for a pure-OSS EUR document.
    if (kind === 'UPR') {
      const gross = Number(invoice.totalGross)
      if (Number.isFinite(gross)) {
        const currency = invoice.currencyCode.toUpperCase()
        const rate = invoice.exchangeRate ? Number(invoice.exchangeRate) : Number.NaN
        let overThreshold = false
        if (currency === 'PLN') {
          overThreshold = gross > UPR_THRESHOLD_PLN
        } else if (Number.isFinite(rate) && rate > 0) {
          overThreshold = gross * rate > UPR_THRESHOLD_PLN
        } else {
          // No resolvable rate: compare the foreign gross against the ≤ 100 EUR ceiling.
          overThreshold = gross > UPR_THRESHOLD_EUR
        }
        if (overThreshold) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['totalGross'],
            message: 'A simplified invoice (UPR) total exceeds the statutory threshold (≤ 450 PLN / ≤ 100 EUR).',
          })
        }
      }
    }

    // --- Foreign currency (jury resolution 1) ----------------------------------------------
    // A non-PLN invoice requires a resolvable exchange rate ONLY when it carries any Polish-rate
    // (domestic) bucket needing the PLN-converted `P_14_xW`. A pure-OSS FX invoice needs no rate.
    if (invoice.currencyCode.toUpperCase() !== 'PLN') {
      const hasDomesticBucket = invoice.vatBreakdown.some((entry) => entry.rate !== 'oss')
      if (hasDomesticBucket && !invoice.exchangeRate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['exchangeRate'],
          message: 'A foreign-currency invoice with a Polish-rate bucket requires a resolvable exchange rate (KursWaluty / P_14_xW).',
        })
      }
    }

    // --- VAT-summary buckets ----------------------------------------------------------------
    // The synthetic `'oss'` key maps to the P_13_5/P_14_5 OSS bucket; the Polish rates map to
    // P_13_x. A genuinely-unmapped rate is rejected.
    invoice.vatBreakdown.forEach((entry, index) => {
      if (!isMappedFa3VatRate(entry.rate)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['vatBreakdown', index, 'rate'],
          message: 'Unsupported VAT rate for KSeF FA(3).',
        })
      }
    })

    // --- Lines: OSS (WSTO_EE) vs Polish-rate -----------------------------------------------
    invoice.lines.forEach((line, index) => {
      if (line.ossRate !== undefined) {
        // An OSS line omits `P_12` and MUST carry the `Procedura=WSTO_EE` marker, otherwise the
        // destination rate (P_12_XII) would be filed without the procedure that justifies it.
        if (line.procedure !== 'WSTO_EE') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['lines', index, 'procedure'],
            message: 'An OSS line (ossRate) requires the Procedura=WSTO_EE marker.',
          })
        }
        return
      }
      // A non-OSS line is a Polish-rate line; its rate MUST map to an FA(3) `P_12`/`P_13_x` field.
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

/** Offline issuance mode (SPEC-010): self-initiated (offline24) or MF-announced failure (awaryjny). */
export const ksefOfflineModeSchema = z.enum(['offline24', 'awaryjny'])

/**
 * Issue-offline input (SPEC-010 §Offline issuance + jury delta #1). The deadline source
 * is explicit: `awaryjny` REQUIRES a `failureEndsAt` (the MF-BIP-announced failure-end the
 * operator enters; deadline = +7 business days); `offline24` MUST NOT carry one (deadline =
 * next business day). A mismatch (offline24 with failureEndsAt, or awaryjny without it) is
 * rejected with `offline_mode_invalid` so the deadline is never silently mis-computed.
 */
export const ksefIssueOfflineSchema = z
  .object({
    organizationId: z.string().uuid().optional(),
    tenantId: z.string().uuid().optional(),
    salesInvoiceId: z.string().uuid(),
    mode: ksefOfflineModeSchema,
    /** Required for `awaryjny`, forbidden for `offline24` — the MF-announced failure-end (ISO datetime). */
    failureEndsAt: z.string().datetime().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.mode === 'awaryjny' && !input.failureEndsAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureEndsAt'],
        params: { code: 'offline_mode_invalid' },
        message: 'An awaryjny (emergency) offline issue requires the announced failure-end timestamp.',
      })
    }
    if (input.mode === 'offline24' && input.failureEndsAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureEndsAt'],
        params: { code: 'offline_mode_invalid' },
        message: 'An offline24 issue must not carry a failure-end timestamp (its deadline is the next business day).',
      })
    }
  })

/**
 * Recompute-deadline input (SPEC-010 jury delta #1): an operator supplies the MF-announced
 * failure window; the command recomputes `offline_send_deadline_at` for the affected
 * `offline_issued` rows (an offline24 invoice overtaken by an announced failure switches to
 * the awaryjny +7-business-day rule). `salesInvoiceId` narrows to one document when set;
 * otherwise every active offline-issued row in scope is recomputed.
 */
export const ksefRecomputeOfflineDeadlineSchema = z.object({
  organizationId: z.string().uuid().optional(),
  tenantId: z.string().uuid().optional(),
  salesInvoiceId: z.string().uuid().optional(),
  failureEndsAt: z.string().datetime(),
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

/**
 * Query schema for the self-contained invoices-with-KSeF-status list endpoint
 * (`GET /api/financial_pl/ksef/invoices`, SPEC-013). `search` matches the invoice number
 * (free text); `status` filters on the joined KSeF submission status (validated against the
 * KsefSubmission status union at the route, not here, to keep the schema decoupled from the
 * entity column type). `page`/`pageSize` are coerced from the query string with safe defaults
 * (1 / 25) and a 100-row ceiling (the DataTable `pageSize ≤ 100` rule).
 */
export const ksefInvoiceListQuerySchema = z.object({
  search: z.string().trim().min(1).max(256).optional(),
  status: z.string().trim().min(1).max(64).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
})

// JPK-VAT (V7M/V7K) record + filing persistence boundary (SPEC-006). Monetary fields are carried
// as decimal strings (mirroring `moneySchema`) so they round-trip the JPK exporter's fixed-point
// amounts without float drift. The optional-monetary helper additionally accepts an empty string
// (a cleared form field) so a partially-filled purchase row upserts without a spurious 422.
const optionalMoneySchema = z
  .string()
  // The trailing `?` makes the whole amount optional so an EMPTY string (a cleared form field)
  // is accepted alongside a valid decimal — a partially-filled purchase row upserts without a
  // spurious 422 (matching the comment above).
  .regex(/^(-?\d+(\.\d{1,2})?)?$/, 'Amount must be a decimal with up to 2 fraction digits')
  .optional()

/** A purchase (zakup) evidence row staged for the JPK_V7 ewidencja. */
export const jpkPurchaseRecordUpsertSchema = z.object({
  id: z.string().uuid().optional(),
  organizationId: z.string().uuid().optional(),
  tenantId: z.string().uuid().optional(),
  contextNip: nipSchema.optional(),
  year: z.number().int().min(2026).max(2100),
  month: z.number().int().min(1).max(12),
  supplierNip: nipSchema.optional(),
  supplierCountryCode: z.string().length(2).optional(),
  supplierName: z.string().min(1).max(512).optional(),
  documentNumber: z.string().min(1).max(256),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  receiptDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  documentType: z.enum(['MK', 'VAT_RR', 'WEW']).optional(),
  imp: z.boolean().optional(),
  ksefMarking: z.enum(['NrKSeF', 'OFF', 'BFK', 'DI']).optional(),
  nrKsef: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => isStructurallyValidKsefNumber(value), 'KSeF number is structurally invalid')
    .optional(),
  transactionClass: z
    .enum(['domestic', 'wnt', 'import_goods', 'import_services', 'import_services_28b', 'reverse_charge_domestic'])
    .default('domestic'),
  netFixedAssets: optionalMoneySchema,
  vatFixedAssets: optionalMoneySchema,
  netOther: optionalMoneySchema,
  vatOther: optionalMoneySchema,
  corrFixedAssets: optionalMoneySchema,
  corrOther: optionalMoneySchema,
  corr89b1: optionalMoneySchema,
  corr89b4: optionalMoneySchema,
  marginGross: optionalMoneySchema,
  selfAssessedNet: optionalMoneySchema,
  selfAssessedVat: optionalMoneySchema,
  selfAssessedRate: optionalMoneySchema,
}).refine((d) => !(d.ksefMarking === 'NrKSeF' && (!d.nrKsef || d.nrKsef.trim() === '')), {
  message: 'nrKsef is required when ksefMarking is NrKSeF (empty <NrKSeF/> is XSD-invalid)',
  path: ['nrKsef'],
})

/** A JPK_V7 filing header (variant + period + correction scope) staged for generation. */
export const jpkFilingUpsertSchema = z.object({
  id: z.string().uuid().optional(),
  organizationId: z.string().uuid().optional(),
  tenantId: z.string().uuid().optional(),
  // The taxpayer NIP this filing is filed under (Podmiot1). A filing is scoped to a single NIP;
  // when omitted the generator falls back to the KSeF credential NIP. Threading it explicitly lets
  // a multi-NIP (org, tenant) keep one ACTIVE filing per NIP × period (see the unique index).
  contextNip: nipSchema.optional(),
  variant: z.enum(['V7M', 'V7K']),
  year: z.number().int().min(2026).max(2100),
  month: z.number().int().min(1).max(12),
  quarter: z.number().int().min(1).max(4).optional(),
  celZlozenia: z.union([z.literal(1), z.literal(2)]).default(1),
  correctionScope: z.enum(['both', 'declaration', 'evidence']).default('both'),
  // KodUrzedu must be a valid TKodUS (4-digit tax-office code) — an empty/arbitrary value
  // yields an XSD-invalid Naglowek. Optional on a draft; generation requires it (resolver).
  kodUrzedu: z.string().regex(/^\d{4}$/, 'KodUrzedu must be a 4-digit tax-office code').optional(),
  declarationInputs: z.record(z.string(), z.unknown()).optional(),
}).superRefine((d, ctx) => {
  // A partial scope (declaration-only / evidence-only) is meaningful only on a correction filing
  // (CelZlozenia=2). A primary filing (CelZlozenia=1) must carry BOTH halves; reject a partial
  // scope rather than persist a business-invalid primary file that omits the required part.
  if (d.celZlozenia === 1 && d.correctionScope !== 'both') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'correctionScope must be "both" on a primary filing (celZlozenia=1)',
      path: ['correctionScope'],
    })
  }
  // V7K: a supplied quarter must agree with the filing month (quarter = ceil(month / 3)), else the
  // Deklaracja would carry a Kwartal inconsistent with its evidence month (M4).
  if (d.variant === 'V7K' && d.quarter !== undefined && d.quarter !== Math.ceil(d.month / 3)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'quarter must equal ceil(month / 3) for a V7K filing',
      path: ['quarter'],
    })
  }
})

/** Generate the JPK_V7 XML for a persisted filing. */
export const jpkGenerateSchema = z.object({
  filingId: z.string().uuid(),
})

// Standalone delete input — NOT `jpkPurchaseRecordUpsertSchema.pick({ id })`, because that schema
// carries a `.refine()` (a ZodEffects) on which `.pick()` throws at runtime.
export const jpkPurchaseRecordDeleteSchema = z.object({
  id: z.string().uuid(),
})

// --- KSeF certificate enroll/revoke request bodies (SPEC-007) ---------------------------------
export const ksefCertificateEnrollSchema = z.object({
  certificateName: z.string().min(1),
  algorithm: z.enum(['RSA', 'EC']).optional(),
  certificateType: z.enum(['Authentication', 'Offline']).optional(),
})

export const ksefCertificateRevokeSchema = z.object({
  serialNumber: z.string().min(1),
  reason: z.string().min(1).optional(),
})

// --- Invoice PL VAT metadata PUT body (SPEC-009) ----------------------------------------------
const INVOICE_KINDS = ['vat', 'zal', 'roz', 'upr', 'kor_zal', 'kor_roz'] as const satisfies readonly InvoiceKindColumn[]

const advancePaymentSchema = z.object({
  receivedDate: z.string().min(1).max(40),
  amount: z.string().min(1).max(40),
  fxRate: z.string().min(1).max(40).optional(),
}) satisfies z.ZodType<AdvancePaymentSnapshot>

const advanceRefSchema = z
  .object({
    ksefNumber: z.string().min(1).max(120).optional(),
    invoiceNumber: z.string().min(1).max(120).optional(),
    // The already-invoiced gross of this advance; ROZ nets Σ amounts off the full gross to derive
    // the residual P_15. Optional — when omitted the residual equals the full gross (no netting).
    amount: z.string().regex(/^-?\d+(\.\d{1,2})?$/).optional(),
  })
  .refine((v) => Boolean(v.ksefNumber) || Boolean(v.invoiceNumber), {
    message: 'Either ksefNumber or invoiceNumber is required',
  }) satisfies z.ZodType<AdvanceInvoiceRef>

const orderLineSchema = z.object({
  name: z.string().min(1).max(500),
  quantity: z.string().max(40).optional(),
  unitPrice: z.string().max(40).optional(),
  netValue: z.string().max(40).optional(),
  vatRate: z.string().max(40).optional(),
})

const orderSnapshotSchema = z.object({
  totalValue: z.string().min(1).max(40),
  lines: z.array(orderLineSchema).max(1000),
}) satisfies z.ZodType<OrderSnapshot>

// One optional boolean per JPK procedure marking code (the API/widget shape; the entity stores one
// boolean column per code). Codes are validated against JPK_PROCEDURE_MARKINGS.
const procedureMarkingsSchema = z
  .object(
    JPK_PROCEDURE_MARKINGS.reduce(
      (acc, code) => {
        acc[code] = z.boolean().optional()
        return acc
      },
      {} as Record<JpkProcedureMarking, z.ZodOptional<z.ZodBoolean>>,
    ),
  )
  .strict()

export const invoiceMetaPutSchema = z.object({
  salesInvoiceId: z.string().uuid(),
  contextNip: z
    .string()
    .regex(/^[0-9]{10}$/)
    .nullish(),
  mppRequired: z.boolean().optional(),
  vatExemptionBasis: z.string().max(500).nullish(),
  /** Mark the invoice as lawfully issued outside KSeF (drives the JPK_VAT `BFK` marking). */
  issuedOutsideKsef: z.boolean().optional(),
  // --- SPEC-009: FA(3) advanced doc-types, self-billing, OSS/FX, GTU/JPK markings ---
  invoiceKind: z.enum(INVOICE_KINDS).optional(),
  selfBilling: z.boolean().optional(),
  reverseCharge: z.boolean().optional(),
  ossProcedure: z.boolean().optional(),
  consumptionCountryCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullish(),
  exchangeRate: z.string().max(40).nullish(),
  exchangeRateDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  advancePayments: z.array(advancePaymentSchema).max(1000).optional(),
  advanceRefs: z.array(advanceRefSchema).max(1000).optional(),
  orderSnapshot: orderSnapshotSchema.nullish(),
  // Pure-JPK GTU goods/services group codes (deduped, validated against GTU_CODES).
  gtuCodes: z.array(z.enum(GTU_CODES)).max(GTU_CODES.length).optional(),
  procedureMarkings: procedureMarkingsSchema.optional(),
  // Pure-JPK TypDokumentu (validated against JPK_TYP_DOKUMENTU).
  typDokumentu: z.enum(JPK_TYP_DOKUMENTU).nullish(),
  // art. 89a ust. 1 creditor bad-debt relief: the YYYY-MM period to claim the relief in, and the
  // invoice's payment due date (TerminPlatnosci). Setting both flags this invoice for a negated
  // KorektaPodstawyOpodt correction row (→ P_68/P_69) in that JPK period (SPEC-012).
  badDebtReliefPeriod: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'badDebtReliefPeriod must be YYYY-MM')
    .nullish(),
  badDebtTerminPlatnosci: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'badDebtTerminPlatnosci must be YYYY-MM-DD')
    .nullish(),
})

export type Fa3PartyInput = z.infer<typeof fa3PartySchema>
export type Fa3AnnotationsInput = z.infer<typeof fa3AnnotationsSchema>
export type Fa3CorrectionInput = z.infer<typeof fa3CorrectionSchema>
export type Fa3OrderLineInput = z.infer<typeof fa3OrderLineSchema>
export type Fa3OrderInput = z.infer<typeof fa3OrderSchema>
export type Fa3AdvancePaymentInput = z.infer<typeof fa3AdvancePaymentSchema>
export type Fa3AdvanceRefInput = z.infer<typeof fa3AdvanceRefSchema>
export type Fa3InvoiceInput = z.infer<typeof fa3InvoiceSchema>
export type KsefSubmissionSendInput = z.infer<typeof ksefSubmissionSendSchema>
export type KsefSubmissionRetryInput = z.infer<typeof ksefSubmissionRetrySchema>
export type KsefOfflineMode = z.infer<typeof ksefOfflineModeSchema>
export type KsefIssueOfflineInput = z.infer<typeof ksefIssueOfflineSchema>
export type KsefRecomputeOfflineDeadlineInput = z.infer<typeof ksefRecomputeOfflineDeadlineSchema>
export type SendFromInvoiceInput = z.infer<typeof sendFromInvoiceSchema>
export type SendFromCreditMemoInput = z.infer<typeof sendFromCreditMemoSchema>
export type KsefSubmissionListQuery = z.infer<typeof ksefSubmissionListQuerySchema>
export type KsefInvoiceListQuery = z.infer<typeof ksefInvoiceListQuerySchema>
export type JpkPurchaseRecordUpsertInput = z.infer<typeof jpkPurchaseRecordUpsertSchema>
export type JpkPurchaseRecordDeleteInput = z.infer<typeof jpkPurchaseRecordDeleteSchema>
export type JpkFilingUpsertInput = z.infer<typeof jpkFilingUpsertSchema>
export type JpkGenerateInput = z.infer<typeof jpkGenerateSchema>
export type KsefCertificateEnrollInput = z.infer<typeof ksefCertificateEnrollSchema>
export type KsefCertificateRevokeInput = z.infer<typeof ksefCertificateRevokeSchema>
export type InvoiceMetaPutInput = z.infer<typeof invoiceMetaPutSchema>
