import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test, expect } from '@playwright/test'

type Fixture = { ticketId: string; uploadFileName: string }

test.describe('File editor UI (W7)', () => {
  test('feltöltés a Fájlok panelen → fájl megjelenik a listában', async ({ page }) => {
    const fixturePath = resolve(process.cwd(), 'e2e/.fixture.json')
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as Fixture
    const uploadContent = `E2E upload ${Date.now()}\n`

    await page.goto(`/control-plane/tickets/${fixture.ticketId}`)

    await expect(page.getByRole('heading', { name: 'Fájlok' })).toBeVisible()

    await expect(
      page.getByText('Nincs fájl a workspace-ben.').or(page.locator('ul.divide-y li').first()),
    ).toBeVisible({ timeout: 30_000 })

    const fileInput = page.locator('input[type="file"]')
    const tempPath = resolve(process.cwd(), 'e2e', fixture.uploadFileName)
    await writeFile(tempPath, uploadContent, 'utf8')

    const uploadResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/workspace/files') &&
        res.request().method() === 'POST' &&
        res.status() < 500,
    )
    await fileInput.setInputFiles(tempPath)
    const postRes = await uploadResponse
    expect(postRes.ok()).toBeTruthy()

    await expect(page.getByText(fixture.uploadFileName)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('button', { name: 'Letöltés' })).toBeVisible()
  })
})
