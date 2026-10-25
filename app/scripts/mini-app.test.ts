/**
 * Mini appok MCP-n (#967): service + MCP-eszközök + link-token + keretoldal +
 * ember-hozzáférés + szervezeti beállítás, memóriabeli store-ral.
 * Futtatás: npm run test:mini-app
 */
import assert from 'node:assert/strict'
import type { AgentDefinition } from '../src/domain/agent-definition'
import { lintMiniAppHtml, miniAppContentHash, guideConflicts } from '../src/domain/mini-app/html-lint'
import { signMiniAppLink, verifyMiniAppLink } from '../src/domain/mini-app/link-token'
import { MiniAppService } from '../src/domain/mini-app/mini-app-service'
import { invokeMiniAppTool, MCP_MINI_APP_SHARE_TOOL, type MiniAppMcpDeps } from '../src/domain/mini-app/mcp'
import { miniAppHumanAccess } from '../src/domain/mini-app/human-access'
import {
  miniAppBarParts,
  miniAppContentCsp,
  renderMiniAppExpiredPage,
  renderMiniAppFrame,
  withStaticMiniAppBar,
} from '../src/domain/mini-app/frame'
import { parseHandoffLinks } from '../src/domain/handoff/handoff-service'
import { DEFAULT_MINI_APP_LINK_TTL, readMiniAppSettings, withMiniAppSettings } from '../src/lib/mini-app-settings'
import type {
  MiniAppRecord,
  MiniAppShareRecord,
  MiniAppStore,
  MiniAppVersionMeta,
  MiniAppVersionRecord,
  MiniAppVisibility,
  NewMiniAppVersion,
} from '../src/domain/mini-app/types'

