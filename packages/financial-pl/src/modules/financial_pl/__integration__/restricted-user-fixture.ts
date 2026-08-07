import type { APIRequestContext } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'

export async function createRestrictedUserFixture(
  request: APIRequestContext,
  input: { features: string[]; label: string },
): Promise<{ token: string; cleanup: () => Promise<void> }> {
  const adminToken = await getAuthToken(request, 'admin')
  const scope = getTokenContext(adminToken)
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const email = `qa-financial-pl-${stamp}@acme.com`
  const password = `QaFinancial1!${stamp}`
  let roleId: string | null = null
  let userId: string | null = null

  const cleanup = async () => {
    await deleteUserIfExists(request, adminToken, userId)
    await deleteRoleIfExists(request, adminToken, roleId)
  }

  try {
    roleId = await createRoleFixture(request, adminToken, {
      name: `${input.label} ${stamp}`,
      tenantId: scope.tenantId,
    })
    await setRoleAclFeatures(request, adminToken, { roleId, features: input.features })
    userId = await createUserFixture(request, adminToken, {
      email,
      password,
      organizationId: scope.organizationId,
      roles: [roleId],
      name: `${input.label} ${stamp}`,
    })
    return { token: await getAuthToken(request, email, password), cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}
