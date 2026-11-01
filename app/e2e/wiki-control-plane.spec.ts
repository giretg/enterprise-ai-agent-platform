/**
 * #946 LLM Wiki 5/6 — a Control Plane fő útjai böngészőből:
 * 1. tömeges feltöltés a tálcára (30 fájl egy mozdulattal), köteg-állás;
 * 2. egy agent két wikihez eltérő joggal és móddal;
 * 3. más privát tudásbázisa admin szemmel: csak metaadat-sor, a tartalom 404.
 *
 * Eldobható Postgresen fut (dev-auth, Clerk nélkül):
 *   DATABASE_URL=… DIRECT_URL=… PLAYWRIGHT_PORT=3946 npx playwright test e2e/wiki-control-plane.spec.ts
 */
import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'

const DEV_USER = process.env.DEV_AUTH_USER_ID ?? 'dev-user-001'
const suffix = randomUUID().slice(0, 8)

let tenantId = ''
let agentId = ''
let sharedKbId = ''
let otherPrivateKbId = ''
let devUserId = ''

test.beforeAll(async () => {
  const host = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid').hostname
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('A wiki e2e csak eldobható, helyi Postgresen fut.')
  const tenant = await prisma.tenant.create({ data: { slug: `wiki-e2e-${suffix}`, displayName: 'Wiki E2E' } })
  tenantId = tenant.id
  const dev = await prisma.user.upsert({
    where: { externalAuthId: DEV_USER },
    create: { externalAuthId: DEV_USER, email: 'dev@excellence.ai', name: 'Dev Admin', role: 'admin', status: 'active' },
    update: {},
  })
  devUserId = dev.id
  // A dev-felhasználó csak ebben a tenantban tag, adminként.
  await prisma.tenantMembership.deleteMany({ where: { userId: dev.id } })
  await prisma.tenantMembership.create({ data: { tenantId, userId: dev.id, role: 'admin', status: 'active', isDefault: true } })
  const other = await prisma.user.create({
    data: { externalAuthId: `e2e-${suffix}`, email: `owner-${suffix}@example.test`, name: 'Másik Tulajdonos', status: 'active' },
  })
  await prisma.tenantMembership.create({ data: { tenantId, userId: other.id, role: 'operator', status: 'active', isDefault: true } })
  const agent = await prisma.agent.create({ data: { tenantId, name: 'Wiki Réka', roleInstruction: 'x', status: 'active' } })
  agentId = agent.id
  const shared = await prisma.connector.create({
    data: { tenantId, type: 'knowledge_base', name: `kb:shared:${randomUUID()}`, authMode: 'agent_owned', scope: 'single', config: { displayName: 'Közös termékismeret' } },
  })
  sharedKbId = shared.id
  const otherPrivate = await prisma.connector.create({
    data: {
      tenantId,
      type: 'knowledge_base',
      name: `kb:private:${randomUUID()}`,
      authMode: 'agent_owned',
      scope: 'single',
      config: { displayName: 'Titkos leletek' },
      visibility: 'private_to_user',
      ownerUserId: other.id,
    },
  })
  otherPrivateKbId = otherPrivate.id
  const wiki = await prisma.agentWiki.create({ data: { connectorId: otherPrivate.id, schemaMd: '# WIKI' } })
  await prisma.document.create({
    data: { tenantId, filename: 'vercukor.pdf', extractedText: 'HbA1c 6,1 %', connectorId: otherPrivate.id, uploadedById: other.id, status: 'processed' },
  })
  await prisma.wikiPage.create({
    data: { wikiId: wiki.id, connectorId: otherPrivate.id, path: 'conditions/cukorbetegseg.md', type: 'entity', title: 'Cukorbetegség', summary: 's', body: 'titok', contentHash: 'h' },
  })
})

test.afterAll(async () => {
  await prisma.$disconnect()
})