const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999'
const REKA = '22222222-2222-4222-8222-222222222222'
const ZOLI = '33333333-3333-4333-8333-333333333333'
const KATI = '44444444-4444-4444-8444-444444444444'
const REKA_DEF = '55555555-5555-4555-8555-555555555555'
const ZOLI_DEF = '66666666-6666-4666-8666-666666666666'
const KATI_DEF = '77777777-7777-4777-8777-777777777777'
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MARKER = 'EGYEDI-MARKER-7f3a9c'
const HTML = `<!doctype html><html><head><title>R</title></head><body><h1>Riport</h1><p>${MARKER}</p></body></html>`

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => console.log(`  OK  ${name}`))
    .catch((e: unknown) => {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.stack ?? e.message : e}`)
    })
}

class MemStore implements MiniAppStore {
  apps = new Map<string, MiniAppRecord & { createKey: string | null }>()
  versions: Array<MiniAppVersionRecord & { idempotencyKey: string | null }> = []
  shares: Array<MiniAppShareRecord & { revokedAt: Date | null; tenantId: string }> = []

  async findById(tenantId: string, appId: string) {
    const app = this.apps.get(appId)
    return app && app.tenantId === tenantId ? strip(app) : null
  }
  async findByCreateKey(tenantId: string, ownerAgentId: string, key: string) {
    const app = [...this.apps.values()].find((a) => a.tenantId === tenantId && a.ownerAgentId === ownerAgentId && a.createKey === key)
    return app ? strip(app) : null
  }
  async createWithVersion(input: Parameters<MiniAppStore['createWithVersion']>[0]) {
    const existing = await this.findByCreateKey(input.tenantId, input.ownerAgentId, input.createIdempotencyKey)
    if (existing) return { app: existing, created: false }
    const now = new Date()
    const app = {
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      ownerAgentId: input.ownerAgentId,
      projectKey: input.projectKey,
      name: input.name,
      description: input.description,
      status: 'active' as const,
      visibility: 'private' as MiniAppVisibility,
      currentVersion: 1,
      copiedFromAppId: input.copiedFromAppId,
      copiedFromVersion: input.copiedFromVersion,
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      createKey: input.createIdempotencyKey,
    }
    this.apps.set(app.id, app)
    this.pushVersion(app.id, 1, input.version)
    return { app: strip(app), created: true }
  }
  private pushVersion(appId: string, version: number, v: NewMiniAppVersion) {
    const row = { id: crypto.randomUUID(), appId, version, createdAt: new Date(), ...v }
    this.versions.push(row)
    return row
  }
  async findVersion(appId: string, version: number) {
    return this.versions.find((v) => v.appId === appId && v.version === version) ?? null
  }
  async findVersionByKey(appId: string, key: string) {
    return this.versions.find((v) => v.appId === appId && v.idempotencyKey === key) ?? null
  }
  async listVersions(appId: string): Promise<MiniAppVersionMeta[]> {
    return this.versions.filter((v) => v.appId === appId).sort((a, b) => b.version - a.version)
  }
  async addVersion(input: Parameters<MiniAppStore['addVersion']>[0]) {
    const app = this.apps.get(input.appId)!
    if (app.currentVersion !== input.expectedCurrentVersion) return 'conflict' as const
    app.currentVersion += 1
    app.updatedAt = new Date()
    return this.pushVersion(app.id, app.currentVersion, input.version)
  }
  async listVisibleToAgent(input: Parameters<MiniAppStore['listVisibleToAgent']>[0]) {
    const rows = [...this.apps.values()].filter((app) => {
      if (app.tenantId !== input.tenantId) return false
      const mine = app.ownerAgentId === input.agentId
      const shared = this.shares.some((s) => s.appId === app.id && s.agentId === input.agentId && !s.revokedAt) || app.visibility === 'organization'
      const relation = input.scope === 'mine' ? mine : input.scope === 'shared_with_me' ? !mine && shared : mine || shared
      const status = app.status === 'active' || (input.includeArchived && mine)
      return relation && status
    })
    return rows.slice(input.offset, input.offset + input.limit).map(strip)
  }
  async listActiveShares(appId: string) {
    return this.shares.filter((s) => s.appId === appId && !s.revokedAt)
  }
  async hasActiveShare(appId: string, agentId: string) {
    return this.shares.some((s) => s.appId === appId && s.agentId === agentId && !s.revokedAt)
  }
  async activateShares(input: { tenantId: string; appId: string; agentIds: string[]; sharedByUserId: string }) {
    const newly: string[] = []
    for (const agentId of input.agentIds) {
      const row = this.shares.find((s) => s.appId === input.appId && s.agentId === agentId)
      if (row && !row.revokedAt) continue
      if (row) row.revokedAt = null
      else this.shares.push({ appId: input.appId, agentId, sharedByUserId: input.sharedByUserId, createdAt: new Date(), revokedAt: null, tenantId: input.tenantId })
      newly.push(agentId)
    }
    return newly
  }
  async revokeShares(appId: string, agentIds: string[]) {
    const revoked: string[] = []
    for (const s of this.shares) {
      if (s.appId === appId && agentIds.includes(s.agentId) && !s.revokedAt) {
        s.revokedAt = new Date()
        revoked.push(s.agentId)
      }
    }
    return revoked
  }
  async setVisibility(appId: string, visibility: MiniAppVisibility) {
    this.apps.get(appId)!.visibility = visibility
  }
  async setStatus(appId: string, status: 'active' | 'archived', archivedAt: Date | null) {
    const app = this.apps.get(appId)!
    app.status = status
    app.archivedAt = archivedAt
  }
  async purgeArchivedBefore(cutoff: Date) {
    const gone = [...this.apps.values()].filter((a) => a.status === 'archived' && a.archivedAt && a.archivedAt < cutoff)
    for (const app of gone) this.apps.delete(app.id)
    return gone.map((a) => ({ id: a.id, tenantId: a.tenantId }))
  }
}

function strip(app: MiniAppRecord & { createKey?: string | null }): MiniAppRecord {
  const copy = { ...app }
  delete copy.createKey
  return copy
}

type AuditRow = { action: string; metadata?: unknown; targetId?: string | null }

function setup(opts: { maxBytes?: number } = {}) {
  const store = new MemStore()
  const audit: AuditRow[] = []
  const names = new Map([[REKA, 'Réka'], [ZOLI, 'Zoli'], [KATI, 'Kati']])
  const service = new MiniAppService({
    store,
    agentNames: async (_tenantId, ids) => new Map(ids.filter((id) => names.has(id)).map((id) => [id, names.get(id)!])),
    settings: async () => ({ linkTtl: '7d', maxBytes: opts.maxBytes ?? 1024 * 1024 }),
    links: {
      mint: (input) => {
        const expiresAt = Date.now() + input.ttlMs
        const token = signMiniAppLink({ ...input, expiresAt })
        return { openUrl: `https://apps.test/api/mini-apps/open/${token}`, openUrlExpiresAt: new Date(expiresAt).toISOString(), permanentUrl: `https://app.test/control-plane/mini-apps/${input.appId}` }
      },
      permanentUrl: (appId) => `https://app.test/control-plane/mini-apps/${appId}`,
    },
    audit: { append: async (row) => { audit.push(row) } },
  })
  const definitions: Record<string, AgentDefinition> = {
    [REKA_DEF]: def(REKA_DEF, REKA, 'Réka', 'Céges színek: zöld. Betűtípus: https://fonts.googleapis.com/css?family=Inter'),
    [ZOLI_DEF]: def(ZOLI_DEF, ZOLI, 'Zoli'),
    [KATI_DEF]: def(KATI_DEF, KATI, 'Kati'),
  }
  const handoffs: Array<{ toAgentId: string | null; links: string | null; title: string }> = []
  const mcpDeps: MiniAppMcpDeps = {
    loadDefinition: async ({ definitionId }) => definitions[definitionId] ?? null,
    loadDefinitionByAgent: async ({ agentId }) => Object.values(definitions).find((d) => d.agentId === agentId) ?? null,
    findCurrentDefinitionId: async ({ agentId }) => Object.values(definitions).find((d) => d.agentId === agentId)?.definitionId ?? null,
    findAgentGrant: async () => ({ accessLevel: 'operate' }),
    canViewAgent: async () => true,
    handoffs: {
      insert: async (input) => {
        handoffs.push(input)
        return { id: crypto.randomUUID() }
      },
      findById: async () => null,
      attachMemory: async () => {},
      decide: async () => null,
    },
    audit: { append: async (row) => { audit.push(row) } },
    miniApps: service,
  }
  return { store, service, audit, mcpDeps, handoffs }
}

