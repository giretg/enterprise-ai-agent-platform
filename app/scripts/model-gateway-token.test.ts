/**
 * Model Gateway token (#772) — DB-mentes stub-tesztek.
 * Futtatás: npm run test:model-gateway-token
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  GATEWAY_TOKEN_TTL_SECONDS,
  issueGatewayToken,
  verifyGatewayToken,
  type GatewayTokenDeps,
} from '../src/domain/model-gateway-token/gateway-token'

const KEY = 'k'.repeat(40)
const USER = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const AGENT = '33333333-3333-4333-8333-333333333333'
const ORIGIN = 'https://app.example.com'
let t = new Date('2026-10-01T10:00:00Z')
let failures = 0

const audits: string[] = []
const state = {
  userStatus: 'active',
  tenantSlug: 'acme',
  memberActive: true,
  agentStatus: 'active',
  agentVisible: true,
  oauth: true,
}

function deps(over: Partial<GatewayTokenDeps> = {}): GatewayTokenDeps {
  return {
    signingKey: KEY,
    now: () => t,
    verifyOAuthToken: async () => (state.oauth ? { clerkUserId: 'clerk_1' } : null),
    users: {
      findByExternalAuthId: async () => ({ id: USER, status: state.userStatus }) as never,
      findById: async () => ({ id: USER, status: state.userStatus }) as never,
    },
    tenants: {
      findBySlug: async (s: string) => (s === state.tenantSlug ? ({ id: TENANT, slug: s, status: 'active' } as never) : null),
      findById: async () => null,
    },
    memberships: {
      findByTenantAndUser: async () => ({ status: state.memberActive ? 'active' : 'suspended', role: 'operator' }) as never,
    },
    platformMemberships: { findByUser: async () => [] },
    audit: { append: async (a) => void audits.push(a.action) },
    loadDefinition: async ({ agentId }) => (agentId === AGENT ? { agentId, status: state.agentStatus } : null) as never,
    canViewAgent: async () => state.agentVisible,
    policyVersion: async () => 'pv1',
    ...over,
  }
}

const body = { tenantSlug: 'acme', agentId: AGENT, installId: 'inst-1' }
const issue = (d = deps(), b: unknown = body, auth: string | null = 'Bearer oauth') =>
  issueGatewayToken(d, { authorizationHeader: auth, resourceOrigin: ORIGIN, body: b })

async function check(name: string, fn: () => Promise<void>) {
  Object.assign(state, { userStatus: 'active', tenantSlug: 'acme', memberActive: true, agentStatus: 'active', agentVisible: true, oauth: true })
  t = new Date('2026-10-01T10:00:00Z')
  audits.length = 0
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

async function token(): Promise<string> {
  const r = await issue()
  assert.ok(r.ok)
  return r.token
}

async function main() {
  await check('kiadás: 10 perces JWT, claimek, audit', async () => {
    const r = await issue()
    assert.ok(r.ok)
    const v = await verifyGatewayToken(deps(), `Bearer ${r.token}`)
    assert.ok(v.ok)
    assert.equal(v.claims.sub, USER)
    assert.equal(v.claims.tenant, 'acme')
    assert.equal(v.claims.agentId, AGENT)
    assert.equal(v.claims.installId, 'inst-1')
    assert.equal(v.claims.policyVersion, 'pv1')
    assert.equal(v.claims.exp - v.claims.iat, GATEWAY_TOKEN_TTL_SECONDS)
    assert.ok(audits.includes('model_gateway.token.issued'))
  })

  await check('hiányzó/érvénytelen MCP token → unauthenticated', async () => {
    assert.deepEqual(await issue(deps(), body, null), { ok: false, code: 'unauthenticated' })
    state.oauth = false
    assert.deepEqual(await issue(), { ok: false, code: 'unauthenticated' })
  })

  await check('más tenant / nem tag → forbidden', async () => {
    assert.deepEqual(await issue(deps(), { ...body, tenantSlug: 'other' }), { ok: false, code: 'forbidden' })
    state.memberActive = false
    assert.deepEqual(await issue(), { ok: false, code: 'forbidden' })
  })

  await check('nem látható / nyugdíjazott / ismeretlen / nem-UUID agent → agent_not_found', async () => {
    state.agentVisible = false
    assert.deepEqual(await issue(), { ok: false, code: 'agent_not_found' })
    state.agentVisible = true
    state.agentStatus = 'retired'
    assert.deepEqual(await issue(), { ok: false, code: 'agent_not_found' })
    state.agentStatus = 'active'
    assert.deepEqual(await issue(deps(), { ...body, agentId: '44444444-4444-4444-8444-444444444444' }), { ok: false, code: 'agent_not_found' })
    assert.deepEqual(await issue(deps(), { ...body, agentId: 'nem-uuid' }), { ok: false, code: 'agent_not_found' })
    assert.ok(audits.includes('model_gateway.token.deny'))
  })

  await check('hibás törzs → bad_request', async () => {
    assert.deepEqual(await issue(deps(), null), { ok: false, code: 'bad_request' })
    assert.deepEqual(await issue(deps(), { ...body, installId: '' }), { ok: false, code: 'bad_request' })
  })

  await check('hiányzó / rövid aláíró kulcs → fail-closed', async () => {
    assert.deepEqual(await issue(deps({ signingKey: undefined })), { ok: false, code: 'key_missing' })
    assert.deepEqual(await issue(deps({ signingKey: 'rovid' })), { ok: false, code: 'key_missing' })
    const tok = await token()
    assert.deepEqual(await verifyGatewayToken(deps({ signingKey: undefined }), `Bearer ${tok}`), { ok: false, code: 'key_missing' })
  })

  await check('lejárt JWT → invalid_token', async () => {
    const tok = await token()
    t = new Date(t.getTime() + (GATEWAY_TOKEN_TTL_SECONDS + 1) * 1000)
    assert.deepEqual(await verifyGatewayToken(deps(), `Bearer ${tok}`), { ok: false, code: 'invalid_token' })
  })

  await check('módosított aláírás / payload / alg=none → invalid_token', async () => {
    const [h, b, s] = (await token()).split('.')
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b, 'base64url').toString()), agentId: 'x' })).toString('base64url')
    for (const bad of [`${h}.${b}.${s.slice(0, -2)}AA`, `${h}.${forged}.${s}`, `${h}.${b}.`, 'nem.jwt', 'x']) {
      assert.deepEqual(await verifyGatewayToken(deps(), `Bearer ${bad}`), { ok: false, code: 'invalid_token' })
    }
    const none = Buffer.from('{"alg":"none"}').toString('base64url')
    const sig = createHmac('sha256', KEY).update(`${none}.${b}`).digest('base64url')
    assert.deepEqual(await verifyGatewayToken(deps(), `Bearer ${none}.${b}.${sig}`), { ok: false, code: 'invalid_token' })
    assert.deepEqual(await verifyGatewayToken(deps(), `Bearer ${h}.${b}.${createHmac('sha256', 'masik'.repeat(10)).update(`${h}.${b}`).digest('base64url')}`), { ok: false, code: 'invalid_token' })
  })

  await check('visszavonás a JWT lejárta előtt: letiltott user / kilépett tag / elvett agent → forbidden', async () => {
    const tok = await token()
    state.userStatus = 'suspended'
    assert.deepEqual(await verifyGatewayToken(deps(), `Bearer ${tok}`), { ok: false, code: 'forbidden' })
    state.userStatus = 'active'
    state.memberActive = false
    assert.deepEqual(await verifyGatewayToken(deps(), `Bearer ${tok}`), { ok: false, code: 'forbidden' })
    state.memberActive = true
    state.agentVisible = false
    assert.deepEqual(await verifyGatewayToken(deps(), `Bearer ${tok}`), { ok: false, code: 'forbidden' })
    state.agentVisible = true
    state.agentStatus = 'retired'
    assert.deepEqual(await verifyGatewayToken(deps(), `Bearer ${tok}`), { ok: false, code: 'forbidden' })
    assert.ok(audits.includes('model_gateway.token.revoked'))
  })

  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  if (failures) process.exit(1)
}
void main()