test('tömeges feltöltés: 30 fájl egy mozdulattal a privát tudásbázis tálcájára', async ({ page }) => {
  await page.goto('/control-plane/knowledge')
  await page.getByTestId('kb-create-open').click()
  await page.getByTestId('kb-create-name').fill(`Leletek ${suffix}`)
  await page.getByTestId('kb-create-private').check()
  await page.getByTestId('kb-create-submit').click()
  await expect(page.getByTestId('wiki-title')).toHaveText(`Leletek ${suffix}`)
  await expect(page.getByTestId('wiki-empty')).toBeVisible()

  await page.getByTestId('wiki-tab-inbox').click()
  const files = Array.from({ length: 30 }, (_, i) => ({
    name: `lelet-${String(i + 1).padStart(2, '0')}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(`Lelet ${i + 1} — ${suffix}`),
  }))
  await page.getByTestId('wiki-inbox-file-input').setInputFiles([
    files[0], { ...files[0], name: 'azonos-1.txt' }, { ...files[0], name: 'azonos-2.txt' }, ...files.slice(1),
  ])
  await expect(page.getByTestId('wiki-upload-progress')).toContainText('30', { timeout: 120_000 })
  await expect(page.getByTestId('wiki-upload-progress')).not.toContainText('Feltöltés:', { timeout: 120_000 })
  await expect(page.getByTestId('wiki-batch-bar')).toContainText('0/30')
  await expect(page.getByTestId('wiki-inbox-totals')).toContainText('30 vár')
  await expect(page.getByTestId('wiki-inbox-items').locator('li')).toHaveCount(30)

  // Ugyanaz a fájl még egyszer: duplikátumként kimarad.
  await page.getByTestId('wiki-inbox-file-input').setInputFiles([files[0], { ...files[0], name: 'mas-neven.txt' }])
  await expect(page.getByTestId('wiki-upload-progress')).toContainText('már szerepelt', { timeout: 60_000 })

  // Hibás tételek után is folytatható a feltöltés.
  await page.getByTestId('wiki-inbox-file-input').setInputFiles([
    { name: 'ures.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
  ])
  await expect(page.getByTestId('wiki-upload-progress')).toContainText('ures.txt')
  await expect(page.getByTestId('wiki-upload-progress')).not.toContainText('Feltöltés:')
  await expect(page.getByRole('button', { name: 'Fájlok kiválasztása', exact: true })).toBeEnabled()

  await page.route('**/control-plane/knowledge/**', async (route) => {
    if (route.request().method() === 'POST') await route.abort('failed')
    else await route.continue()
  })
  await page.getByTestId('wiki-inbox-file-input').setInputFiles([
    { name: 'kapcsolathiba.txt', mimeType: 'text/plain', buffer: Buffer.from('hiba') },
  ])
  await expect(page.getByTestId('wiki-upload-progress')).toContainText('kapcsolathiba.txt')
  await expect(page.getByTestId('wiki-upload-progress')).not.toContainText('Feltöltés:')
  await expect(page.getByRole('button', { name: 'Fájlok kiválasztása', exact: true })).toBeEnabled()
  await page.unroute('**/control-plane/knowledge/**')

  const kb = await prisma.connector.findFirstOrThrow({ where: { tenantId, ownerUserId: devUserId, visibility: 'private_to_user' } })
  const queued = await prisma.document.findMany({ where: { connectorId: kb.id, wikiStatus: 'pending' } })
  expect(queued).toHaveLength(30)
  expect(new Set(queued.map((doc) => doc.wikiBatchId)).size).toBe(1)
})

test('jogbeállítás: egy agent két wikihez eltérő joggal és móddal', async ({ page }) => {
  const own = await prisma.connector.findFirstOrThrow({ where: { tenantId, ownerUserId: devUserId, visibility: 'private_to_user' } })
  await page.goto(`/control-plane/agents/${agentId}?section=tudasbazis`)
  const sharedRow = page.getByTestId(`agent-wiki-row-${sharedKbId}`)
  await sharedRow.getByTestId('agent-wiki-access').selectOption('write')
  await expect(sharedRow.getByTestId('agent-wiki-write-warning')).toBeVisible()
  await sharedRow.getByTestId('agent-wiki-mode').selectOption('approval')
  await sharedRow.getByTestId('agent-wiki-collect').fill('Termékadatlapok és árak')
  await sharedRow.getByTestId('agent-wiki-save').click()
  await expect(sharedRow).toContainText('Mentve')

  const privateRow = page.getByTestId(`agent-wiki-row-${own.id}`)
  await privateRow.getByTestId('agent-wiki-access').selectOption('submit')
  await privateRow.getByTestId('agent-wiki-collect').fill('Leletek')
  await privateRow.getByTestId('agent-wiki-save').click()
  await expect(privateRow).toContainText('Mentve')

  // Más privát wikije nem szerepel a listában.
  await expect(page.getByTestId(`agent-wiki-row-${otherPrivateKbId}`)).toHaveCount(0)

  const bindings = await prisma.agentConnector.findMany({ where: { agentId } })
  const shared = bindings.find((row) => row.connectorId === sharedKbId)!
  const priv = bindings.find((row) => row.connectorId === own.id)!
  expect([shared.wikiAccess, shared.wikiWriteMode, shared.accessMode, shared.wikiCollectFocus]).toEqual(['write', 'approval', 'write', 'Termékadatlapok és árak'])
  expect([priv.wikiAccess, priv.wikiWriteMode, priv.wikiCollectFocus]).toEqual(['submit', 'direct', 'Leletek'])
})

test('privát nézet admin szemmel: csak metaadat-sor, a tartalom és a letöltés nem érhető el', async ({ page, request }) => {
  await page.goto('/control-plane/knowledge')
  const meta = page.getByTestId('kb-row-private-meta')
  await expect(meta).toHaveCount(1)
  await expect(meta).toContainText('Másik Tulajdonos')
  await expect(meta).toContainText('1 forrás · 1 oldal')
  await expect(page.locator('body')).not.toContainText('Titkos leletek')

  // A control-plane `loading.tsx` miatt a válasz streamelt (200), a tartalom a 404-es nézet.
  for (const query of ['', '?tab=inbox', '?tab=log', '?tab=settings', '?page=conditions/cukorbetegseg.md']) {
    await page.goto(`/control-plane/knowledge/${otherPrivateKbId}${query}`)
    await expect(page.getByText('Ez az oldal nincs meg')).toBeVisible()
    await expect(page.getByTestId('wiki-title')).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText('Cukorbetegség')
    await expect(page.locator('body')).not.toContainText('Titkos leletek')
    await expect(page.locator('body')).not.toContainText('vercukor')
  }
  const zip = await request.get(`/api/control-plane/knowledge/${otherPrivateKbId}/export`)
  expect(zip.status()).toBe(404)
})
