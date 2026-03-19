import { expect, test, type Page } from '@playwright/test'

const SUPERADMIN_EMAIL = 'superadmin@acme.com'
const DEFAULT_PASSWORD = 'secret'

async function loginAsSuperadmin(page: Page) {
  await page.goto('/login?role=superadmin')
  await expect(page.getByRole('heading', { name: 'Open Mercato' })).toBeVisible()
  await page.getByLabel('Email').fill(SUPERADMIN_EMAIL)
  const passwordField = page.getByLabel('Password')
  await passwordField.fill(DEFAULT_PASSWORD)
  await passwordField.press('Enter')
  await page.waitForURL(/\/backend(?:\?.*)?$/)
}

test.describe('TC-ADMIN-001: test package backend page loads', () => {
  test('opens the test package backend page after login', async ({ page }) => {
    await loginAsSuperadmin(page)

    await page.goto('/backend/test-package')
    await page.waitForLoadState('domcontentloaded')

    await expect(page.getByRole('heading', { name: 'Test Package' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Package is wired correctly' })).toBeVisible()
  })
})
