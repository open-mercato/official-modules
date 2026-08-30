import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { isCreditMemoProjectionLag, withCreditMemoProjectionRetry } from '../ksef-submission'

const tr = (_key: string, fallback: string) => fallback

describe('credit-memo projection retry (QA #41)', () => {
  describe('isCreditMemoProjectionLag', () => {
    it('does NOT classify a 404 as projection lag (a genuinely-unknown credit memo must stay 404)', () => {
      expect(isCreditMemoProjectionLag(new CrudHttpError(404, { error: 'x' }))).toBe(false)
    })
    it('classifies a 422 correction_lines_required as projection lag (lines load from a separate projection query that can lag after the header materializes)', () => {
      expect(isCreditMemoProjectionLag(new CrudHttpError(422, { code: 'correction_lines_required', error: 'x' }))).toBe(true)
    })
    it('does NOT classify a 422 credit_memo_not_linked as lag — the link rides on the header row (invoice_id/metadata), so once visible it always resolves; its presence means a genuinely UNLINKED memo, a terminal 422, never a retryable 409', () => {
      expect(isCreditMemoProjectionLag(new CrudHttpError(422, { code: 'credit_memo_not_linked', error: 'x' }))).toBe(false)
    })
    it('does NOT classify a 422 with another code as lag', () => {
      expect(isCreditMemoProjectionLag(new CrudHttpError(422, { code: 'correction_reason_required', error: 'x' }))).toBe(false)
    })
    it('does NOT classify a 409 as lag', () => {
      expect(isCreditMemoProjectionLag(new CrudHttpError(409, { error: 'x' }))).toBe(false)
    })
    it('does NOT classify a plain Error as lag', () => {
      expect(isCreditMemoProjectionLag(new Error('boom'))).toBe(false)
    })
  })

  describe('withCreditMemoProjectionRetry', () => {
    it('returns the value on first success', async () => {
      await expect(withCreditMemoProjectionRetry(async () => 'ok', tr)).resolves.toBe('ok')
    })

    it('retries a transient lines-lag error then succeeds (no duplicate on convergence)', async () => {
      let calls = 0
      const value = await withCreditMemoProjectionRetry(async () => {
        calls += 1
        if (calls < 2) throw new CrudHttpError(422, { code: 'correction_lines_required', error: 'lines not materialized yet' })
        return 'ok'
      }, tr)
      expect(value).toBe('ok')
      expect(calls).toBe(2)
    })

    it('surfaces a public source_not_ready (409) after exhausting retries on lines-lag (correction_lines_required)', async () => {
      let calls = 0
      await expect(
        withCreditMemoProjectionRetry(async () => {
          calls += 1
          throw new CrudHttpError(422, { code: 'correction_lines_required', error: 'lines not materialized yet' })
        }, tr),
      ).rejects.toMatchObject({ status: 409, body: { code: 'source_not_ready' } })
      expect(calls).toBe(5)
    }, 10000)

    it('passes a 404 (unknown credit memo) straight through WITHOUT retrying or recoding to 409', async () => {
      let calls = 0
      await expect(
        withCreditMemoProjectionRetry(async () => {
          calls += 1
          throw new CrudHttpError(404, { error: 'credit memo not found' })
        }, tr),
      ).rejects.toMatchObject({ status: 404 })
      expect(calls).toBe(1)
    })

    it('passes a permanently-unlinked memo (credit_memo_not_linked) straight through as a terminal 422 — NOT retried, NOT recoded to a misleading retryable 409 (reviewer minor 2)', async () => {
      let calls = 0
      await expect(
        withCreditMemoProjectionRetry(async () => {
          calls += 1
          throw new CrudHttpError(422, { code: 'credit_memo_not_linked', error: 'link it to the original invoice first' })
        }, tr),
      ).rejects.toMatchObject({ status: 422, body: { code: 'credit_memo_not_linked' } })
      expect(calls).toBe(1)
    })

    it('passes a non-lag validation error (correction_reason_required) straight through', async () => {
      let calls = 0
      await expect(
        withCreditMemoProjectionRetry(async () => {
          calls += 1
          throw new CrudHttpError(422, { code: 'correction_reason_required', error: 'reason' })
        }, tr),
      ).rejects.toMatchObject({ status: 422, body: { code: 'correction_reason_required' } })
      expect(calls).toBe(1)
    })
  })
})
