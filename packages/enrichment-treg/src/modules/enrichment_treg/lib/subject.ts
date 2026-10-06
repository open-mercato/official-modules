import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  CustomerCompanyProfile,
  CustomerEntity,
  CustomerPersonProfile,
} from '@open-mercato/core/modules/customers/data/entities'
import type { SubjectType } from './constants'
import { buildCompanyIdentity, buildPersonIdentity, type SubjectIdentity } from './normalize'

type Scope = { tenantId: string; organizationId: string }

async function loadCompanyDomain(em: EntityManager, companyEntityId: string, scope: Scope): Promise<string | null> {
  const profile = await findOneWithDecryption(
    em,
    CustomerCompanyProfile,
    { entity: companyEntityId, tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    scope,
  )
  return profile?.domain ?? null
}

export async function loadSubjectIdentity(
  em: EntityManager,
  subjectType: SubjectType,
  subjectId: string,
  scope: Scope,
): Promise<SubjectIdentity | null> {
  const entity = await findOneWithDecryption(
    em,
    CustomerEntity,
    {
      id: subjectId,
      kind: subjectType,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    },
    undefined,
    scope,
  )
  if (!entity) return null

  if (subjectType === 'company') {
    const profile = await findOneWithDecryption(
      em,
      CustomerCompanyProfile,
      { entity: entity.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      undefined,
      scope,
    )
    return buildCompanyIdentity({
      domain: profile?.domain,
      websiteUrl: profile?.websiteUrl,
      name: profile?.legalName ?? profile?.brandName ?? entity.displayName,
      email: entity.primaryEmail,
    })
  }

  const profile = await findOneWithDecryption(
    em,
    CustomerPersonProfile,
    { entity: entity.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    scope,
  )
  const companyEntityId = profile?.company?.id ?? null
  const companyDomain = companyEntityId ? await loadCompanyDomain(em, companyEntityId, scope) : null
  return buildPersonIdentity({
    email: entity.primaryEmail,
    linkedInUrl: profile?.linkedInUrl,
    firstName: profile?.firstName,
    lastName: profile?.lastName,
    displayName: entity.displayName,
    companyDomain,
  })
}
