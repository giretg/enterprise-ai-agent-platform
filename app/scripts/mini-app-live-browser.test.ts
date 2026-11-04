/**
 * Élő mini app valódi böngészőben (#1083 WP-8): a valódi route-ok kétszintű iframe-láncon,
 * tárolt adat nélkül (a repository és az adattárház helyettesítve). Kártékony cellaérték
 * nem tör ki és nem fut, az agent saját szkriptje viszont igen.
 *
 * Futtatás: npm run test:mini-app-browser
 * Böngészők: `npx playwright install chromium webkit firefox`; a hiányzó böngészőt jelzi és kihagyja.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, firefox, webkit, type BrowserType } from '@playwright/test'
import { GET as openRoute } from '../src/app/api/mini-apps/open/[token]/route'
import { GET as contentRoute } from '../src/app/api/mini-apps/content/[token]/route'
import { serializeLiveData } from '../src/domain/mini-app/data-binding'
import { buildMiniAppLiveDocument } from '../src/domain/mini-app/frame'
import { miniAppContentHash } from '../src/domain/mini-app/html-lint'
import { signMiniAppLink } from '../src/domain/mini-app/link-token'
import { miniAppLiveDeps } from '../src/lib/mini-app-live'
import { repositories } from '../src/repositories/postgres'

const TENANT = '11111111-1111-4111-8111-111111111111'
const AGENT = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'
const APP = '44444444-4444-4444-8444-444444444444'

/** Tipikus LLM-kód: textContent az egyik, a tiltott innerHTML a másik elemen, hogy a CSP-t önmagában is mérjük. */
const HTML = `<!doctype html><html><head><title>Riport</title></head><body>
<table id="safe"></table><div id="unsafe"></div>
<script>
var data = JSON.parse(document.getElementById('platform-data').textContent).bevetel;
data.rows.forEach(function (row) {
  var td = document.createElement('td');
  td.textContent = row[0];
  document.getElementById('safe').appendChild(document.createElement('tr')).appendChild(td);
  document.getElementById('unsafe').innerHTML += row[0];
});
var script = document.createElement('script');
script.textContent = 'document.body.setAttribute("data-injected-script", "ran")';
document.body.appendChild(script);
document.body.setAttribute('data-agent-script', 'ran');
document.body.setAttribute('data-truncated', String(data.truncated));
</script>
</body></html>`

const CELLS = [
  '</script><script>document.body.setAttribute("data-breakout", "ran")</script>',
  '<img src=x onerror="document.body.setAttribute(\'data-handler\', \'ran\')">',
  '<svg onload="document.body.setAttribute(\'data-handler\', \'ran\')"></svg>',
  '<script>document.body.setAttribute("data-inner-script", "ran")</script>',
  'Kovács & Társa <b>Kft.</b>',
]

function stub(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { value, configurable: true, writable: true })
}

