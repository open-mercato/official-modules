/**
 * Regression guard for the invoice-pdf permission bypass: the rendered PDF exposes the same
 * invoice data the ksef/invoices list/detail routes gate behind `sales.invoices.manage`, so
 * the PDF route must require the SAME feature pair — `financial_pl.view` alone must never
 * be enough (a view-only user blocked from the invoice JSON could otherwise fetch the PDF).
 */
// The routes' core imports drag the DB stack (mikro-orm → kysely, ESM-only) into jest;
// the gating test only needs the exported `metadata`, so stub the runtime-only imports.
jest.mock('@open-mercato/shared/lib/di/container', () => ({ createRequestContainer: jest.fn() }))
jest.mock('@open-mercato/shared/lib/auth/server', () => ({ getAuthFromRequest: jest.fn() }))
jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: jest.fn(),
}))
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({ findOneWithDecryption: jest.fn() }))
jest.mock('@open-mercato/shared/lib/i18n/server', () => ({ resolveTranslations: jest.fn() }))

import { metadata as pdfRouteMetadata } from '../ksef/invoice-pdf/route'
import { metadata as invoicesListMetadata } from '../ksef/invoices/route'
import { metadata as invoiceDetailMetadata } from '../ksef/invoices/[id]/route'

const REQUIRED_PAIR = ['financial_pl.view', 'sales.invoices.manage']

describe('ksef/invoice-pdf route gating', () => {
  it('requires auth and BOTH financial_pl.view and sales.invoices.manage', () => {
    expect(pdfRouteMetadata.GET.requireAuth).toBe(true)
    expect([...pdfRouteMetadata.GET.requireFeatures].sort()).toEqual([...REQUIRED_PAIR].sort())
  })

  it('matches the feature pair of the sibling invoices list/detail routes', () => {
    expect([...invoicesListMetadata.GET.requireFeatures].sort()).toEqual([...REQUIRED_PAIR].sort())
    expect([...invoiceDetailMetadata.GET.requireFeatures].sort()).toEqual([...REQUIRED_PAIR].sort())
  })
})
