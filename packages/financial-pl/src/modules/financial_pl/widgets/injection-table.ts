import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

/**
 * financial_pl owns its invoice + KSeF operator UI directly (the module's own
 * backend pages under `backend/financial/*`, composed from `components/*`).
 *
 * It intentionally injects NOTHING into the core `sales` module: released
 * `@open-mercato/core` ships no invoice UI host (no `sales.invoices` DataTable and
 * no `sales.sales_invoice` CrudForm — invoices are data + API only), so injecting
 * into those spots would be dead wiring coupled to a non-existent host (SPEC-013,
 * spec-stage cross-model jury). The cross-module immutability guard lives in
 * `api/interceptors.ts`; the per-invoice KSeF status is exposed via the response
 * enricher in `data/enrichers.ts`.
 */
export const injectionTable: ModuleInjectionTable = {}

export default injectionTable
