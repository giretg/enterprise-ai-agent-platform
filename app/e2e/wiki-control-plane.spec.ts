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

test('olvasó nézet: csak cím, menü és tartalom; a Vissza az előző lapra és görgetési helyre visz', async ({ page }) => {
  const wiki = await prisma.agentWiki.create({ data: { connectorId: sharedKbId, schemaMd: '# WIKI' } })
  const filler = Array.from({ length: 120 }, (_, i) => `Bekezdés ${i + 1}.`).join('\n\n')
  await prisma.wikiPage.createMany({
    data: [
      { wikiId: wiki.id, connectorId: sharedKbId, path: 'concepts/elso.md', type: 'entity', title: 'Első lap', summary: 'Első', body: `${filler}\n\n[[concepts/masodik.md]]`, outLinks: ['concepts/masodik.md'], contentHash: `a-${suffix}` },
      { wikiId: wiki.id, connectorId: sharedKbId, path: 'concepts/masodik.md', type: 'entity', title: 'Második lap', summary: 'Második', body: 'Rövid szöveg.', contentHash: `b-${suffix}` },
    ],
  })

  // A normál nézetben nyitott lap a fülváltás után is nyitva marad.
  await page.goto(`/control-plane/knowledge/${sharedKbId}?page=concepts/elso.md`)
  await page.getByTestId('wiki-tab-reader').click()
  await expect(page).toHaveURL(/tab=reader/)
  await expect(page.getByTestId('wiki-reader')).toBeVisible()
  await expect(page.getByTestId('wiki-page')).toContainText('Első lap')

  // Felül csak a cím marad: se fülsor, se „kik látják”, se lap-adminisztráció.
  await expect(page.getByTestId('wiki-title')).toBeVisible()
  await expect(page.getByTestId('wiki-tab-wiki')).toHaveCount(0)
  await expect(page.getByTestId('wiki-who-sees')).toHaveCount(0)
  await expect(page.getByTestId('wiki-page-meta')).toHaveCount(0)
  const titleBox = await page.getByTestId('wiki-title').boundingBox()
  const tocBox = await page.getByTestId('wiki-toc').boundingBox()
  expect(tocBox!.y - titleBox!.y).toBeLessThan(120)

  // Első lapnál nincs hova visszalépni.
  const back = page.getByTestId('wiki-reader-back')
  await expect(back).toBeDisabled()

  // A szövegbeli link olvasó nézetben marad, a Vissza a görgetési helyre tér vissza.
  const link = page.getByTestId('wiki-page').getByRole('link', { name: 'Második lap' }).first()
  await link.scrollIntoViewIfNeeded()
  const scrolled = await page.evaluate(() => window.scrollY)
  expect(scrolled).toBeGreaterThan(200)
  await link.click()
  await expect(page.getByTestId('wiki-page')).toContainText('Rövid szöveg.')
  await expect(page).toHaveURL(/tab=reader/)
  await expect(back).toBeEnabled()

  await back.click()
  await expect(page.getByTestId('wiki-page')).toContainText('Első lap')
  await expect(page).toHaveURL(/tab=reader/)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrolled - 50)
  await expect(back).toBeDisabled()

  // A menü linkje is olvasó nézetben marad; a bezárás ugyanazt a lapot mutatja normál nézetben.
  await page.getByTestId('wiki-toc').getByRole('link', { name: 'Második lap' }).click()
  await expect(page).toHaveURL(/tab=reader.*masodik/)
  await page.getByTestId('wiki-reader-exit').click()
  await expect(page.getByTestId('wiki-tab-wiki')).toBeVisible()
  await expect(page.getByTestId('wiki-page')).toContainText('Rövid szöveg.')
})

