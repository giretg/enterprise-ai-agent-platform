/**
 * #1083 — mentett lekérdezés és élő mini app a teljes láncon: valódi Excel-import, mentés,
 * kötés, megnyitás a Control Plane-ről, újabb import, újranyitás, tiltás, letöltés.
 *
 * Eldobható Postgresen fut (dev-auth, Clerk nélkül):
 *   DATABASE_URL=… DIRECT_URL=… DEV_AUTH_ROLE=admin PLAYWRIGHT_PORT=3983 NEXT_PUBLIC_APP_URL=http://localhost:3983 \
 *     npx playwright test e2e/warehouse-live-mini-app.spec.ts
 */
import { expect, test, type Frame, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { ordersXlsx } from '../scripts/warehouse-fixtures'
import { services } from '../src/domain/gateway-services'
import { warehouseSchemaName } from '../src/domain/warehouse/sql'
import type { WarehouseActor } from '../src/domain/warehouse/warehouse-service'
import { prisma } from '../src/lib/db'
import { warehouseService } from '../src/lib/warehouse'

test.setTimeout(180_000)

const DEV_USER = process.env.DEV_AUTH_USER_ID ?? 'dev-user-001'
const suffix = randomUUID().slice(0, 8)

const REPORT_HTML = `<!doctype html><html><body><h1>Rendelések</h1><ul id="o"></ul><script>
var d = JSON.parse(document.getElementById('platform-data').textContent).rendelesek;
document.body.setAttribute('data-status', d.status);
(d.rows || []).forEach(function (r) {
  var li = document.createElement('li');
  li.textContent = r.join(' | ');
  document.getElementById('o').appendChild(li);
});
document.body.setAttribute('data-ready', '1');
</script></body></html>`

const ordersPlan = {
  schema: 'warehouse.import_plan/v1',
  sheet: 'Rendelések',
  dataset: { key: 'rendelesek', title: 'Rendelések', rowMeaning: 'Egy sor = egy rendelés', temporal: 'event' },
  mode: 'upsert',
  businessKey: ['szam'],
  fields: [
    { source: 'Rendelés / Szám', target: 'szam', type: 'text', label: 'Rendelésszám', required: true },
    { source: 'Rendelés / Dátum', target: 'datum', type: 'date', label: 'Dátum' },
    { source: 'Ügyfél / Név', target: 'ugyfel_nev', type: 'text', label: 'Ügyfél neve' },
    { source: 'Összeg / Nettó', target: 'netto', type: 'decimal', label: 'Nettó összeg', currency: 'HUF', amountBasis: 'net' },
  ],
}

let tenantId = ''
let agentId = ''
let appId = ''
let queryId = ''
let human: WarehouseActor
let ai: WarehouseActor

async function liveFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((frame) => frame.url().includes('/api/mini-apps/content/')), { timeout: 30_000 }).toBe(true)
  const frame = page.frames().find((candidate) => candidate.url().includes('/api/mini-apps/content/'))!
  await frame.waitForSelector('body[data-ready="1"]', { state: 'attached', timeout: 30_000 })
  return frame
}

function barFrame(page: Page): Frame {
  return page.frames().find((candidate) => candidate.url().includes('/api/mini-apps/open/'))!
}

async function importOrders(options: { injection?: boolean; extraRow?: boolean }, plan = false) {
  const prepared = await warehouseService().prepareImport(ai, { fileName: `rendelesek-${randomUUID().slice(0, 6)}.xlsx`, content: await ordersXlsx(options) })
  if (plan) await warehouseService().submitPlan(ai, prepared.import.id, ordersPlan, 'ai')
  const preview = await warehouseService().preview(ai, prepared.import.id)
  await warehouseService().commit(human, { importId: prepared.import.id, previewHash: preview.import.previewHash!, approve: true })
}

test.beforeAll(async () => {
  const host = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid').hostname
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('Ez az e2e csak eldobható, helyi Postgresen fut.')
  const tenant = await prisma.tenant.create({ data: { slug: `live-e2e-${suffix}`, displayName: 'Élő adat E2E' } })
  tenantId = tenant.id
  const dev = await prisma.user.upsert({
    where: { externalAuthId: DEV_USER },
    create: { externalAuthId: DEV_USER, email: 'dev@excellence.ai', name: 'Dev Admin', role: 'admin', status: 'active' },
    update: {},
  })
  await prisma.tenantMembership.deleteMany({ where: { userId: dev.id } })
  await prisma.tenantMembership.create({ data: { tenantId, userId: dev.id, role: 'admin', status: 'active', isDefault: true } })
  const agent = await prisma.agent.create({ data: { tenantId, name: 'Élő Réka', roleInstruction: 'x', status: 'active', modelConfig: { provider: 'stub', model: 'stub' } } })
  agentId = agent.id
  human = { tenantId, userId: dev.id, role: 'admin', channel: 'ui' }
  ai = { tenantId, userId: dev.id, role: 'admin', agentId, channel: 'mcp' }

  await warehouseService().activate(human)
  await importOrders({}, true)
  const saved = await warehouseService().saveQuery(ai, {
    name: 'rendelesek_listaja',
    description: 'A rendelések listája, ügyfélnévvel.',
    query: { dataset: 'rendelesek', fields: 'szam,ugyfel_nev', orderBy: 'szam desc' },
  })
  queryId = saved.query.queryId
  const created = await services.miniApps.service.create(
    { tenantId, agentId, userId: dev.id, role: 'admin' },
    { name: 'Rendelések élőben', html: REPORT_HTML, dataBindings: JSON.stringify([{ alias: 'rendelesek', queryId, maxRows: 2 }]), idempotencyKey: `e2e-${suffix}` },
  )
  if (!created.ok) throw new Error(`mini app: ${created.code} ${JSON.stringify(created.extra)}`)
  appId = created.app.id
})