function def(definitionId: string, agentId: string, name: string, miniAppGuide?: string): AgentDefinition {
  return {
    definitionId,
    agentId,
    version: 3,
    tenantId: TENANT,
    status: 'active',
    publishedAt: '2026-10-24T00:00:00.000Z',
    snapshot: { name, roleInstruction: 'x', skills: [], connectors: [], capabilities: [], ...(miniAppGuide ? { miniAppGuide } : {}) },
  }
}

const principal = { userId: ANNA, tenantId: TENANT, role: 'operator', assumed: false }

async function call(deps: MiniAppMcpDeps, toolName: string, args: Record<string, unknown>) {
  const result = await invokeMiniAppTool(deps, { principal, toolName, args })
  const first = result.content[0]
  assert.equal(first?.type, 'text')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tool-válasz szabad alakú JSON
  return { result, payload: JSON.parse((first as { text: string }).text) as Record<string, any> }
}

async function main() {
  await check('lint: hard-fail és figyelmeztetés kódok', () => {
    assert.deepEqual(lintMiniAppHtml('<iframe src=x></iframe><form>').errors, ['iframe_tag', 'form_tag'])
    assert.deepEqual(lintMiniAppHtml('<script src="https://cdn/x.js"></script><script>fetch("/a")</script>').warnings, ['external_script', 'fetch_call'])
    assert.equal(miniAppContentHash('a\r\nb'), miniAppContentHash('a\nb'))
    assert.ok(guideConflicts('Töltsd be: https://fonts.googleapis.com/css').includes('external_resource'))
  })

  await check('link-token: aláírás, lejárat, manipuláció', () => {
    const token = signMiniAppLink({ tenantId: TENANT, appId: REKA, version: 2, contentHash: 'h', expiresAt: Date.now() + 1000, requesterUserId: ANNA })
    const ok = verifyMiniAppLink(token)
    assert.equal(ok.ok, true)
    const expired = verifyMiniAppLink(token, Date.now() + 5000)
    assert.equal(expired.ok, false)
    assert.equal(!expired.ok && expired.reason, 'expired')
    assert.equal(!expired.ok && expired.reason === 'expired' && expired.payload.a, REKA)
    const [body, sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ t: OTHER_TENANT, a: REKA, v: 2, h: 'h', exp: Date.now() + 1e6 })).toString('base64url')
    assert.deepEqual(verifyMiniAppLink(`${forged}.${sig}`), { ok: false, reason: 'invalid' })
    assert.deepEqual(verifyMiniAppLink(`${body}.x`), { ok: false, reason: 'invalid' })
    assert.deepEqual(verifyMiniAppLink('garbage'), { ok: false, reason: 'invalid' })
  })

  await check('AC1+2: create → link, ugyanaz az idempotencyKey → egy app, egy verzió', async () => {
    const { mcpDeps, store } = setup()
    const first = await call(mcpDeps, 'platform.mini_app.create', { definitionId: REKA_DEF, name: 'Havi értékesítés', html: HTML, idempotencyKey: 'k1' })
    assert.equal(first.payload.ok, true)
    assert.match(first.payload.openUrl, /^https:\/\/apps\.test\/api\/mini-apps\/open\//)
    assert.match(first.payload.permanentUrl, /\/control-plane\/mini-apps\//)
    assert.ok(first.result.content.some((c) => c.type === 'resource_link'))
    assert.ok(first.result.content.some((c) => c.type === 'text' && c.text.includes('megnyitása](')))
    const again = await call(mcpDeps, 'platform.mini_app.create', { definitionId: REKA_DEF, name: 'Havi értékesítés', html: HTML, idempotencyKey: 'k1' })
    assert.equal(again.payload.appId, first.payload.appId)
    assert.equal(again.payload.replayed, true)
    assert.equal(store.apps.size, 1)
    assert.equal(store.versions.length, 1)
  })

  await check('AC3: update azonos tartalommal → unchanged, nincs új verzió; új tartalom → 2. verzió', async () => {
    const { mcpDeps, store } = setup()
    const created = await call(mcpDeps, 'platform.mini_app.create', { definitionId: REKA_DEF, name: 'Riport', html: HTML, idempotencyKey: 'k1' })
    const same = await call(mcpDeps, 'platform.mini_app.update', { definitionId: REKA_DEF, appId: created.payload.appId, html: HTML.replace(/\n/g, '\r\n'), idempotencyKey: 'u1' })
    assert.equal(same.payload.unchanged, true)
    assert.equal(store.versions.length, 1)
    const next = await call(mcpDeps, 'platform.mini_app.update', { definitionId: REKA_DEF, appId: created.payload.appId, html: HTML + '<p>nov</p>', changeNote: 'november', idempotencyKey: 'u2' })
    assert.equal(next.payload.version, 2)
    const replay = await call(mcpDeps, 'platform.mini_app.update', { definitionId: REKA_DEF, appId: created.payload.appId, html: HTML + '<p>nov</p>', idempotencyKey: 'u2' })
    assert.equal(replay.payload.version, 2)
    assert.equal(store.versions.length, 2)
  })

  await check('AC4: túl nagy / <iframe> → érthető hiba, validation_failed audit, nincs rekord', async () => {
    const { mcpDeps, store, audit } = setup({ maxBytes: 100 })
    const big = await call(mcpDeps, 'platform.mini_app.create', { definitionId: REKA_DEF, name: 'Nagy', html: HTML, idempotencyKey: 'k1' })
    assert.equal(big.result.isError, true)
    assert.equal(big.payload.code, 'mini_app_too_large')
    assert.ok(big.payload.maxBytes === 100)
    const { mcpDeps: d2 } = setup()
    const bad = await call(d2, 'platform.mini_app.create', { definitionId: REKA_DEF, name: 'Iframe', html: '<iframe src="https://x"></iframe>', idempotencyKey: 'k2' })
    assert.equal(bad.payload.code, 'mini_app_validation_failed')
    assert.deepEqual(bad.payload.errors, ['iframe_tag'])
    assert.equal(store.apps.size, 0)
    assert.ok(audit.some((row) => row.action === 'mini_app.validation_failed'))
  })

  await check('AC6+7: nem megosztott / más tenant → not_found; megosztás után látja, visszavonás után nem; másolat megmarad', async () => {
    const { mcpDeps, store } = setup()
    const created = await call(mcpDeps, 'platform.mini_app.create', { definitionId: REKA_DEF, name: 'Riport', html: HTML, idempotencyKey: 'k1' })
    const appId = created.payload.appId as string
    assert.equal((await call(mcpDeps, 'platform.mini_app.get', { definitionId: ZOLI_DEF, appId })).payload.code, 'mini_app_not_found')
    const foreign = await mcpDeps.miniApps.get({ tenantId: OTHER_TENANT, agentId: REKA, userId: ANNA }, { appId })
    assert.equal(!foreign.ok && foreign.code, 'mini_app_not_found')

    const shared = await call(mcpDeps, MCP_MINI_APP_SHARE_TOOL, { definitionId: REKA_DEF, appId, toAgentIds: ZOLI, idempotencyKey: 's1' })
    assert.equal(shared.payload.visibility, 'agents')
    const list = await call(mcpDeps, 'platform.mini_app.list', { definitionId: ZOLI_DEF, scope: 'shared_with_me' })
    assert.equal(list.payload.apps.length, 1)
    assert.equal(list.payload.apps[0].relation, 'shared')
    assert.equal(list.payload.apps[0].ownerAgentName, 'Réka')
    const source = await call(mcpDeps, 'platform.mini_app.get', { definitionId: ZOLI_DEF, appId, include: 'source' })
    assert.equal(source.payload.source.trust, 'untrusted_content')
    assert.ok(source.payload.source.html.includes(MARKER))
    assert.equal(source.payload.openUrl, undefined)
    // Zoli nem szerkesztheti, de másolhat.
    assert.equal((await call(mcpDeps, 'platform.mini_app.update', { definitionId: ZOLI_DEF, appId, html: HTML + 'x', idempotencyKey: 'z1' })).payload.code, 'mini_app_not_owner')
    const copy = await call(mcpDeps, 'platform.mini_app.create', { definitionId: ZOLI_DEF, name: 'Zoli változata', copyFromAppId: appId, idempotencyKey: 'c1' })
    assert.equal(copy.payload.ok, true)
    const zoliMine = await call(mcpDeps, 'platform.mini_app.list', { definitionId: ZOLI_DEF, scope: 'mine' })
    assert.match(zoliMine.payload.apps[0].copiedFrom, /^Réka \/ Riport v1$/)

    const unshared = await call(mcpDeps, 'platform.mini_app.unshare', { definitionId: REKA_DEF, appId, fromAgentIds: ZOLI })
    assert.deepEqual(unshared.payload.revokedAgentIds, [ZOLI])
    assert.equal(unshared.payload.visibility, 'private')
    assert.equal((await call(mcpDeps, 'platform.mini_app.list', { definitionId: ZOLI_DEF, scope: 'shared_with_me' })).payload.apps.length, 0)
    assert.equal((await call(mcpDeps, 'platform.mini_app.get', { definitionId: ZOLI_DEF, appId })).payload.code, 'mini_app_not_found')
    assert.equal(store.apps.size, 2, 'a másolat megmaradt')
  })

  await check('AC8: notify=true → átadás mini_app: linkkel; share csak látható célpontnak', async () => {
    const { mcpDeps, handoffs } = setup()
    const created = await call(mcpDeps, 'platform.mini_app.create', { definitionId: REKA_DEF, name: 'Riport, október', html: HTML, idempotencyKey: 'k1' })
    const appId = created.payload.appId as string
    const out = await call(mcpDeps, MCP_MINI_APP_SHARE_TOOL, { definitionId: REKA_DEF, appId, toAgentIds: ZOLI, notify: true, message: 'Írd meg az ügyfél-összefoglalót.', idempotencyKey: 's1' })
    assert.equal(out.payload.handoffIds.length, 1)
    assert.equal(handoffs[0]?.toAgentId, ZOLI)
    const parsed = parseHandoffLinks(handoffs[0]!.links)
    assert.equal(parsed[0]?.kind, 'mini_app')
    assert.equal(parsed[0]?.href, `mini_app:${appId}`)
    const retry = await call(mcpDeps, MCP_MINI_APP_SHARE_TOOL, { definitionId: REKA_DEF, appId, toAgentIds: ZOLI, notify: true, idempotencyKey: 's1' })
    assert.equal(retry.payload.handoffIds, undefined)
    assert.equal(handoffs.length, 1)

    const hidden = await call({ ...mcpDeps, canViewAgent: async () => false }, MCP_MINI_APP_SHARE_TOOL, { definitionId: REKA_DEF, appId, toAgentIds: KATI, idempotencyKey: 's2' })
    assert.equal(hidden.payload.code, 'share_target_not_visible')
    const none = await call(mcpDeps, MCP_MINI_APP_SHARE_TOOL, { definitionId: REKA_DEF, appId, idempotencyKey: 's3' })
    assert.equal(none.payload.code, 'share_target_required')
  })

  await check('AC9: organization=true → harmadik agent is látja; unshare organization → már nem', async () => {
    const { mcpDeps } = setup()
    const created = await call(mcpDeps, 'platform.mini_app.create', { definitionId: REKA_DEF, name: 'KPI', html: HTML, idempotencyKey: 'k1' })
    const appId = created.payload.appId as string
    const org = await call(mcpDeps, MCP_MINI_APP_SHARE_TOOL, { definitionId: REKA_DEF, appId, organization: true, idempotencyKey: 's1' })
    assert.equal(org.payload.visibility, 'organization')
    assert.match(org.payload.note, /future/)
    const kati = await call(mcpDeps, 'platform.mini_app.list', { definitionId: KATI_DEF })
    assert.equal(kati.payload.apps[0].relation, 'organization')
    assert.equal((await call(mcpDeps, 'platform.mini_app.get', { definitionId: KATI_DEF, appId })).payload.ok, true)
    await call(mcpDeps, 'platform.mini_app.unshare', { definitionId: REKA_DEF, appId, organization: true })
    assert.equal((await call(mcpDeps, 'platform.mini_app.get', { definitionId: KATI_DEF, appId })).payload.code, 'mini_app_not_found')
  })

  await check('AC10: guide — platformRules + publikált útmutató + ütközés; útmutató nélkül null', async () => {
    const { mcpDeps } = setup()
    const reka = await call(mcpDeps, 'platform.mini_app.guide', { definitionId: REKA_DEF })
    assert.match(reka.payload.platformRules, /egyetlen önálló HTML-fájl/)
    assert.match(reka.payload.agentGuide, /Céges színek/)
    assert.equal(reka.payload.agentGuideVersion, 3)
    assert.equal(reka.payload.organizationGuide, null)
    assert.ok(reka.payload.conflicts.includes('external_resource'))
    const zoli = await call(mcpDeps, 'platform.mini_app.guide', { definitionId: ZOLI_DEF })
    assert.equal(zoli.payload.agentGuide, null)
    assert.equal(zoli.payload.conflicts, undefined)
  })

  await check('archive: listából eltűnik, get → archived, megosztott nem látja; restore visszahozza; 90 nap után purge', async () => {
    const { mcpDeps, service, store } = setup()
    const created = await call(mcpDeps, 'platform.mini_app.create', { definitionId: REKA_DEF, name: 'Régi', html: HTML, idempotencyKey: 'k1' })
    const appId = created.payload.appId as string
    await call(mcpDeps, MCP_MINI_APP_SHARE_TOOL, { definitionId: REKA_DEF, appId, toAgentIds: ZOLI, idempotencyKey: 's1' })
    await call(mcpDeps, 'platform.mini_app.archive', { definitionId: REKA_DEF, appId })
    assert.equal((await call(mcpDeps, 'platform.mini_app.list', { definitionId: REKA_DEF })).payload.apps.length, 0)
    assert.equal((await call(mcpDeps, 'platform.mini_app.list', { definitionId: REKA_DEF, includeArchived: true })).payload.apps.length, 1)
    assert.equal((await call(mcpDeps, 'platform.mini_app.get', { definitionId: REKA_DEF, appId })).payload.code, 'mini_app_archived')
    assert.equal((await call(mcpDeps, 'platform.mini_app.get', { definitionId: ZOLI_DEF, appId })).payload.code, 'mini_app_not_found')
    await service.restore({ tenantId: TENANT, agentId: REKA, userId: ANNA }, { appId })
    assert.equal((await call(mcpDeps, 'platform.mini_app.get', { definitionId: ZOLI_DEF, appId })).payload.ok, true)
    await service.archive({ tenantId: TENANT, agentId: REKA, userId: ANNA }, { appId })
    store.apps.get(appId)!.archivedAt = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000)
    assert.deepEqual(await service.purgeExpiredArchives(), { deleted: 1 })
    assert.equal(store.apps.size, 0)
  })

  await check('source lapozás (D9): offset/nextOffset', async () => {
    const { service } = setup()
    const big = `<html><body>${'x'.repeat(150_000)}</body></html>`
    const actor = { tenantId: TENANT, agentId: REKA, userId: ANNA }
    const created = await service.create(actor, { name: 'Hosszú', html: big, idempotencyKey: 'k' })
    assert.ok(created.ok)
    const first = await service.get(actor, { appId: created.app.id, include: 'source' })
    assert.ok(first.ok && first.source)
    assert.equal(first.source.html.length, 100_000)
    assert.equal(first.source.nextOffset, 100_000)
    const second = await service.get(actor, { appId: created.app.id, include: 'source', offset: first.source.nextOffset! })
    assert.ok(second.ok && second.source)
    assert.equal(second.source.nextOffset, null)
    assert.equal(first.source.html + second.source.html, big)
  })

  await check('AC12: az audit-sorokban sehol nincs HTML-tartalom', async () => {
    const { mcpDeps, audit } = setup()
    const created = await call(mcpDeps, 'platform.mini_app.create', { definitionId: REKA_DEF, name: 'Riport', html: HTML, idempotencyKey: 'k1' })
    await call(mcpDeps, 'platform.mini_app.update', { definitionId: REKA_DEF, appId: created.payload.appId, html: HTML + '<p>2</p>', idempotencyKey: 'u1' })
    await call(mcpDeps, 'platform.mini_app.get', { definitionId: REKA_DEF, appId: created.payload.appId, include: 'both' })
    assert.ok(audit.length >= 4)
    assert.equal(JSON.stringify(audit).includes(MARKER), false)
    assert.ok(audit.some((row) => row.action === 'mini_app.created'))
    assert.ok(audit.some((row) => row.action === 'mini_app.version_added'))
    assert.ok(audit.some((row) => row.action === 'mini_app.opened'))
  })

  await check('nem futó / elavult definíció és operate-jog nélküli hívó elutasítva', async () => {
    const { mcpDeps } = setup()
    const noGrant = await call({ ...mcpDeps, findAgentGrant: async () => ({ accessLevel: 'view' }) }, 'platform.mini_app.list', { definitionId: REKA_DEF })
    assert.equal(noGrant.payload.code, 'agent_access_denied')
    const stale = await call({ ...mcpDeps, findCurrentDefinitionId: async () => crypto.randomUUID() }, 'platform.mini_app.list', { definitionId: REKA_DEF })
    assert.equal(stale.payload.code, 'agent_stale')
    const badArgs = await call(mcpDeps, MCP_MINI_APP_SHARE_TOOL, { definitionId: REKA_DEF, appId: REKA, toAgentIds: 'nem-uuid', idempotencyKey: 'x' })
    assert.equal(badArgs.payload.code, 'invalid_args')
  })

  await check('AC11 / D13: keretoldal sávval, sandboxolt iframe; letöltésbe statikus sáv; lejárt-oldal név nélkül', () => {
    const bar = {
      name: 'Havi <értékesítés>',
      createdAt: new Date('2026-10-24T08:12:00Z'),
      versionCreatedAt: new Date('2026-10-27T07:40:00Z'),
      ownerAgentName: 'Réka',
      version: 2,
      currentVersion: 3,
    }
    const parts = miniAppBarParts(bar)
    assert.equal(parts[0], 'Készült: 2026. 10. 24. 10:12')
    assert.match(parts[1]!, /^Utoljára módosítva: 2026\. 10\. 27\. 08:40$/)
    assert.ok(parts.includes('Ez a 2. verzió — van újabb (3.)'))
    assert.equal(miniAppBarParts({ ...bar, version: 1, currentVersion: 1 }).some((p) => p.startsWith('Utoljára')), false)
    const frame = renderMiniAppFrame({ ...bar, contentUrl: '/api/mini-apps/content/tok' })
    assert.match(frame, /<iframe src="\/api\/mini-apps\/content\/tok" sandbox="allow-scripts"/)
    assert.ok(frame.includes('Havi &lt;értékesítés&gt;'))
    assert.equal(frame.includes('allow-same-origin'), false)
    const downloaded = withStaticMiniAppBar(HTML, bar)
    assert.ok(downloaded.indexOf('data-mini-app-bar') > downloaded.indexOf('<body>'))
    const expired = renderMiniAppExpiredPage({ permanentUrl: 'https://app.test/control-plane/mini-apps/x', reason: 'expired' })
    assert.match(expired, /Ez a link lejárt\./)
    assert.match(expired, /Megnyitás a platformon/)
    assert.equal(expired.includes('értékesítés'), false)
    const csp = miniAppContentCsp()
    for (const directive of ["connect-src 'none'", 'sandbox allow-scripts', "form-action 'none'", "default-src 'none'", 'frame-ancestors *']) assert.ok(csp.includes(directive), directive)
  })

  await check('ember-hozzáférés: kezelő / látó / szervezeti / megosztott / idegen', async () => {
    const app: MiniAppRecord = {
      id: crypto.randomUUID(), tenantId: TENANT, ownerAgentId: REKA, projectKey: '__general__', name: 'R', description: null,
      status: 'active', visibility: 'private', currentVersion: 1, copiedFromAppId: null, copiedFromVersion: null,
      createdByUserId: ANNA, createdAt: new Date(), updatedAt: new Date(), archivedAt: null,
    }
    const grants = new Map<string, string>()
    const deps = { findAgentGrant: async ({ agentId }: { agentId: string }) => (grants.has(agentId) ? { accessLevel: grants.get(agentId)! } : null), listActiveShareAgentIds: async () => [ZOLI] }
    const viewer = { tenantId: TENANT, userId: ANNA, role: 'operator' }
    assert.equal(await miniAppHumanAccess(deps, { ...viewer, role: 'admin' }, app), 'manage')
    assert.equal(await miniAppHumanAccess(deps, viewer, app), null)
    grants.set(ZOLI, 'view')
    assert.equal(await miniAppHumanAccess(deps, viewer, app), 'view', 'a megosztott címzettet látja')
    grants.clear()
    assert.equal(await miniAppHumanAccess(deps, viewer, { ...app, visibility: 'organization' }), 'view')
    grants.set(REKA, 'operate')
    assert.equal(await miniAppHumanAccess(deps, viewer, app), 'manage')
    assert.equal(await miniAppHumanAccess(deps, viewer, { ...app, tenantId: OTHER_TENANT }), null)
    grants.set(REKA, 'view')
    assert.equal(await miniAppHumanAccess(deps, viewer, { ...app, status: 'archived' }), null, 'archiváltat csak a kezelő lát')
  })

  await check('szervezeti beállítás: alap 7 nap / 1 MB, plafon, megőrzi a többi kulcsot', () => {
    assert.deepEqual(readMiniAppSettings({}), { linkTtl: DEFAULT_MINI_APP_LINK_TTL, maxBytes: 1024 * 1024 })
    assert.equal(DEFAULT_MINI_APP_LINK_TTL, '7d')
    assert.deepEqual(readMiniAppSettings({ miniApp: { linkTtl: '99d', maxBytes: 9e9 } }), { linkTtl: '7d', maxBytes: 1024 * 1024 })
    const next = withMiniAppSettings({ language: 'hu' }, { linkTtl: '1d', maxBytes: 512 * 1024 }) as Record<string, unknown>
    assert.equal(next.language, 'hu')
    assert.deepEqual(readMiniAppSettings(next), { linkTtl: '1d', maxBytes: 512 * 1024 })
  })

  if (failures > 0) {
    console.log(`\nmini-app: ${failures} failed`)
    process.exit(1)
  }
  console.log('\nmini-app: ok')
}

void main()