test('wiki-kommentek: panel, kijelölés idézetként, fül, Teendők-lista, kikapcsolt flag', async ({ page }) => {
  // A flag bekapcsolása a futó szerveren kb. 30 másodperc alatt érvényesül.
  test.setTimeout(240_000)
  const wiki = await prisma.agentWiki.upsert({ where: { connectorId: sharedKbId }, create: { connectorId: sharedKbId, schemaMd: '# WIKI' }, update: {} })
  const path = `concepts/komment-${suffix}.md`
  await prisma.wikiPage.create({
    data: { wikiId: wiki.id, connectorId: sharedKbId, path, type: 'entity', title: 'Kommentelt lap', summary: 'Lap', body: 'A jutalék 2% minden partnernél.', contentHash: `c-${suffix}` },
  })
  const url = `/control-plane/knowledge/${sharedKbId}?page=${path}`

  // Kikapcsolt flag: nincs panel és fül.
  await page.goto(url)
  await expect(page.getByTestId('wiki-page')).toContainText('A jutalék 2%')
  await expect(page.getByTestId('wiki-comments-panel')).toHaveCount(0)
  await expect(page.getByTestId('wiki-tab-comments')).toHaveCount(0)

  await prisma.featureFlag.upsert({
    where: { key: 'wiki.comments' },
    create: { key: 'wiki.comments', mode: 'selected', tenants: { create: { tenantId, access: 'included' } } },
    update: { mode: 'selected', tenants: { create: { tenantId, access: 'included' } } },
  })
  // A szerver a flaget legfeljebb kb. 30 másodperc alatt látja meg.
  await expect(async () => {
    await page.goto(url)
    await expect(page.getByTestId('wiki-comments-panel')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 45_000 })

  // Üres állapot, és jelzés, hogy nincs író AI-munkatárs.
  await expect(page.getByTestId('wiki-comments-empty')).toBeVisible()
  await expect(page.getByTestId('wiki-comment-no-writer')).toBeVisible()

  // A kijelölt szöveg idézetként a kommentbe kerül.
  await page.getByTestId('wiki-page').getByText('A jutalék 2% minden partnernél.').selectText()
  await page.getByTestId('wiki-comment-quote-selection').click()
  await expect(page.getByTestId('wiki-comment-draft-quote')).toContainText('A jutalék 2%')

  // A HTML és a Markdown szövegként jelenik meg.
  const markup = '<img src=x onerror="window.__xss=1"> **vastag** 2026 óta 3%'
  await page.getByTestId('wiki-comment-input').fill(markup)
  await page.getByTestId('wiki-comment-send').click()
  await expect(page.getByTestId('wiki-comment-body')).toHaveText(markup)
  await expect(page.getByTestId('wiki-comment').locator('img')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
  await expect(page.getByTestId('wiki-comment-quote')).toContainText('A jutalék 2%')
  await expect(page.getByTestId('wiki-page-comment-count')).toBeVisible()

  // Kártyaszám: érthető hiba, nem mentődik.
  await page.getByTestId('wiki-comment-input').fill('A kártyám 4111 1111 1111 1111')
  await page.getByTestId('wiki-comment-send').click()
  await expect(page.getByTestId('wiki-comment-error')).toBeVisible()
  await expect(page.getByTestId('wiki-comment')).toHaveCount(1)

  // A panel az olvasó fülön is ott van.
  await page.goto(`/control-plane/knowledge/${sharedKbId}?tab=reader&page=${path}`)
  await expect(page.getByTestId('wiki-comments-panel')).toBeVisible()

  // Kommentek fül: magyarázat, szűrők, a komment az oldal linkjével.
  await page.goto(`/control-plane/knowledge/${sharedKbId}?tab=comments`)
  await expect(page.getByTestId('wiki-comments-tab')).toBeVisible()
  await expect(page.getByTestId('wiki-comments-states')).toBeVisible()
  await expect(page.getByTestId('wiki-comments-tab-list').getByTestId('wiki-comment')).toHaveCount(1)
  await expect(page.getByTestId('wiki-comments-tab-list').getByRole('link', { name: 'Kommentelt lap' })).toBeVisible()

  // Az AI-munkatárs kérdez: a szerző Teendői között megjelenik, a válasz után eltűnik.
  const comment = await prisma.wikiComment.findFirstOrThrow({ where: { connectorId: sharedKbId } })
  await prisma.wikiComment.update({ where: { id: comment.id }, data: { status: 'question' } })
  await prisma.wikiCommentEvent.create({
    data: { commentId: comment.id, kind: 'status', fromStatus: 'open', toStatus: 'question', actorKind: 'agent', actorAgentId: agentId, body: 'Melyik szerződésre gondolsz?' },
  })
  await page.goto('/control-plane/operations')
  const todo = page.getByTestId('wiki-comment-todo')
  await expect(todo).toHaveAttribute('data-status', 'question')
  await expect(todo.getByTestId('wiki-comment-todo-answer')).toHaveText('Melyik szerződésre gondolsz?')
  await todo.getByTestId('wiki-comment-todo-answer-open').click()
  await todo.getByTestId('wiki-comment-todo-text').fill('A 2026-os módosításra.')
  await todo.getByTestId('wiki-comment-todo-send').click()
  await expect(page.getByTestId('wiki-comment-todos')).toHaveCount(0)
  expect((await prisma.wikiComment.findUniqueOrThrow({ where: { id: comment.id } })).status).toBe('open')

  // Az elutasítás a „Rendben”-ig látszik.
  await prisma.wikiComment.update({ where: { id: comment.id }, data: { status: 'declined', closedAt: new Date() } })
  await page.goto('/control-plane/operations')
  await expect(page.getByTestId('wiki-comment-todo')).toHaveAttribute('data-status', 'declined')
  await page.getByTestId('wiki-comment-todo-ok').click()
  await expect(page.getByTestId('wiki-comment-todos')).toHaveCount(0)
  expect((await prisma.wikiComment.findUniqueOrThrow({ where: { id: comment.id } })).status).toBe('declined')

  // A kezelő újranyitja és kézzel lezárja.
  await page.goto(url)
  await page.getByTestId('wiki-comment-reopen').click()
  await page.getByTestId('wiki-comment-action-text').fill('Mégis nézzük meg.')
  await page.getByTestId('wiki-comment-action-send').click()
  await expect(page.getByTestId('wiki-comment-status')).toHaveAttribute('data-status', 'open')
  await page.getByTestId('wiki-comment-close').click()
  await page.getByTestId('wiki-comment-action-text').fill('Megbeszéltük.')
  await page.getByTestId('wiki-comment-close-resolved').click()
  await expect(page.getByTestId('wiki-comment-status')).toHaveAttribute('data-status', 'resolved')
  await page.goto(url)

  // Törlés: a szöveg eltűnik, csak a nyoma marad.
  await page.getByTestId('wiki-comment-delete').click()
  await page.getByTestId('wiki-comment-delete-confirm').click()
  await expect(page.getByTestId('wiki-comment-erased')).toBeVisible()
})

test('a 10 MB-nál nagyobb fájl is felkerül a tálcára', async ({ page }) => {
  await page.goto(`/control-plane/knowledge/${sharedKbId}?tab=inbox`)
  await page.getByTestId('wiki-inbox-file-input').setInputFiles([
    { name: 'nagy-anyag.txt', mimeType: 'text/plain', buffer: Buffer.alloc(11 * 1024 * 1024, `Nagy anyag ${suffix} `) },
  ])
  await expect(page.getByTestId('wiki-upload-progress')).toContainText('1 új fájl a tálcán', { timeout: 120_000 })
})

test('tömeges feltöltés: 30 fájl egy mozdulattal a privát tudásbázis tálcájára', async ({ page }) => {
  await page.goto('/control-plane/knowledge')
  await page.getByTestId('kb-create-open').click()
  await page.getByTestId('kb-create-name').fill(`Leletek ${suffix}`)
  await page.getByTestId('kb-create-private').check()
  await page.getByTestId('kb-create-submit').click()
  await expect(page.getByTestId('wiki-title')).toHaveText(`Leletek ${suffix}`)
  await expect(page.getByTestId('wiki-files-empty')).toBeVisible()
  await page.getByTestId('wiki-tab-wiki').click()
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
  await expect(page.getByTestId('wiki-upload-progress')).toContainText('üres (0 bájt), ezért kimaradt: ures.txt')
  await expect(page.getByTestId('wiki-upload-progress')).toContainText('Egyik fájl sem került a tálcára.')
  await expect(page.getByTestId('wiki-upload-progress')).not.toContainText('Feltöltés:')
  await expect(page.getByRole('button', { name: 'Fájlok kiválasztása', exact: true })).toBeEnabled()

  // Felhős helyőrzőt utánoz: a böngésző nem tudja beolvasni a fájlt.
  await page.evaluate(() => {
    File.prototype.arrayBuffer = () => Promise.reject(new DOMException('nem olvasható', 'NotReadableError'))
  })
  await page.getByTestId('wiki-inbox-file-input').setInputFiles([
    { name: 'felhos.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('felho') },
  ])
  await expect(page.getByTestId('wiki-upload-progress')).toContainText('nem tudott beolvasni: felhos.xlsx')
  await expect(page.getByTestId('wiki-upload-progress')).toContainText('felhőmappában')
  await page.evaluate(() => {
    delete (File.prototype as { arrayBuffer?: unknown }).arrayBuffer
  })

  await page.route('**/control-plane/knowledge/**', async (route) => {
    if (route.request().method() === 'POST') await route.abort('failed')
    else await route.continue()
  })
  await page.getByTestId('wiki-inbox-file-input').setInputFiles([
    { name: 'kapcsolathiba.txt', mimeType: 'text/plain', buffer: Buffer.from('hiba') },
  ])
  await expect(page.getByTestId('wiki-upload-progress')).toContainText('megszakadt, ezért nem került a tálcára: kapcsolathiba.txt')
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

test('#1139 fájlok: a csak feltöltött fájl is látszik, a közös tudásbázis a saját fülén kezelhető', async ({ page }) => {
  // A wikibe nem szánt, egyszerű feltöltés: a tálcán és a wikiben nem jelenik meg.
  const raw = await prisma.document.create({
    data: { tenantId, filename: `tortak-${suffix}.md`, extractedText: 'Dobos torta', connectorId: sharedKbId, uploadedById: devUserId, status: 'processed', processingMode: 'raw_text_only', metadata: { purpose: 'Torták leírása' } },
  })
  await page.goto('/control-plane/knowledge')
  await expect(page.getByTestId('kb-list')).not.toContainText('kb:')
  const catalogRow = page.getByTestId('kb-row').filter({ hasText: 'Közös tudásbázis' })
  await expect(catalogRow).toContainText('nincs wiki')
  await expect(catalogRow).toContainText('Egy munkatárs sem használja')
  // A lista oldalon nincs többé fájl-feltöltő.
  await expect(page.getByTestId('kb-catalog-upload')).toHaveCount(0)

  await catalogRow.click()
  await expect(page.getByTestId('wiki-tab-files')).toHaveClass(/border-coral/)
  await expect(page.getByTestId('kb-catalog-upload')).toBeVisible()
  await page.getByTestId('wiki-tab-settings').click()
  await expect(page.getByText('A tudástár nyelve')).toBeVisible()

  await page.goto(`/control-plane/knowledge/${sharedKbId}`)
  const row = page.getByTestId('wiki-file-row').filter({ hasText: `tortak-${suffix}.md` })
  await expect(row).toContainText('Torták leírása')
  await expect(row).toContainText('Nincs a wikiben')
  await expect(page.getByTestId('wiki-files-manage-link')).toHaveAttribute('href', /tab=inbox/)

  await row.getByRole('link', { name: `tortak-${suffix}.md` }).click()
  await expect(page.getByTestId('wiki-source')).toContainText('Dobos torta')
  await page.getByRole('link', { name: '← Vissza a fájlokhoz' }).click()
  await expect(page.getByTestId('wiki-files')).toBeVisible()
  await prisma.document.delete({ where: { id: raw.id } })
})

test('privát nézet admin szemmel: csak metaadat-sor, a tartalom és a letöltés nem érhető el', async ({ page, request }) => {
  await page.goto('/control-plane/knowledge')
  const meta = page.getByTestId('kb-row-private-meta')
  await expect(meta).toHaveCount(1)
  await expect(meta).toContainText('Másik Tulajdonos')
  await expect(meta).toContainText('1 fájl · 1 wiki-oldal')
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
