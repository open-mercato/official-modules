import type { EntityManager } from '@mikro-orm/postgresql'
import { KsefSubmission } from '../data/entities'

/**
 * Resolve which of `submissionIds` actually carry a stored UPO receipt.
 *
 * `status === 'accepted'` is NOT a safe proxy for "the UPO can be downloaded" (QA #40).
 * `finalizeAccepted` does downgrade its own result to `processing` when the receipt comes
 * back empty, but that only guards the happy path — a row can still be persisted as, or
 * left at, `accepted` without a receipt: a duplicate (440) recovery that resolves the KSeF
 * number before the UPO is retrievable, a UPO fetch that throws after the status was
 * already written, or a status set out of band. Every such row rendered a "Download UPO"
 * button that 404s the moment it is clicked.
 *
 * Only `id` is projected, so the encrypted `upo_xml` column is never loaded and the
 * on-load decryption subscriber never runs — this stays as cheap as the status proxy it
 * replaces, which is why the projection is part of the contract and not an optimization.
 *
 * `submissionIds` are expected to come from an already org/tenant-scoped read; `tenantId`
 * is re-applied here as defence in depth so a stray id can never widen the scope.
 */
export async function selectSubmissionIdsWithUpo(
  em: EntityManager,
  submissionIds: readonly string[],
  tenantId: string,
): Promise<Set<string>> {
  if (submissionIds.length === 0) return new Set()
  const rows = await em.find(
    KsefSubmission,
    // `$ne: null` compiles to `upo_xml is not null` — a plain `!= NULL` would never match.
    { id: { $in: [...submissionIds] }, tenantId, upoXml: { $ne: null } },
    { fields: ['id'] },
  )
  return new Set(rows.map((row) => row.id))
}
