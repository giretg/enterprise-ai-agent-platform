/**
 * Mini appok MCP-n (#967): service + MCP-eszközök + link-token + keretoldal +
 * ember-hozzáférés + szervezeti beállítás, memóriabeli store-ral.
 * Futtatás: npm run test:mini-app
 */
import { assertAuditMetadataSafe } from '../src/lib/audit/payload-guard'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentDefinition } from '../src/domain/agent-definition'
import { enterpriseToolErrorPayload } from '../src/domain/enterprise-tools'
import { inlineScriptBodies, scriptHashSource, serializeLiveData } from '../src/domain/mini-app/data-binding'
import { checkLiveAccess, createLiveRateLimiter, liveDeniedMessage, liveLinkTooLong, loadLiveData, type MiniAppLiveDataDeps } from '../src/domain/mini-app/live-data'
import { miniAppLiveDeps } from '../src/lib/mini-app-live'
import { lintBoundMiniAppHtml, lintMiniAppHtml, miniAppContentHash, guideConflicts } from '../src/domain/mini-app/html-lint'
import { signMiniAppLink, verifyMiniAppLink } from '../src/domain/mini-app/link-token'
import { MiniAppService } from '../src/domain/mini-app/mini-app-service'
import { invokeMiniAppTool, MCP_MINI_APP_SHARE_TOOL, type MiniAppMcpDeps } from '../src/domain/mini-app/mcp'
import { miniAppHumanAccess } from '../src/domain/mini-app/human-access'
import { miniAppLintLabel } from '../src/domain/mini-app/lint-labels'
import {
  buildMiniAppLiveDocument,
  MINI_APP_CONTENT_HEADERS,
  miniAppBarParts,
  miniAppBoundContentFetchDecision,
  miniAppContentCsp,
  miniAppContentFetchDecision,
  miniAppFrameCsp,
  renderMiniAppExpiredPage,
  renderMiniAppFrame,
  withMiniAppHardening,
  withStaticMiniAppBar,
} from '../src/domain/mini-app/frame'
import { GET } from '../src/app/api/mini-apps/content/[token]/route'
import { repositories } from '../src/repositories/postgres'
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
  async listBoundApps() {
    return []
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
        return { handoff: { ...input, id: crypto.randomUUID(), memoryId: null }, created: true }
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

  await check('tartalom-válasz: indítószkript az agent kódja előtt, a doctype megmarad', () => {
    const script = '<script>(function(w,d){'
    const first = (html: string) => withMiniAppHardening(html)
    // Doctype-pal: a szkript közvetlenül utána, a megjelenítési mód nem változik.
    const standard = first('<!doctype html><html lang="hu"><head></head><body><script>agent()</script></body></html>')
    assert.ok(standard.startsWith(`<!doctype html>${script}`))
    assert.ok(standard.indexOf(script) < standard.indexOf('agent()'))
    assert.ok(standard.includes('<html lang="hu">'))
    // Doctype nélkül nem teszünk bele sajátot (a régi app ugyanúgy jelenik meg).
    assert.ok(first('<p>szia</p>').startsWith(script))
    // Megjegyzés mögötti doctype-ot előreveszünk; BOM nem kerül a szkript mögé szövegként.
    assert.ok(first('  <!-- x --><!DOCTYPE html><p>').startsWith(`<!DOCTYPE html>${script}`))
    assert.ok(first('\uFEFF<!doctype html><p>').startsWith(`<!doctype html>${script}`))
    // Agent-kód semmilyen elejével sem kerülhet a szkript elé.
    for (const hostile of [
      '<script>agent()</script><!doctype html>',
      '<!--><script>agent()</script>--><!doctype html>',
      '<!doctype html x<script>agent()</script>',
      '<!-- <!doctype html><script>agent()</script>',
    ]) {
      const out = first(hostile)
      const parts = /^(<!doctype[^>]*>)?<script>\(function\(w,d\)\{/i.exec(out)
      assert.ok(parts, hostile)
    }
    // Sok megjegyzésre is lineáris marad.
    const many = '<!---->'.repeat(100_000) + '<!doctype html>'
    const started = Date.now()
    assert.ok(first(many).includes(script))
    assert.ok(Date.now() - started < 1000)
  })

  await check('tartalom-válasz: hálózati korlát fejlécben és CSP-ben; a meglévő direktívák megmaradnak', () => {
    assert.equal(MINI_APP_CONTENT_HEADERS['Connection-Allowlist'], '()')
    const csp = miniAppContentCsp()
    assert.ok(csp.includes("require-trusted-types-for 'script'"))
    assert.ok(csp.includes("script-src 'unsafe-inline'"))
    assert.equal(csp.includes('unsafe-eval'), false)
  })

  await check('tartalom-lekérés: beágyazva szolgáljuk, közvetlen megnyitás a keretre, más lekérés nem', () => {
    assert.equal(miniAppContentFetchDecision('iframe'), 'serve')
    assert.equal(miniAppContentFetchDecision('frame'), 'serve')
    assert.equal(miniAppContentFetchDecision(null), 'serve')
    assert.equal(miniAppContentFetchDecision('document'), 'open_frame')
    for (const dest of ['empty', 'embed', 'object', 'script', 'fencedframe', 'image']) assert.equal(miniAppContentFetchDecision(dest), 'reject', dest)
  })

  await check('tartalom-route: beágyazva keményített választ ad, közvetlen megnyitásnál a keretre visz', async () => {
    const html = '<!doctype html><h1>Riport</h1>'
    const app = { id: 'app-1', tenantId: TENANT, status: 'active', ownerAgentId: 'agent-1', name: 'Riport', createdAt: new Date(), currentVersion: 1 }
    const version = { version: 1, html, contentHash: miniAppContentHash(html), createdAt: new Date(), dataBindings: [] }
    const stub = (target: object, key: string, value: unknown) => Object.defineProperty(target, key, { value, configurable: true, writable: true })
    stub(repositories.miniApps, 'findById', async () => app)
    stub(repositories.miniApps, 'findVersion', async () => version)
    stub(repositories.agents, 'findById', async () => null)
    const token = signMiniAppLink({ tenantId: TENANT, appId: app.id, version: 1, contentHash: version.contentHash, requesterUserId: 'u', expiresAt: Date.now() + 60_000 })
    const get = (dest: string | null) =>
      GET(new Request(`https://apps.test/api/mini-apps/content/${token}`, { headers: dest ? { 'sec-fetch-dest': dest } : {} }), {
        params: Promise.resolve({ token }),
      })

    const framed = await get('iframe')
    assert.equal(framed.status, 200)
    assert.equal(framed.headers.get('Connection-Allowlist'), '()')
    assert.ok(framed.headers.get('Content-Security-Policy')?.includes('sandbox allow-scripts'))
    const body = await framed.text()
    assert.ok(body.startsWith('<!doctype html><script>(function(w,d){'))
    assert.ok(body.endsWith('<h1>Riport</h1>'))

    const direct = await get('document')
    assert.equal(direct.status, 302)
    assert.ok(direct.headers.get('Location')?.endsWith(`/api/mini-apps/open/${token}`))
    assert.equal(await direct.text(), '')

    assert.equal((await get('empty')).status, 404)
    assert.equal((await get(null)).status, 200)
  })

  // ── #1083 élő adat ─────────────────────────────────────────────────────────
  const QUERY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const LIVE_HTML = '<!doctype html><html><body><div id="o"></div><script>document.getElementById("o").textContent = "x"</script></body></html>'
  const bindingsJson = (extra: Record<string, unknown> = {}) => JSON.stringify([{ alias: 'bevetel', queryId: QUERY_ID, ...extra }])
  const liveService = () => {
    const ctx = setup()
    const prepared: unknown[] = []
    const service = new MiniAppService({
      store: ctx.store,
      agentNames: async () => new Map(),
      settings: async () => ({ linkTtl: '7d', maxBytes: 1024 * 1024 }),
      links: {
        mint: (input) => ({ openUrl: 'https://apps.test/o', openUrlExpiresAt: new Date(Date.now() + input.ttlMs).toISOString(), permanentUrl: 'https://app.test/p' }),
        permanentUrl: () => 'https://app.test/p',
      },
      liveData: {
        prepare: async (_actor, inputs) => {
          prepared.push(inputs)
          return { ok: true, bindings: inputs.map((input) => ({ alias: input.alias, queryId: input.queryId, queryVersion: 3, params: input.params ?? {}, maxRows: input.maxRows ?? 1000 })) }
        },
        latestQueryVersion: async () => 4,
      },
    })
    return { ...ctx, service, prepared, actor: { tenantId: TENANT, agentId: REKA, userId: ANNA, role: 'operator' } }
  }

  await check('AC15: cellaérték nem tör ki a JSON-blokkból, és a tartalma változatlan marad', () => {
    const cell = '</script><script>alert(1)</script><img src=x onerror=alert(2)><!--&'
    const separators = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`
    const json = serializeLiveData({ a: { status: 'ok', columns: ['c'], columnLabels: ['C'], rows: [[cell], [separators]], truncated: false, dataAsOf: null, warnings: [] } })
    for (const unsafe of ['<', '>', String.fromCharCode(0x2028), String.fromCharCode(0x2029)]) assert.equal(json.includes(unsafe), false, unsafe)
    const back = JSON.parse(json) as { a: { rows: string[][] } }
    assert.equal(back.a.rows[0]![0], cell)
    assert.equal(back.a.rows[1]![0], separators)
  })

  await check('beágyazott szkriptek: külső forrás, komment, nyers szöveg és indexelés', () => {
    assert.deepEqual(inlineScriptBodies('<script>a()</script><SCRIPT type="module">b()</SCRIPT>'), ['a()', 'b()'])
    assert.deepEqual(inlineScriptBodies('<script src="https://x/y.js"></script><svg><script href="z"></script></svg>'), [])
    assert.deepEqual(inlineScriptBodies('<!-- <script>a()</script> --><textarea><script>b()</script></textarea><title><script>c()</script></title>'), [])
    assert.deepEqual(inlineScriptBodies('<a title="<script>d()</script>">x</a><a title=\'>\'>y</a><script>e()</script>'), ['e()'])
    assert.deepEqual(inlineScriptBodies('<script>a()\r\nb()\rc()</script>'), ['a()\nb()\nc()'])
    assert.deepEqual(inlineScriptBodies('<script>var s="</scripty>"</script >'), ['var s="</scripty>"'])
    // A kisbetűsítés nem tolhatja el az indexeket: az `İ` teljes `toLowerCase`-szal hosszabb lenne.
    assert.deepEqual(inlineScriptBodies('<p>İİİİ</p><script>f()</script>'), ['f()'])
    assert.deepEqual(inlineScriptBodies('<script>g()'), ['g()'])
    assert.deepEqual(inlineScriptBodies('<plaintext><script>h()</script>'), [])
    // Sok kitöltés sem lassíthatja a bejárást.
    const started = Date.now()
    inlineScriptBodies('<'.repeat(1_000_000))
    inlineScriptBodies('<a '.repeat(300_000))
    inlineScriptBodies('<script>'.repeat(100_000))
    assert.ok(Date.now() - started < 5_000, 'lineáris bejárás')
  })

  await check('kötött dokumentum: hash-alapú CSP, adat a szkriptek előtt, a forrás változatlan', () => {
    const { html, csp } = buildMiniAppLiveDocument(LIVE_HTML, { dataJson: '{"a":1}' })
    assert.equal(csp.includes("'unsafe-inline'; style"), false)
    assert.equal(/script-src[^;]*unsafe-inline/.test(csp), false)
    assert.equal(/script-src[^;]*nonce/.test(csp), false)
    assert.equal(csp.includes('sandbox allow-scripts'), true)
    assert.equal(csp.includes("connect-src 'none'"), true)
    assert.equal((/script-src ([^;]*)/.exec(csp)![1]!.match(/'sha256-/g) ?? []).length, 2, 'platform + agent szkript')
    assert.equal(csp.includes(scriptHashSource('document.getElementById("o").textContent = "x"')), true)
    assert.ok(html.startsWith('<!doctype html><script>(function(w,d){'))
    assert.ok(html.indexOf('id="platform-data">{"a":1}</script>') < html.indexOf('<html>'))
    assert.ok(html.endsWith(LIVE_HTML))
    // A kötött indítószkript minden bővítése ténylegesen érvényesült.
    for (const part of ['createScriptURL:function(){return null}', "replace(/<script/gi,'<x-blocked')", 'tail=s.slice(-6)']) assert.ok(html.includes(part), part)
    // AC21: a statikus app CSP-je és indítószkriptje nem változott.
    assert.ok(miniAppContentCsp().includes("script-src 'unsafe-inline'"))
    assert.ok(withMiniAppHardening('<p>').includes('createScriptURL:same'))
    assert.equal(withMiniAppHardening('<p>').includes('x-blocked'), false)
    // A letöltött fájl a CSP-t magával viszi, a meta-ban érvénytelen irányelvek nélkül.
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(buildMiniAppLiveDocument(LIVE_HTML, { dataJson: '{}', meta: true }).html)
    assert.ok(meta && meta[1]!.includes('sha256-') && !meta[1]!.includes('sandbox') && !meta[1]!.includes('frame-ancestors'))
  })

  await check('kötött lint: HTML-kiírás, eseménykezelő és kimenő API kemény hiba; a statikus lint nem változik', () => {
    for (const [html, code] of [
      ['<script>e.innerHTML = rows</script>', 'unsafe_html_sink'],
      ['<script>e.insertAdjacentHTML("beforeend", x)</script>', 'unsafe_html_sink'],
      ['<script>document.write(x)</script>', 'document_write'],
      ['<img src=x onerror=alert(1)>', 'inline_event_handler'],
      ['<button/onclick="x()">', 'inline_event_handler'],
      ['<script src="https://x/y.js"></script>', 'external_script'],
      ['<script>fetch("/x")</script>', 'fetch_call'],
      ['<script>navigator.sendBeacon("/x")</script>', 'send_beacon'],
      ['<meta http-equiv="refresh" content="0;url=x">', 'meta_refresh'],
    ] as const) {
      assert.ok(lintBoundMiniAppHtml(html).includes(code), html)
      assert.deepEqual(lintMiniAppHtml(html).errors, [], `statikus lint: ${html}`)
      assert.notEqual(miniAppLintLabel(code), code)
    }
    assert.deepEqual(lintBoundMiniAppHtml(LIVE_HTML), [])
    assert.deepEqual(lintBoundMiniAppHtml('<script>el.online = true; if (a < b) c.onload = d</script>'), [])
    assert.ok(lintBoundMiniAppHtml(`${'<script>a()</script>'.repeat(51)}`).includes('too_many_inline_scripts'))
    assert.notEqual(miniAppLintLabel('too_many_inline_scripts'), 'too_many_inline_scripts')
  })

  await check('AC14 + D6 + D7: kötés új verzió, a link 1 órás, a forrás és a hash adat nélküli', async () => {
    const { service, actor, store } = liveService()
    const plain = await service.create(actor, { name: 'Statikus', html: HTML, idempotencyKey: 'plain' })
    assert.ok(plain.ok && Date.parse(plain.links.openUrlExpiresAt) - Date.now() > 6 * 24 * 3_600_000, 'AC21 statikus app: 7 nap')
    const bound = await service.create(actor, { name: 'Élő', html: LIVE_HTML, dataBindings: bindingsJson({ params: { tol: { relative: 'year_start' } } }), idempotencyKey: 'bound' })
    assert.ok(bound.ok)
    assert.ok(Date.parse(bound.links.openUrlExpiresAt) - Date.now() <= 3_600_000)
    assert.equal(bound.contentHash, miniAppContentHash(LIVE_HTML))
    const v1 = await store.findVersion(bound.app.id, 1)
    assert.deepEqual(v1!.dataBindings, [{ alias: 'bevetel', queryId: QUERY_ID, queryVersion: 3, params: { tol: { relative: 'year_start' } }, maxRows: 1000 }])
    assert.equal(v1!.html, LIVE_HTML)

    // Kötés-változás azonos HTML-lel új verzió; azonos kötés nem; HTML nélkül is cserélhető.
    const sameHtml = await service.update(actor, { appId: bound.app.id, html: LIVE_HTML, dataBindings: bindingsJson({ maxRows: 50 }), idempotencyKey: 'u1' })
    assert.ok(sameHtml.ok && sameHtml.version === 2 && !sameHtml.unchanged)
    const repeat = await service.update(actor, { appId: bound.app.id, html: LIVE_HTML, idempotencyKey: 'u2' })
    assert.ok(repeat.ok && repeat.unchanged && repeat.version === 2, 'kötés nélküli frissítés megtartja a kötést')
    const noHtml = await service.update(actor, { appId: bound.app.id, dataBindings: bindingsJson({ maxRows: 60 }), idempotencyKey: 'u3' })
    assert.ok(noHtml.ok && noHtml.version === 3)
    assert.equal((await store.findVersion(bound.app.id, 3))!.html, LIVE_HTML)
    assert.equal((await service.update(actor, { appId: bound.app.id, idempotencyKey: 'u4' })).ok, false, 'sem HTML, sem kötés')

    // A forrás nem tartalmaz adatot; a tulajdonos látja, ha van újabb lekérdezés-verzió.
    const got = await service.get(actor, { appId: bound.app.id, include: 'source' })
    assert.ok(got.ok)
    assert.equal(got.source!.html, LIVE_HTML)
    assert.deepEqual(got.dataBindings, [{ alias: 'bevetel', queryId: QUERY_ID, queryVersion: 3, maxRows: 60, latestQueryVersion: 4 }])

    // A kötés levétele után a link újra a szervezeti élettartamú.
    const removed = await service.update(actor, { appId: bound.app.id, dataBindings: '[]', idempotencyKey: 'u5' })
    assert.ok(removed.ok && Date.parse(removed.links.openUrlExpiresAt) - Date.now() > 6 * 24 * 3_600_000)
  })

  await check('kötés: lint, hibás bemenet, másolás és kötés-kapu', async () => {
    const { service, actor, prepared } = liveService()
    const unsafe = await service.create(actor, { name: 'Veszélyes', html: '<script>e.innerHTML = rows</script>', dataBindings: bindingsJson(), idempotencyKey: 'x1' })
    assert.ok(!unsafe.ok && unsafe.code === 'mini_app_validation_failed' && (unsafe.extra!.errors as string[]).includes('unsafe_html_sink'))
    // Ugyanez kötés nélkül a mai szabály szerint elfogadott (AC21).
    assert.equal((await service.create(actor, { name: 'Statikus2', html: '<script>e.innerHTML = rows</script>', idempotencyKey: 'x2' })).ok, true)
    for (const raw of ['nem json', '{"alias":"a"}', '[{"alias":"1a","queryId":"x"}]', JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ alias: `a${i}`, queryId: QUERY_ID }))), `[{"alias":"a","queryId":"${QUERY_ID}"},{"alias":"a","queryId":"${QUERY_ID}"}]`, `[{"alias":"a","queryId":"${QUERY_ID}","maxRows":5001}]`]) {
      const res = await service.create(actor, { name: 'Rossz kötés', html: LIVE_HTML, dataBindings: raw, idempotencyKey: `bad-${raw.length}` })
      assert.ok(!res.ok && res.code === 'invalid_data_bindings', raw)
    }
    assert.equal(prepared.length, 1, 'hibás bemenet nem jut el a próbafuttatásig')

    const bound = await service.create(actor, { name: 'Forrás', html: LIVE_HTML, dataBindings: bindingsJson(), idempotencyKey: 'x3' })
    assert.ok(bound.ok)
    const copy = await service.create({ tenantId: TENANT, agentId: REKA, userId: ANNA }, { name: 'Másolat', copyFromAppId: bound.app.id, idempotencyKey: 'x4' })
    assert.ok(!copy.ok && copy.code === 'mini_app_copy_has_data_binding')
    assert.ok(enterpriseToolErrorPayload('mini_app_copy_has_data_binding').message !== 'mini_app_copy_has_data_binding')

    // Kötést csak a tulajdonos tud frissíteni.
    const foreign = await service.update({ tenantId: TENANT, agentId: ZOLI, userId: ANNA }, { appId: bound.app.id, dataBindings: bindingsJson(), idempotencyKey: 'x5' })
    assert.equal(foreign.ok, false)
  })

  const liveDeps = (overrides: Partial<MiniAppLiveDataDeps> = {}): MiniAppLiveDataDeps => ({
    findMembership: async () => ({ role: 'viewer', status: 'active' }),
    canReadWarehouse: (role) => role !== 'guest',
    agentAccess: async () => 'read',
    findOwnerAgent: async () => ({ retiredAt: null }),
    runBoundQuery: async () => ({ columns: ['c'], columnLabels: ['C'], rows: [[1]], truncated: false, bytes: 10, dataAsOf: '2026-11-03T13:20:00.000Z', warnings: [], schemaStatus: 'current', version: 1, currentVersion: 1 }),
    errorCode: (error) => (error instanceof Error ? error.message : 'live_data_unavailable'),
    ...overrides,
  })
  const liveApp = { tenantId: TENANT, ownerAgentId: REKA, status: 'active' as const }

  await check('AC16: tag eltávolítása, jog hiánya, off szint, inaktív agent → adat nem megy ki, érthető ok', async () => {
    assert.deepEqual(await checkLiveAccess(liveDeps(), liveApp, ANNA), { ok: true, role: 'viewer' })
    assert.deepEqual(await checkLiveAccess(liveDeps(), { ...liveApp, status: 'archived' }, ANNA), { ok: false, code: 'app_archived' })
    assert.notEqual(liveDeniedMessage('app_archived'), 'Az élő adat most nem jeleníthető meg.')
    const denied: Array<[string, MiniAppLiveDataDeps, string | undefined]> = [
      ['link_without_user', liveDeps(), undefined],
      ['member_removed', liveDeps({ findMembership: async () => null }), ANNA],
      ['member_removed', liveDeps({ findMembership: async () => ({ role: 'admin', status: 'suspended' }) }), ANNA],
      ['no_read_permission', liveDeps({ findMembership: async () => ({ role: 'guest', status: 'active' }) }), ANNA],
      ['agent_access_off', liveDeps({ agentAccess: async () => 'off' }), ANNA],
      ['owner_agent_unavailable', liveDeps({ findOwnerAgent: async () => null }), ANNA],
      ['owner_agent_unavailable', liveDeps({ findOwnerAgent: async () => ({ retiredAt: new Date() }) }), ANNA],
    ]
    for (const [code, deps, user] of denied) {
      const verdict = await checkLiveAccess(deps, liveApp, user)
      assert.deepEqual(verdict, { ok: false, code })
      assert.notEqual(liveDeniedMessage(code), 'Az élő adat most nem jeleníthető meg.', code)
    }
  })

  await check('AC16 + AC19 + §4.4: hibás kötés hibablokkot kap, közös keret, kötelező figyelmeztetések a sávon', async () => {
    const budgets: number[] = []
    const deps = liveDeps({
      runBoundQuery: async (_actor, input) => {
        budgets.push(input.maxBytes)
        if (input.queryId === 'broken') throw new Error('saved_query_broken')
        return {
          columns: ['c'],
          columnLabels: ['C'],
          rows: [[1], [2]],
          truncated: true,
          bytes: 1_000,
          dataAsOf: input.queryId === 'q1' ? '2026-11-03T13:20:00.000Z' : '2026-10-01T10:00:00.000Z',
          warnings: [
            { code: 'open_exceptions', dataset: 'd', detail: { count: 3 } },
            { code: 'definitions_not_confirmed', dataset: 'd', detail: ['x'] },
          ],
          schemaStatus: 'meaning_changed',
          version: 1,
          currentVersion: 2,
        }
      },
    })
    const binding = (alias: string, queryId: string) => ({ alias, queryId, queryVersion: 1, params: {}, maxRows: 2 })
    const load = await loadLiveData(deps, { app: liveApp, userId: ANNA, role: 'viewer', bindings: [binding('egy', 'q1'), binding('ketto', 'broken'), binding('harom', 'q3')], purpose: 'content' })
    assert.equal(budgets[0]! - budgets[2]!, 1_000, 'a második futás kevesebb keretet kap')
    assert.deepEqual(load.data.ketto, { status: 'error', code: 'saved_query_broken' })
    assert.equal(load.data.egy!.status, 'ok')
    assert.equal(load.bar.lastLoadAt!.toISOString(), '2026-11-03T13:20:00.000Z')
    const text = load.bar.warnings.join(' | ')
    for (const part of ['3 megoldatlan adategyezés', 'AI-javaslat, még nem megerősített mezők', 'jelentése megváltozott', 'Az egyik lekérdezés nem futtatható', 'Az egyik lekérdezésből csak az első 2 sor látszik', 'újabb lekérdezés-verzió']) assert.ok(text.includes(part), part)
    assert.equal(text.includes('1000'), false)

    const frame = renderMiniAppFrame({ name: 'R', createdAt: new Date(), versionCreatedAt: new Date(), ownerAgentName: 'Réka', version: 1, currentVersion: 1, contentUrl: '/c', live: load.bar })
    assert.ok(frame.includes('Élő adat') && frame.includes('⚠ 3 megoldatlan adategyezés') && frame.includes('<iframe'))
    const denied = renderMiniAppFrame({ name: 'R', createdAt: new Date(), versionCreatedAt: new Date(), ownerAgentName: 'Réka', version: 1, currentVersion: 1, contentUrl: '/c', live: { mode: 'denied', lastLoadAt: null, warnings: [liveDeniedMessage('agent_access_off')] } })
    assert.ok(denied.includes('nincs hozzáférése az adattárházhoz'))
    assert.equal(denied.includes('<iframe'), false, 'elutasításnál az agent kódja sem tölt be')
    const downloaded = withStaticMiniAppBar(LIVE_HTML, { name: 'R', createdAt: new Date(), versionCreatedAt: new Date(), ownerAgentName: 'Réka', version: 1, currentVersion: 1, live: { mode: 'download', lastLoadAt: new Date(), warnings: [], dataTakenAt: new Date() } })
    assert.ok(downloaded.includes('ez a fájl már nem frissül'))
  })

  await check('D6 + §5: 1 óránál hosszabb token elutasítva, sebességkorlát appra és linkre', () => {
    const now = 1_000_000
    assert.equal(liveLinkTooLong(now + 3_600_000, now), false)
    assert.equal(liveLinkTooLong(now + 7 * 24 * 3_600_000, now), true)
    let clock = 0
    const limit = createLiveRateLimiter(() => clock)
    assert.equal(limit('k', 2), true)
    assert.equal(limit('k', 2), true)
    assert.equal(limit('k', 2), false)
    assert.equal(limit('m', 2), true, 'más kulcs külön keret')
    clock += 61_000
    assert.equal(limit('k', 2), true)
    assert.equal(miniAppBoundContentFetchDecision('iframe'), 'serve')
    assert.equal(miniAppBoundContentFetchDecision(null), 'open_frame', 'a fejléc hiánya sem szolgál ki adatot')
    assert.equal(miniAppBoundContentFetchDecision('document'), 'open_frame')
    assert.equal(miniAppBoundContentFetchDecision('script'), 'reject')
  })

  await check('AC13 + AC16 + AC17: a route friss adatot ágyaz, tiltásnál és lejárt linknél nem', async () => {
    const stub = (target: object, key: string, value: unknown) => Object.defineProperty(target, key, { value, configurable: true, writable: true })
    const html = LIVE_HTML
    const app = { id: 'app-live', tenantId: TENANT, status: 'active', ownerAgentId: REKA, name: 'Élő', createdAt: new Date(), currentVersion: 1 }
    const version = { version: 1, html, contentHash: miniAppContentHash(html), createdAt: new Date(), dataBindings: [{ alias: 'bevetel', queryId: QUERY_ID, queryVersion: 1, params: {}, maxRows: 10 }] }
    stub(repositories.miniApps, 'findById', async () => app)
    stub(repositories.miniApps, 'findVersion', async () => version)
    stub(repositories.agents, 'findById', async () => ({ retiredAt: null }))
    // A valódi repository őre: a tiltott metaadat-kulcs itt is hibát dob, nem csak élesben.
    const audits: Array<{ policyDecision?: string | null; metadata?: unknown }> = []
    stub(repositories.audit, 'append', async (data: { policyDecision?: string | null; metadata?: unknown }) => {
      assertAuditMetadataSafe(data.metadata)
      audits.push(data)
    })
    stub(repositories.tenantMemberships, 'findByTenantAndUser', async () => ({ role: 'viewer', status: 'active' }))
    stub(repositories.tenants, 'findById', async () => ({ settings: {} }))
    let cell = 'első import'
    const saved = miniAppLiveDeps.runBoundQuery
    miniAppLiveDeps.runBoundQuery = async () => ({ columns: ['c'], columnLabels: ['C'], rows: [[cell]], truncated: false, bytes: 10, dataAsOf: '2026-11-03T13:20:00.000Z', warnings: [], schemaStatus: 'current', version: 1, currentVersion: 1 })
    const sign = (expiresAt: number, requesterUserId: string | null = ANNA) => signMiniAppLink({ tenantId: TENANT, appId: app.id, version: 1, contentHash: version.contentHash, requesterUserId, expiresAt })
    const get = (token: string, dest: string | null = 'iframe') =>
      GET(new Request(`https://apps.test/api/mini-apps/content/${token}`, { headers: dest ? { 'sec-fetch-dest': dest } : {} }), { params: Promise.resolve({ token }) })
    try {
      const token = sign(Date.now() + 3_000_000)
      const first = await get(token)
      assert.equal(first.status, 200)
      assert.ok(first.headers.get('Content-Security-Policy')!.includes('sha256-'))
      assert.equal(/script-src[^;]*unsafe-inline/.test(first.headers.get('Content-Security-Policy')!), false)
      assert.equal(first.headers.get('Connection-Allowlist'), '()')
      assert.equal(first.headers.get('Cache-Control'), 'private, no-store')
      assert.ok((await first.text()).includes('első import'))
      cell = 'második import'
      assert.ok((await (await get(token)).text()).includes('második import'), 'AC13 újranyitás új verzió nélkül')
      assert.equal((await get(token, null)).status, 302, 'tartalom csak iframe-be')
      assert.equal((await get(sign(Date.now() + 7 * 24 * 3_600_000))).status, 410, 'hosszú lejáratú token nem jó kötött verzióra')
      assert.equal((await get(sign(Date.now() - 1_000))).status, 410, 'AC17 lejárt')
      const noUser = await get(sign(Date.now() + 3_000_000, null))
      assert.equal(noUser.status, 404, 'személyhez nem kötött link nem kap adatot')
      stub(repositories.tenantMemberships, 'findByTenantAndUser', async () => null)
      const removed = await get(token)
      assert.equal(removed.status, 404)
      assert.equal((await removed.text()).includes('második import'), false)
      const deniedAudit = audits.at(-1)!
      assert.equal(deniedAudit.policyDecision, 'denied')
      assert.equal((deniedAudit.metadata as { deniedCode?: string }).deniedCode, 'member_removed')
    } finally {
      miniAppLiveDeps.runBoundQuery = saved
    }
  })

  await check('lint: a `/` is lezárja a tilos taget; új figyelmeztetések emberi szöveggel', () => {
    for (const [html, code] of [
      ['<iframe/src=x>', 'iframe_tag'],
      ['<OBJECT/data=x>', 'object_tag'],
      ['<embed/src=x>', 'embed_tag'],
      ['<form/action=x>', 'form_tag'],
    ] as const) assert.deepEqual(lintMiniAppHtml(html).errors, [code], html)
    assert.deepEqual(lintMiniAppHtml('<iframes><objective><formula>').errors, [])
    assert.ok(lintMiniAppHtml('<script>new RTCPeerConnection()</script>').warnings.includes('peer_connection'))
    assert.ok(lintMiniAppHtml('<script>new webkitRTCPeerConnection()</script>').warnings.includes('peer_connection'))
    assert.ok(lintMiniAppHtml("<script>f.srcdoc='x'</script>").warnings.includes('embedded_document'))
    assert.ok(lintMiniAppHtml('<link rel="preconnect" href="https://x">').warnings.includes('resource_hint'))
    assert.ok(lintMiniAppHtml('<link href="https://x" rel=dns-prefetch>').warnings.includes('resource_hint'))
    assert.deepEqual(lintMiniAppHtml('<h1>Havi riport</h1><link rel="icon" href="data:,">').warnings, [])
    for (const code of ['peer_connection', 'embedded_document', 'resource_hint']) assert.notEqual(miniAppLintLabel(code), code)
  })

  await check('keret CSP: frame-src a mini-app origin, nem self', () => {
    // Opaque beágyazó (sandbox allow-same-origin nélkül) esetén a 'self' a unique
    // origint jelenti, a tartalom URL-jét nem.
    const csp = miniAppFrameCsp('https://ai.excellencepay.com')
    assert.match(csp, /(?:^|; )frame-src https:\/\/ai\.excellencepay\.com(?:;|$)/)
    assert.equal(/frame-src 'self'/.test(csp), false)
    const fromUrl = miniAppFrameCsp('https://apps.example.com/ignored')
    assert.match(fromUrl, /(?:^|; )frame-src https:\/\/apps\.example\.com(?:;|$)/)
    assert.equal(fromUrl.includes('/ignored'), false)
    const frame = renderMiniAppFrame({
      name: 'R',
      createdAt: new Date('2026-10-24T08:12:00Z'),
      versionCreatedAt: new Date('2026-10-24T08:12:00Z'),
      ownerAgentName: 'Réka',
      version: 1,
      currentVersion: 1,
      contentUrl: 'https://ai.excellencepay.com/api/mini-apps/content/tok',
    })
    assert.match(frame, /<iframe src="https:\/\/ai\.excellencepay\.com\/api\/mini-apps\/content\/tok"/)
  })

  await check('Control Plane / panel / MCP viewer nem sandboxolja a keretoldal iframe-jét', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../src')
    const page = readFileSync(join(root, 'app/control-plane/mini-apps/[appId]/page.tsx'), 'utf8')
    const panel = readFileSync(join(root, 'components/agents/agent-mini-apps-panel.tsx'), 'utf8')
    const viewer = readFileSync(join(root, 'domain/mini-app/viewer.ts'), 'utf8')
    assert.equal(/<iframe[\s\S]*?src=\{links\.openUrl\}[\s\S]*?sandbox=/.test(page), false)
    assert.equal(/<iframe[\s\S]*?src=\{preview\}[\s\S]*?sandbox=/.test(panel), false)
    assert.equal(viewer.includes("setAttribute('sandbox'"), false)
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