test.afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${warehouseSchemaName(tenantId)}" CASCADE`)
  await prisma.$disconnect()
})

test('Mentett lekérdezések: állapot, próbafuttatás, használó app, archiválás-védelem', async ({ page }, testInfo) => {
  await page.goto('/control-plane/warehouse')
  const row = page.locator('li', { has: page.locator('code', { hasText: 'rendelesek_listaja' }) })
  await expect(row).toContainText('A rendelések listája, ügyfélnévvel.')
  await expect(row.getByText('Naprakész')).toBeVisible()
  await expect(row.getByRole('link', { name: 'Rendelések élőben' })).toHaveAttribute('href', `/control-plane/mini-apps/${appId}`)

  await row.getByText('Részletek és próbafuttatás').click()
  await row.getByRole('button', { name: 'Próbafuttatás' }).click()
  await expect(row.getByRole('table')).toContainText('R-001')
  await page.screenshot({ path: testInfo.outputPath('warehouse-saved-queries.png'), fullPage: true })

  page.once('dialog', (dialog) => dialog.accept())
  await row.getByRole('button', { name: 'Archiválás' }).click()
  await expect(page.getByRole('alert').first()).toContainText('mini app használja')
})

test('AC13 + AC19: élő adat a sávval; új import után új app-verzió nélkül az új adat látszik', async ({ page }, testInfo) => {
  await page.goto(`/control-plane/mini-apps/${appId}`)
  await expect(page.getByText('Élő adat: minden megnyitáskor')).toBeVisible()
  let frame = await liveFrame(page)
  const bar = barFrame(page).locator('[data-mini-app-bar]')
  await expect(bar).toContainText('Élő adat')
  await expect(bar).toContainText('Utolsó betöltés')
  await expect(bar).toContainText('AI-javaslat, még nem megerősített mezők')
  await expect(bar).toContainText('Az egyik lekérdezésből csak az első 2 sor látszik')
  await expect(frame.locator('#o li')).toHaveCount(2)
  await page.screenshot({ path: testInfo.outputPath('mini-app-live.png') })

  await expect(frame.locator('#o li').first()).toContainText('R-004')
  await importOrders({ extraRow: true })
  await page.reload()
  frame = await liveFrame(page)
  await expect(frame.locator('#o li').first()).toContainText('R-005')
  expect((await prisma.miniApp.findUniqueOrThrow({ where: { id: appId } })).currentVersion).toBe(1)
})

test('AC20: a letöltött fájl rögzített adatot tartalmaz, kiírja, hogy nem frissül, és audit készül', async ({ page }) => {
  const response = await page.request.get(`/api/control-plane/mini-apps/${appId}/download`)
  expect(response.status()).toBe(200)
  const body = await response.text()
  expect(body).toContain('ez a fájl már nem frissül')
  expect(body).toContain('id="platform-data"')
  expect(body).toContain('R-005')
  expect(body).toContain('http-equiv="Content-Security-Policy"')
  const audit = await prisma.auditLog.findFirst({ where: { tenantId, action: 'warehouse.export', targetId: appId } })
  expect(audit).not.toBeNull()
})

test('AC16: archivált app letöltése nem ad adatot, az elutasítás auditált', async ({ page }) => {
  await prisma.miniApp.update({ where: { id: appId }, data: { status: 'archived', archivedAt: new Date() } })
  try {
    const response = await page.request.get(`/api/control-plane/mini-apps/${appId}/download`)
    expect(response.status()).toBe(403)
    const body = await response.text()
    expect(body).toContain('archiválták')
    expect(body).not.toContain('R-00')
    const audit = await prisma.auditLog.findFirst({ where: { tenantId, action: 'warehouse.export', targetId: appId, policyDecision: 'denied' } })
    expect(audit).not.toBeNull()
  } finally {
    await prisma.miniApp.update({ where: { id: appId }, data: { status: 'active', archivedAt: null } })
  }
})

test('AC16: off szintű munkatárs appja adat nélkül nyílik, a sáv megmondja az okot', async ({ page }, testInfo) => {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })
  const settings = (tenant.settings ?? {}) as Record<string, unknown>
  await prisma.tenant.update({ where: { id: tenantId }, data: { settings: { ...settings, warehouse: { defaultAgentAccess: 'import', agentAccess: { [agentId]: 'off' } } } as object } })
  try {
    await page.goto(`/control-plane/mini-apps/${appId}`)
    await expect.poll(() => Boolean(barFrame(page)), { timeout: 30_000 }).toBe(true)
    const bar = barFrame(page).locator('[data-mini-app-bar]')
    await expect(bar).toContainText('nincs hozzáférése az adattárházhoz')
    expect(page.frames().some((frame) => frame.url().includes('/api/mini-apps/content/'))).toBe(false)
    await expect(page.getByRole('heading', { name: 'Rendelések élőben' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('mini-app-denied.png') })
  } finally {
    await prisma.tenant.update({ where: { id: tenantId }, data: { settings: settings as object } })
  }
})

test('A munkatárs mini app listája jelzi az élő adatot', async ({ page }) => {
  await page.goto(`/control-plane/agents/${agentId}?section=miniappok`)
  await expect(page.getByText('élő adat', { exact: true })).toBeVisible({ timeout: 30_000 })
})