async function main() {
  const contentHash = miniAppContentHash(HTML)
  const version = { version: 1, html: HTML, contentHash, createdAt: new Date(), dataBindings: [{ alias: 'bevetel', queryId: APP, queryVersion: 1, params: {}, maxRows: 10 }] }
  stub(repositories.miniApps, 'findById', async () => ({ id: APP, tenantId: TENANT, status: 'active', ownerAgentId: AGENT, name: 'Élő riport', createdAt: new Date(), currentVersion: 1 }))
  stub(repositories.miniApps, 'findVersion', async () => version)
  stub(repositories.agents, 'findById', async () => ({ retiredAt: null, name: 'Réka' }))
  stub(repositories.audit, 'append', async () => undefined)
  stub(repositories.tenantMemberships, 'findByTenantAndUser', async () => ({ role: 'viewer', status: 'active' }))
  stub(repositories.tenants, 'findById', async () => ({ settings: {} }))
  miniAppLiveDeps.runBoundQuery = async () => ({
    columns: ['nev'],
    columnLabels: ['Név'],
    rows: CELLS.map((cell) => [cell]),
    truncated: true,
    bytes: 500,
    dataAsOf: '2026-11-03T13:20:00.000Z',
    warnings: [{ code: 'open_exceptions', dataset: 'd', detail: { count: 3 } }],
    schemaStatus: 'current',
    version: 1,
    currentVersion: 1,
  })

  // A letöltött fájlt nem védi válaszfejléc: csak a saját meta-CSP-je.
  const downloaded = buildMiniAppLiveDocument(HTML, {
    dataJson: serializeLiveData({ bevetel: { status: 'ok', columns: ['nev'], columnLabels: ['Név'], rows: CELLS.map((cell) => [cell]), truncated: true, dataAsOf: null, warnings: [] } }),
    meta: true,
  }).html
  let egressHits = 0
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1')
    if (url.pathname === '/downloaded.html') return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(downloaded)
    if (url.pathname === '/egress') {
      egressHits += 1
      return void res.writeHead(204).end()
    }
    const [, , , kind, token] = url.pathname.split('/')
    const handler = kind === 'open' ? openRoute : kind === 'content' ? contentRoute : null
    if (!handler || !token) return void res.writeHead(404).end()
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value)
    const response = await handler(new Request(`http://127.0.0.1${req.url}`, { headers }), { params: Promise.resolve({ token }) })
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    res.end(await response.text())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  // A keretoldal CSP-je a mini app originre szűkít, ezért a teszt szerver címe kell ide.
  process.env.MINI_APP_ORIGIN = `http://127.0.0.1:${port}`
  process.env.NEXT_PUBLIC_APP_URL = `http://127.0.0.1:${port}`

  const token = signMiniAppLink({ tenantId: TENANT, appId: APP, version: 1, contentHash, requesterUserId: USER, expiresAt: Date.now() + 3_000_000 })
  let measured = 0
  for (const [label, type] of [['chromium', chromium], ['webkit', webkit], ['firefox', firefox]] as Array<[string, BrowserType]>) {
    const browser = await type.launch().catch((error: unknown) => {
      console.log(`  KIHAGYVA ${label}: ${String((error as Error).message).split('\n')[0]}`)
      return null
    })
    if (!browser) continue
    const page = await browser.newPage()
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(error.message))
    const opened = await page.goto(`http://127.0.0.1:${port}/api/mini-apps/open/${token}`)
    assert.equal(opened?.status(), 200, label)
    const bar = (await page.locator('[data-mini-app-bar]').innerText()).replace(/\s+/g, ' ')
    for (const part of ['Élő adat', 'Utolsó betöltés', '3 megoldatlan adategyezés', 'Az egyik lekérdezésből csak az első 5 sor látszik']) assert.ok(bar.includes(part), `${label}: sáv: ${part} (${bar})`)
    const frame = page.frames().find((candidate) => candidate.url().includes('/content/'))
    assert.ok(frame, `${label}: a tartalom-iframe betölt`)
    await frame.waitForSelector('body[data-agent-script="ran"]', { state: 'attached', timeout: 5_000 })
    await page.waitForTimeout(300)
    const state = await frame.evaluate(() => ({
      attrs: Object.fromEntries([...document.body.attributes].map((attribute) => [attribute.name, attribute.value])),
      cells: [...document.querySelectorAll('#safe td')].map((cell) => cell.textContent),
      storedInner: document.getElementById('unsafe')!.innerHTML.length > 0,
    }))
    assert.equal(state.attrs['data-agent-script'], 'ran', `${label}: az agent saját szkriptje fut`)
    assert.equal(state.attrs['data-truncated'], 'true', `${label}: truncated eljut az appig`)
    assert.deepEqual(state.cells, CELLS, `${label}: a cellaérték szövegként, változatlanul látszik`)
    assert.ok(state.storedInner, `${label}: az innerHTML lefutott, tehát a mérés a CSP-t méri`)
    for (const attribute of ['data-breakout', 'data-handler', 'data-inner-script', 'data-injected-script']) assert.equal(state.attrs[attribute], undefined, `${label}: ${attribute}`)

    // A letöltött fájl: az agent-szkript fut, cellaérték nem, a hálózat zárva.
    const file = await browser.newPage()
    await file.goto(`http://127.0.0.1:${port}/downloaded.html`)
    await file.waitForSelector('body[data-agent-script="ran"]', { state: 'attached', timeout: 5_000 })
    await file.waitForTimeout(300)
    const fileAttrs = await file.evaluate(() => Object.fromEntries([...document.body.attributes].map((attribute) => [attribute.name, attribute.value])))
    for (const attribute of ['data-breakout', 'data-handler', 'data-inner-script', 'data-injected-script']) assert.equal(fileAttrs[attribute], undefined, `${label}: letöltött fájl: ${attribute}`)
    const fetched = await file.evaluate(() => fetch('/egress').then(() => 'open', () => 'blocked'))
    assert.equal(fetched, 'blocked', `${label}: letöltött fájl: fetch`)
    assert.equal(egressHits, 0, `${label}: letöltött fájl: kimenő kérés`)
    await browser.close()
    measured += 1
    console.log(`  OK  ${label}: AC15 cellaérték nem tör ki és nem fut; agent-szkript fut; sáv kiírja az állapotot; a letöltött fájl meta-CSP-je ugyanígy véd`)
  }
  server.close()
  assert.ok(measured > 0, 'legalább egy böngésző kell')
  console.log(`\nmini-app-live-browser: ok (${measured} böngésző)`)
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
