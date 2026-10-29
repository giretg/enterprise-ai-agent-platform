/**
 * #1004 platform-chat — platform-oldali DB-mentes stub-tesztek:
 * chat-token, session/folytatási token, MCP-principal, gateway-token chat-ág, kapu + napi keret.
 * Futtatás: npm run test:platform-chat
 */
import assert from 'node:assert/strict'
import {
  CHAT_TOKEN_AUDIENCE,
  CHAT_TURN_TOKEN_AUDIENCE,
  signChatToken,
  verifyChatToken,
} from '../src/domain/platform-chat/chat-token'
import { issueChatSession, issueContinuationToken, type ChatSessionDeps } from '../src/domain/platform-chat/session'
import {
  BUDGET_BLOCK_REASON,
  costOfUsage,
  createPlatformChatGate,
  isReservedInstallId,
  PLATFORM_CHAT_INSTALL_ID,
  withPlatformChatSpend,
  type PlatformChatAccess,
  type PlatformChatGatewayStore,
} from '../src/domain/platform-chat/gateway'
import { issueGatewayToken, type GatewayTokenDeps } from '../src/domain/model-gateway-token/gateway-token'
import { resolveMcpPrincipal, type McpPrincipalDeps } from '../src/auth/mcp-principal'
import {
  platformChatBudgetDay,
  readPlatformChatSettings,
  withPlatformChatSettings,
} from '../src/lib/platform-chat-settings'
import {
  canStartPlatformChat,
  parsePlatformChatAgentParam,
  pickPlatformChatAgentId,
  platformChatHref,
} from '../src/lib/platform-chat-href'
import type { GatewayCallContext, ModelCallEvent } from '../src/domain/model-gateway/proxy'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const KEY = 'c'.repeat(40)
const USER = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const AGENT = '33333333-3333-4333-8333-333333333333'
const OTHER_AGENT = '44444444-4444-4444-8444-444444444444'
const NOW = new Date('2026-10-29T10:00:00Z')
const nowS = Math.floor(NOW.getTime() / 1000)
let failures = 0

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.stack : e}`)
  }
}

const access: PlatformChatAccess = { tenantEnabled: true, dailyBudgetUsd: 10, agentEnabled: true }
const audits: string[] = []

function principalDeps(over: Partial<McpPrincipalDeps> = {}): McpPrincipalDeps {
  return {
    verifyOAuthToken: async () => null,
    verifyChatToken: (t) => verifyChatToken(t, KEY, nowS),
    users: {
      findByExternalAuthId: async () => null,
      findById: async (id: string) => (id === USER ? ({ id: USER, status: 'active' } as never) : null),
    },
    tenants: {
      findBySlug: async (s: string) => (s === 'acme' ? ({ id: TENANT, slug: 'acme', status: 'active' } as never) : null),
      findById: async () => null,
    },
    memberships: { findByTenantAndUser: async () => ({ status: 'active', role: 'operator' }) as never },
    platformMemberships: { findByUser: async () => [] },
    audit: { append: async (a) => void audits.push(a.action) },
    ...over,
  }
}

function chatToken(aud: 'platform-chat' | 'platform-chat-turn' = CHAT_TOKEN_AUDIENCE, extra: Record<string, string> = {}) {
  return signChatToken(
    { aud, sub: USER, tenant: 'acme', tid: TENANT, role: 'operator', adminInsight: false, ...extra },
    KEY,
    NOW,
  ).token
}

class MemStore implements PlatformChatGatewayStore {
  sessions = new Map<string, Date>()
  spend = new Map<string, number>()
  async registerSession(i: { tenantId: string; userId: string; agentId: string; sessionId: string; now: Date }) {
    this.sessions.set(`${i.tenantId}/${i.userId}/${i.agentId}/${i.sessionId}`, i.now)
  }
  async findSession(i: { tenantId: string; userId: string; agentId: string; sessionId: string }) {
    const at = this.sessions.get(`${i.tenantId}/${i.userId}/${i.agentId}/${i.sessionId}`)
    return at ? { lastSeenAt: at } : null
  }
  async spendOn(i: { tenantId: string; day: string }) {
    return this.spend.get(`${i.tenantId}/${i.day}`) ?? 0
  }
  async addSpend(i: { tenantId: string; day: string; costUsd: number }) {
    this.spend.set(`${i.tenantId}/${i.day}`, (await this.spendOn(i)) + i.costUsd)
  }
}

const ctx = (over: Partial<GatewayCallContext> = {}): GatewayCallContext => ({
  tenantId: TENANT,
  tenantSlug: 'acme',
  userId: USER,
  agentId: AGENT,
  installId: PLATFORM_CHAT_INSTALL_ID,
  policyVersion: 'pv',
  sessionId: 'conv-1',
  turnId: 'turn-1',
  stream: true,
  ...over,
})

async function main() {
  await check('beállítás: keret nélkül nincs bekapcsolt állapot; adminInsight alapból tiltva', () => {
    assert.deepEqual(readPlatformChatSettings({}), { enabled: false, dailyBudgetUsd: null, adminInsight: false })
    assert.equal(readPlatformChatSettings({ platformChat: { enabled: true } }).enabled, false)
    const next = withPlatformChatSettings({ other: 1 }, { enabled: true, dailyBudgetUsd: 10 })
    assert.equal((next as Record<string, unknown>).other, 1)
    assert.deepEqual(readPlatformChatSettings(next), { enabled: true, dailyBudgetUsd: 10, adminInsight: false })
  })

  await check('keret-nap: Europe/Budapest éjfél', () => {
    assert.equal(platformChatBudgetDay(new Date('2026-10-29T22:30:00Z')), '2026-10-29') // CET +1 → 23:30
    assert.equal(platformChatBudgetDay(new Date('2026-10-29T23:30:00Z')), '2026-10-30')
  })

  await check('chat-token: aláírás, lejárat, audience, rossz kulcs', () => {
    const t = chatToken()
    assert.equal(verifyChatToken(t, KEY, nowS)?.sub, USER)
    assert.equal(verifyChatToken(t, 'x'.repeat(40), nowS), null)
    assert.equal(verifyChatToken(t, KEY, nowS + 601), null)
    assert.equal(verifyChatToken(t, KEY, nowS, [CHAT_TURN_TOKEN_AUDIENCE]), null)
    assert.equal(verifyChatToken(t, 'short', nowS), null)
    // a folytatási token turnId + agentId nélkül érvénytelen
    assert.equal(verifyChatToken(chatToken(CHAT_TURN_TOKEN_AUDIENCE), KEY, nowS), null)
  })

  const sessionDeps = (over: Partial<ChatSessionDeps> = {}): ChatSessionDeps => ({
    signingKey: KEY,
    workerUrl: 'https://worker.run.app/',
    loadTenant: async () => ({ slug: 'acme', settings: { enabled: true, adminInsight: true } }),
    modelKeyConfigured: async () => true,
    loadAccess: async () => access,
    canUseAgent: async () => true,
    now: () => NOW,
    ...over,
  })
  const sessionInput = { userId: USER, tenantId: TENANT, role: 'operator' as const }

  await check('session: kikapcsolt tenant / nincs kulcs / tiltott agent → elutasítás', async () => {
    const off = await issueChatSession(sessionDeps({ loadTenant: async () => ({ slug: 'acme', settings: { enabled: false, adminInsight: false } }) }), sessionInput)
    assert.deepEqual(off, { ok: false, code: 'platform_chat_disabled' })
    assert.deepEqual(await issueChatSession(sessionDeps({ modelKeyConfigured: async () => false }), sessionInput), { ok: false, code: 'key_missing' })
    const agentOff = await issueChatSession(sessionDeps({ loadAccess: async () => ({ ...access, agentEnabled: false }) }), { ...sessionInput, agentId: AGENT })
    assert.deepEqual(agentOff, { ok: false, code: 'agent_unavailable' })
    assert.deepEqual(await issueChatSession(sessionDeps({ workerUrl: undefined }), sessionInput), { ok: false, code: 'not_configured' })
  })

  await check('session: token + worker URL + adminInsight a claimben', async () => {
    const r = await issueChatSession(sessionDeps(), sessionInput)
    assert.ok(r.ok)
    assert.equal(r.workerUrl, 'https://worker.run.app')
    const claims = verifyChatToken(r.token, KEY, nowS, [CHAT_TOKEN_AUDIENCE])
    assert.equal(claims?.adminInsight, true)
    assert.equal(claims?.tid, TENANT)
  })

  await check('folytatási token: csak chat-tokennel, fordulóra + agentre szűkítve; láncolás tilos', async () => {
    const deps = { ...sessionDeps(), principal: principalDeps(), audit: { append: async (a: { action: string }) => void audits.push(a.action) } }
    const r = await issueContinuationToken(deps as never, {
      authorizationHeader: `Bearer ${chatToken()}`,
      body: { turnId: 'turn-1', agentId: AGENT },
    })
    assert.ok(r.ok)
    const claims = verifyChatToken(r.token, KEY, nowS)
    assert.equal(claims?.aud, CHAT_TURN_TOKEN_AUDIENCE)
    assert.equal(claims?.agentId, AGENT)
    assert.equal(claims?.turnId, 'turn-1')
    assert.ok(audits.includes('platform_chat.continuation_issued'))
    const chained = await issueContinuationToken(deps as never, {
      authorizationHeader: `Bearer ${r.token}`,
      body: { turnId: 'turn-1', agentId: AGENT },
    })
    assert.deepEqual(chained, { ok: false, code: 'unauthenticated' })
  })

  await check('MCP principal: chat-token ugyanarra a principalra oldódik fel, client=platform_chat', async () => {
    const r = await resolveMcpPrincipal(
      { authorizationHeader: `Bearer ${chatToken()}`, tenantSlug: 'acme', resourceOrigin: 'https://app.example.com' },
      principalDeps(),
    )
    assert.ok(r.ok)
    assert.equal(r.principal.userId, USER)
    assert.equal(r.principal.role, 'operator')
    assert.equal(r.principal.client, 'platform_chat')
  })

  await check('MCP principal: más tenant URL-jén a chat-token érvénytelen', async () => {
    const r = await resolveMcpPrincipal(
      { authorizationHeader: `Bearer ${chatToken()}`, tenantSlug: 'other', resourceOrigin: 'https://app.example.com' },
      principalDeps(),
    )
    assert.equal(r.ok, false)
  })

  const store = new MemStore()
  const gatewayDeps = (over: Partial<GatewayTokenDeps> = {}): GatewayTokenDeps => ({
    ...principalDeps(),
    signingKey: 'g'.repeat(40),
    now: () => NOW,
    loadDefinition: async ({ agentId }) => ({ agentId, status: 'active' }) as never,
    canViewAgent: async () => true,
    policyVersion: async () => 'pv1',
    listAgentIds: async () => [AGENT],
    platformChat: { loadAccess: async () => access, registerSession: (i) => store.registerSession(i) },
    ...over,
  })
  const gatewayIssue = (d: GatewayTokenDeps, body: unknown, token = chatToken()) =>
    issueGatewayToken(d, { authorizationHeader: `Bearer ${token}`, resourceOrigin: 'https://app.example.com', body })

  await check('gateway-token: chat-principal → szerveroldali install, a session regisztrálódik', async () => {
    const r = await gatewayIssue(gatewayDeps(), { tenantSlug: 'acme', agentId: AGENT, installId: PLATFORM_CHAT_INSTALL_ID, sessionId: 'conv-1' })
    assert.ok(r.ok)
    assert.ok(await store.findSession({ tenantId: TENANT, userId: USER, agentId: AGENT, sessionId: 'conv-1' }))
  })

  await check('gateway-token: chat-principal más installId-val / session nélkül → bad_request', async () => {
    assert.deepEqual(await gatewayIssue(gatewayDeps(), { tenantSlug: 'acme', agentId: AGENT, installId: 'inst-1', sessionId: 'c' }), { ok: false, code: 'bad_request' })
    assert.deepEqual(await gatewayIssue(gatewayDeps(), { tenantSlug: 'acme', agentId: AGENT, installId: PLATFORM_CHAT_INSTALL_ID }), { ok: false, code: 'bad_request' })
  })

  await check('gateway-token: kikapcsolt agent → forbidden; folytatási token más agentre → forbidden', async () => {
    const off = gatewayDeps({ platformChat: { loadAccess: async () => ({ ...access, agentEnabled: false }), registerSession: async () => {} } })
    assert.deepEqual(await gatewayIssue(off, { tenantSlug: 'acme', agentId: AGENT, installId: PLATFORM_CHAT_INSTALL_ID, sessionId: 'c' }), { ok: false, code: 'forbidden' })
    const turn = chatToken(CHAT_TURN_TOKEN_AUDIENCE, { turnId: 't1', agentId: AGENT })
    assert.deepEqual(await gatewayIssue(gatewayDeps(), { tenantSlug: 'acme', agentId: OTHER_AGENT, installId: PLATFORM_CHAT_INSTALL_ID, sessionId: 'c' }, turn), { ok: false, code: 'forbidden' })
  })

  await check('gateway-token: Hermes (OAuth) kliens nem kérhet fenntartott installId-t', async () => {
    assert.ok(isReservedInstallId('platform-chat') && isReservedInstallId('Platform-Chat-x') && !isReservedInstallId('inst-1'))
    const d = gatewayDeps({ verifyChatToken: () => null, verifyOAuthToken: async () => ({ clerkUserId: 'c1' }), users: { findByExternalAuthId: async () => ({ id: USER, status: 'active' }) as never, findById: async () => null } })
    assert.deepEqual(await gatewayIssue(d, { tenantSlug: 'acme', agentId: AGENT, installId: PLATFORM_CHAT_INSTALL_ID }, 'oauth'), { ok: false, code: 'bad_request' })
  })

  const fallbackCalls: string[] = []
  const gate = createPlatformChatGate(
    { store, loadAccess: async () => access, now: () => NOW },
    async (c) => {
      fallbackCalls.push(c.installId)
      return null
    },
  )

  await check('kapu: más install a Managed/Open kapun megy', async () => {
    assert.equal(await gate(ctx({ installId: 'inst-1' })), null)
    assert.deepEqual(fallbackCalls, ['inst-1'])
  })

  await check('kapu: regisztrált session, keret alatt → átenged; ismeretlen session → blokk', async () => {
    assert.equal(await gate(ctx()), null)
    assert.equal((await gate(ctx({ sessionId: 'unknown' })))?.reason, 'platform_chat_session')
  })

  await check('napi keret: költés a számlálóra, elfogyott keretnél keret-blokk; Hermes nem számít bele', async () => {
    const recorded: ModelCallEvent[] = []
    const sink = withPlatformChatSpend({ record: async (e) => void recorded.push(e) }, { store, now: () => NOW })
    const event = (over: Partial<ModelCallEvent>): ModelCallEvent => ({
      ...ctx(), requestedModel: null, model: 'openrouter/x', substituted: false, failedCandidates: [], outcome: 'ok',
      request: null, response: null, usage: { promptTokens: 10, completionTokens: 10, costUsd: 6 }, latencyMs: 1, ...over,
    })
    await sink.record(event({}))
    await sink.record(event({ installId: 'inst-1', usage: { costUsd: 100 } })) // Hermes
    await sink.record(event({ outcome: 'blocked', usage: { costUsd: 100 } }))
    assert.equal(recorded.length, 3)
    assert.equal(await gate(ctx()), null) // 6 < 10
    await sink.record(event({}))
    assert.equal((await gate(ctx()))?.reason, BUDGET_BLOCK_REASON) // 12 ≥ 10
    assert.equal(await gate(ctx({ installId: 'inst-1' })), null)
  })

  await check('költség: tényleges OpenRouter-költség, hiányában token-becslés', () => {
    assert.equal(costOfUsage({ costUsd: 0.5, promptTokens: 1_000_000 }), 0.5)
    assert.equal(costOfUsage({ promptTokens: 500_000, completionTokens: 500_000 }, 2), 2)
    assert.equal(costOfUsage(null), 0)
  })

  await check('kártya: beszélgetés csak bekapcsolt tenant+agent+aktív közzétett munkatársnál', () => {
    const base = {
      tenantEnabled: true,
      platformChatEnabled: true,
      status: 'active',
      currentDefinitionVersionId: 'def-1',
    }
    assert.equal(canStartPlatformChat(base), true)
    assert.equal(canStartPlatformChat({ ...base, tenantEnabled: false }), false)
    assert.equal(canStartPlatformChat({ ...base, platformChatEnabled: false }), false)
    assert.equal(canStartPlatformChat({ ...base, status: 'draft' }), false)
    assert.equal(canStartPlatformChat({ ...base, currentDefinitionVersionId: null }), false)
  })

  await check('chat URL: agent query param a kártyáról', () => {
    assert.equal(platformChatHref(AGENT), `/control-plane/chat?agent=${AGENT}`)
    assert.equal(parsePlatformChatAgentParam(AGENT), AGENT)
    assert.equal(parsePlatformChatAgentParam('nope'), null)
    assert.equal(pickPlatformChatAgentId([{ agentId: AGENT }, { agentId: OTHER_AGENT }], OTHER_AGENT), OTHER_AGENT)
    assert.equal(pickPlatformChatAgentId([{ agentId: AGENT }], OTHER_AGENT), AGENT)
  })

  await check('UI: kártyán és adatlapon van indító gomb, a chat a query agentet választja', () => {
    const root = resolve(import.meta.dirname, '..')
    const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')
    const card = read('src/components/agents/agent-catalog-card.tsx')
    const link = read('src/components/agents/start-platform-chat-link.tsx')
    const chatPage = read('src/app/control-plane/chat/page.tsx')
    const chatUi = read('src/components/platform-chat/platform-chat.tsx')
    const detail = read('src/app/control-plane/agents/[agentId]/page.tsx')
    const agentsPage = read('src/app/control-plane/agents/page.tsx')
    const dashboard = read('src/app/control-plane/dashboard/page.tsx')
    assert.match(card, /StartPlatformChatLink/)
    assert.match(card, /canStartPlatformChat/)
    assert.match(link, /platformChatHref/)
    assert.match(link, /startChat/)
    assert.match(detail, /StartPlatformChatLink/)
    assert.match(agentsPage, /tenantChatEnabled/)
    assert.match(dashboard, /tenantChatEnabled/)
    assert.match(chatPage, /initialAgentId/)
    assert.match(chatPage, /parsePlatformChatAgentParam/)
    assert.match(chatUi, /initialAgentId/)
    assert.match(chatUi, /pickPlatformChatAgentId/)
  })

  if (failures) {
    console.log(`\n${failures} failed`)
    process.exit(1)
  }
  console.log('\nplatform-chat: all passed')
}

void main()
