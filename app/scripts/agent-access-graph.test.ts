/**
 * Agent-hozzáférési gráf — elfogadási tesztmátrix (Access-Policy §agent-scope, #142).
 *
 * Futtatás: npx tsx scripts/agent-access-graph.test.ts
 *
 * A tesztek két rétegre bomlanak:
 *  1. a TISZTA policy-mag (`src/lib/agent-access-graph.ts`) — DB nélkül;
 *  2. az `AgentAccessService` befecskendezett, memóriabeli tárakkal — így a
 *     lista-szűrés, az audit és a deny-szemantika is bizonyítható DB nélkül.
 *
 * Az elfogadási feltételek, amiket ez a fájl fed:
 *  - ugyanaz a mátrix fut user és agent subjecttel, mindkét igére, nyitott/zárt
 *    inbound/outbound kombinációkkal;
 *  - cross-tenant target MINDEN esetben tiltott, függetlenül a grant-adattól;
 *  - `view=false,address=true` és `view=true,address=false` külön eset, egyikből sem
 *    következik a másik;
 *  - a szűrt lista eredménye MEGEGYEZIK az elemenkénti `canAccessAgent` halmazzal;
 *  - explicit deny a `view` függvényében determinisztikusan 403 vagy 404;
 *  - lista-szűrés NEM ír deny auditot;
 *  - sikeres explicit elérés auditja tartalmaz `grantId`-t vagy `default-open` értéket;
 *  - ciklusos gráf terminál, 5 hopnál figyelmeztetés, de a policy nem vág el utat;
 *  - panel-varázsló tool-úton elérhetetlen; Web-Egress csak agent→agent `address`-szel.
 */
import assert from 'node:assert/strict'
import {
  evaluateAgentAccess,
  isEligibleAgentAccessGraphUserStatus,
  isEligibleAgentAccessSubjectMembership,
  isFullyDefaultOpen,
  reachableAgentIds,
  disclosureForDeny,
  REACHABILITY_DEPTH_WARNING_THRESHOLD,
  type AgentAccessGrantEdge,
  type AgentAccessSubject,
  type AgentAccessTargetNode,
  type AgentAccessVerb,
} from '../src/lib/agent-access-graph'
import { connectionState, type GraphAgentView } from '../src/lib/agent-access-graph-view'
import {
  AgentAccessService,
  type AgentGraphNode,
} from '../src/domain/agent-access/agent-access-service'
import { AgentAccessError } from '../src/domain/agent-access/agent-access-errors'
import type { AgentAccessGrantRepository } from '../src/repositories/interfaces'

let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const TENANT = '11111111-1111-1111-1111-111111111111'
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222'

function node(over: Partial<AgentGraphNode> & { id: string }): AgentGraphNode {
  return {
    tenantId: TENANT,
    name: `Agent ${over.id}`,
    personaNickname: null,
    personaTrait: null,
    role: 'worker',
    systemRole: null,
    status: 'active',
    hiddenFromOperators: false,
    inboundRestricted: false,
    outboundRestricted: false,
    taskOnly: false,
    ...over,
  }
}

// ── 1. Tiszta policy-mag ──────────────────────────────────────────────────────

async function pureCoreTests() {
  console.log('\nTiszta policy-mag')

  const target = (over: Partial<AgentAccessTargetNode> = {}): AgentAccessTargetNode => ({
    id: 'target',
    tenantId: TENANT,
    inboundRestricted: false,
    outboundRestricted: false,
    hiddenFromOperators: false,
    status: 'active',
    ...over,
  })

  const userSubject: AgentAccessSubject = { kind: 'user', userId: 'u1', tenantId: TENANT }
  const agentSubject: AgentAccessSubject = { kind: 'agent', agentId: 'a1', tenantId: TENANT }
  const source = { id: 'a1', tenantId: TENANT as string | null, outboundRestricted: false }

  await check('org-ábra / grant-alany: pending tagság is elfogadott (első belépés előtt)', () => {
    assert.equal(isEligibleAgentAccessSubjectMembership('active'), true)
    assert.equal(isEligibleAgentAccessSubjectMembership('pending'), true)
    assert.equal(isEligibleAgentAccessSubjectMembership('suspended'), false)
    assert.equal(isEligibleAgentAccessGraphUserStatus('active'), true)
    assert.equal(isEligibleAgentAccessGraphUserStatus('pending'), true)
    assert.equal(isEligibleAgentAccessGraphUserStatus('suspended'), false)
  })

  await check('szerkesztő: előzetes grant default-open agentnél is grant-ként látszik', () => {
    const openAgent: GraphAgentView = {
      id: 'open',
      name: 'Open',
      nickname: 'Open',
      role: 'worker',
      status: 'active',
      hiddenFromOperators: false,
      inboundRestricted: false,
      outboundRestricted: false,
      adminOnly: false,
    }
    // Runtime C4: default-open, grant nélkül is engedett.
    const without = connectionState({
      tenantId: TENANT,
      agents: [openAgent],
      grants: [],
      subject: { kind: 'user', id: 'u1' },
      targetAgentId: 'open',
      verb: 'view',
    })
    assert.deepEqual(without, { allowed: true, basis: 'implicit' })

    // Admin előre felvett kapcsolatot — a gombnak bekapcsoltnak kell látszania,
    // különben a mentés után is „(alapból)" marad (úgy tűnik, nem lehet állítani).
    const withGrant = connectionState({
      tenantId: TENANT,
      agents: [openAgent],
      grants: [
        {
          id: 'g1',
          subjectType: 'user',
          subjectUserId: 'u1',
          subjectAgentId: null,
          targetAgentId: 'open',
          canView: true,
          canAddress: false,
        },
      ],
      subject: { kind: 'user', id: 'u1' },
      targetAgentId: 'open',
      verb: 'view',
    })
    assert.deepEqual(withGrant, { allowed: true, basis: 'grant' })

    const addressStillImplicit = connectionState({
      tenantId: TENANT,
      agents: [openAgent],
      grants: [
        {
          id: 'g1',
          subjectType: 'user',
          subjectUserId: 'u1',
          subjectAgentId: null,
          targetAgentId: 'open',
          canView: true,
          canAddress: false,
        },
      ],
      subject: { kind: 'user', id: 'u1' },
      targetAgentId: 'open',
      verb: 'address',
    })
    assert.deepEqual(addressStillImplicit, { allowed: true, basis: 'implicit' })
  })

  // C4 kompatibilitási alapérték: korlátozás nélkül grant nélkül is engedett.
  for (const verb of ['view', 'address'] as AgentAccessVerb[]) {
    await check(`C4 default-open — user→agent, ${verb}`, () => {
      const d = evaluateAgentAccess({ subject: userSubject, target: target(), verb })
      assert.equal(d.allowed, true)
      if (d.allowed) assert.equal(d.basis.kind, 'default-open')
    })
    await check(`C4 default-open — agent→agent, ${verb}`, () => {
      const d = evaluateAgentAccess({ subject: agentSubject, target: target(), source, verb })
      assert.equal(d.allowed, true)
      if (d.allowed) assert.equal(d.basis.kind, 'default-open')
    })
  }

  // Zárt inbound / outbound kombinációk, grant nélkül.
  await check('inbound zárva, grant nélkül → missing_grant (user)', () => {
    const d = evaluateAgentAccess({
      subject: userSubject,
      target: target({ inboundRestricted: true }),
      verb: 'address',
    })
    assert.equal(d.allowed, false)
    if (!d.allowed) assert.equal(d.reason, 'missing_grant')
  })

  await check('a forrás outbound zárva → agent→agent grant nélkül tiltott', () => {
    const d = evaluateAgentAccess({
      subject: agentSubject,
      target: target(),
      source: { ...source, outboundRestricted: true },
      verb: 'address',
    })
    assert.equal(d.allowed, false)
  })

  await check('inbound zárva NEM zárja az agent→agent default-open utat (normál agent)', () => {
    const d = evaluateAgentAccess({
      subject: agentSubject,
      target: target({ inboundRestricted: true }),
      source,
      verb: 'address',
    })
    assert.equal(d.allowed, true)
    if (d.allowed) assert.equal(d.basis.kind, 'default-open')
  })

  await check('Web-Egress cél: agent→agent inbound továbbra is grant-kötött', () => {
    const d = evaluateAgentAccess({
      subject: agentSubject,
      target: target({ inboundRestricted: true, systemRole: 'web_egress' }),
      source,
      verb: 'address',
    })
    assert.equal(d.allowed, false)
    if (!d.allowed) assert.equal(d.reason, 'missing_grant')
  })

  await check('user→agent-nél a forrás outbound-ja IRRELEVÁNS (a usernek nincs ilyen)', () => {
    const d = evaluateAgentAccess({
      subject: userSubject,
      target: target({ outboundRestricted: true }),
      verb: 'address',
    })
    assert.equal(d.allowed, true)
  })

  // A két ige FÜGGETLEN.
  const viewOnly: AgentAccessGrantEdge = { id: 'g-view', canView: true, canAddress: false }
  const addressOnly: AgentAccessGrantEdge = { id: 'g-addr', canView: false, canAddress: true }

  await check('view=true, address=false → csak a view engedett', () => {
    const t = target({ inboundRestricted: true })
    assert.equal(evaluateAgentAccess({ subject: userSubject, target: t, grant: viewOnly, verb: 'view' }).allowed, true)
    assert.equal(
      evaluateAgentAccess({ subject: userSubject, target: t, grant: viewOnly, verb: 'address' }).allowed,
      false,
    )
  })

  await check('view=false, address=true → az address NEM implikál view-t', () => {
    const t = target({ inboundRestricted: true })
    assert.equal(
      evaluateAgentAccess({ subject: userSubject, target: t, grant: addressOnly, verb: 'address' }).allowed,
      true,
    )
    assert.equal(
      evaluateAgentAccess({ subject: userSubject, target: t, grant: addressOnly, verb: 'view' }).allowed,
      false,
    )
  })

  await check('engedő grant esetén a döntés az ÉL azonosítóját adja vissza (audithoz)', () => {
    const d = evaluateAgentAccess({
      subject: userSubject,
      target: target({ inboundRestricted: true }),
      grant: addressOnly,
      verb: 'address',
    })
    assert.equal(d.allowed, true)
    if (d.allowed) {
      assert.equal(d.basis.kind, 'grant')
      if (d.basis.kind === 'grant') assert.equal(d.basis.grantId, 'g-addr')
    }
  })

  // Tenant-határ: ABSZOLÚT, hibás grant-adat sem viszi át.
  await check('cross-tenant target tiltott — engedő granttal is', () => {
    const d = evaluateAgentAccess({
      subject: userSubject,
      target: target({ tenantId: OTHER_TENANT }),
      grant: { id: 'g', canView: true, canAddress: true },
      verb: 'address',
    })
    assert.equal(d.allowed, false)
    if (!d.allowed) assert.equal(d.reason, 'tenant_boundary')
  })

  await check('platform-agent (tenantId=null) sosem gráfcsomópont', () => {
    const d = evaluateAgentAccess({
      subject: userSubject,
      target: target({ tenantId: null }),
      grant: { id: 'g', canView: true, canAddress: true },
      verb: 'view',
    })
    assert.equal(d.allowed, false)
    if (!d.allowed) assert.equal(d.reason, 'platform_agent_unreachable')
  })

  // hiddenFromOperators: katalógus-szabály, csak a NON-ADMIN user `view`-ját érinti.
  await check('hiddenFromOperators: non-admin user view-ját szűri, grant nem írja felül', () => {
    const t = target({ hiddenFromOperators: true, inboundRestricted: true })
    const grant: AgentAccessGrantEdge = { id: 'g', canView: true, canAddress: true }
    const d = evaluateAgentAccess({ subject: userSubject, target: t, grant, verb: 'view' })
    assert.equal(d.allowed, false)
    if (!d.allowed) assert.equal(d.reason, 'target_hidden')
  })

  await check('hiddenFromOperators: az ADDRESS döntést nem befolyásolja', () => {
    const t = target({ hiddenFromOperators: true, inboundRestricted: true })
    const grant: AgentAccessGrantEdge = { id: 'g', canView: false, canAddress: true }
    assert.equal(evaluateAgentAccess({ subject: userSubject, target: t, grant, verb: 'address' }).allowed, true)
  })

  await check('hiddenFromOperators: adminnak nem szűr', () => {
    const t = target({ hiddenFromOperators: true })
    const d = evaluateAgentAccess({
      subject: userSubject,
      target: t,
      verb: 'view',
      options: { subjectIsTenantAdmin: true },
    })
    assert.equal(d.allowed, true)
  })

  await check('hiddenFromOperators: agent subjectre nem vonatkozik', () => {
    const t = target({ hiddenFromOperators: true })
    assert.equal(evaluateAgentAccess({ subject: agentSubject, target: t, source, verb: 'view' }).allowed, true)
  })

  // Felfedési szint.
  await check('deny felfedés: view engedett → forbidden, különben not_found', () => {
    assert.equal(disclosureForDeny(true), 'forbidden')
    assert.equal(disclosureForDeny(false), 'not_found')
  })
}

// ── 2. Elérhetőségi kúp ───────────────────────────────────────────────────────

async function coneTests() {
  console.log('\nElérhetőségi kúp')

  const nodes = new Map<string, AgentAccessTargetNode>()
  const mk = (id: string, over: Partial<AgentAccessTargetNode> = {}) => {
    nodes.set(id, {
      id,
      tenantId: TENANT,
      inboundRestricted: true,
      outboundRestricted: false,
      hiddenFromOperators: false,
      status: 'active',
      ...over,
    })
  }
  // Lánc: a→b→c→d→e→f (6 hop), és f→a visszacsatolás (ciklus).
  // outboundRestricted: a lánc CSAK az explicit agent-éleken menjen (az inbound
  // a user→agent mátrixot zárja, nem az agent→agent default-open utat).
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) mk(id, { outboundRestricted: true })

  const agentGrants = new Map<string, Map<string, AgentAccessGrantEdge>>()
  const link = (from: string, to: string) => {
    const inner = agentGrants.get(from) ?? new Map<string, AgentAccessGrantEdge>()
    inner.set(to, { id: `g-${from}-${to}`, canView: true, canAddress: true })
    agentGrants.set(from, inner)
  }
  link('a', 'b')
  link('b', 'c')
  link('c', 'd')
  link('d', 'e')
  link('e', 'f')
  link('f', 'a')

  await check('ciklusos gráf terminál, minden agentet egyszer vesz fel', () => {
    const cone = reachableAgentIds({ seedAgentIds: ['a'], nodes, agentGrants, tenantId: TENANT })
    assert.deepEqual([...cone.agentIds].sort(), ['a', 'b', 'c', 'd', 'e', 'f'])
    assert.equal(cone.hasCycle, true)
  })

  await check('5 hopnál mélyebb lánc figyelmeztetést vált ki, de nem vág el utat', () => {
    const cone = reachableAgentIds({ seedAgentIds: ['a'], nodes, agentGrants, tenantId: TENANT })
    assert.ok(cone.maxDepth >= REACHABILITY_DEPTH_WARNING_THRESHOLD)
    // A policy nem vágja el: a lánc VÉGE is benne van a kúpban.
    assert.ok(cone.agentIds.includes('f'))
  })

  await check('gyémánt/DAG (közös leszármazott két úton) NEM ciklus', () => {
    // s → x, s → y, x → t, y → t. Nincs visszaél, tehát nincs valódi kör — de a
    // `t` csomópont két külön úton is elérhető. A korábbi „már láttam" jelzés ezt
    // hamisan ciklusnak minősítette; a governance-figyelmeztetés így minden reális
    // szervezetben (bármely, több kollégán át is elérhető agentnél) tévesen villant.
    const dagNodes = new Map<string, AgentAccessTargetNode>()
    for (const id of ['s', 'x', 'y', 't']) {
      dagNodes.set(id, {
        id,
        tenantId: TENANT,
        inboundRestricted: true,
        outboundRestricted: true,
        hiddenFromOperators: false,
        status: 'active',
      })
    }
    const dagGrants = new Map<string, Map<string, AgentAccessGrantEdge>>()
    const dagLink = (from: string, to: string) => {
      const inner = dagGrants.get(from) ?? new Map<string, AgentAccessGrantEdge>()
      inner.set(to, { id: `d-${from}-${to}`, canView: true, canAddress: true })
      dagGrants.set(from, inner)
    }
    dagLink('s', 'x')
    dagLink('s', 'y')
    dagLink('x', 't')
    dagLink('y', 't')

    const cone = reachableAgentIds({
      seedAgentIds: ['s'],
      nodes: dagNodes,
      agentGrants: dagGrants,
      tenantId: TENANT,
    })
    assert.deepEqual([...cone.agentIds].sort(), ['s', 't', 'x', 'y'])
    assert.equal(cone.hasCycle, false)
    assert.equal(cone.maxDepth, 3) // s(1) → x/y(2) → t(3)
  })

  await check('valódi kölcsönös kör (a↔b) hasCycle=true', () => {
    const twoNodes = new Map<string, AgentAccessTargetNode>()
    for (const id of ['p', 'q']) {
      twoNodes.set(id, {
        id,
        tenantId: TENANT,
        inboundRestricted: true,
        outboundRestricted: true,
        hiddenFromOperators: false,
        status: 'active',
      })
    }
    const twoGrants = new Map<string, Map<string, AgentAccessGrantEdge>>([
      ['p', new Map([['q', { id: 'e-p-q', canView: true, canAddress: true }]])],
      ['q', new Map([['p', { id: 'e-q-p', canView: true, canAddress: true }]])],
    ])
    const cone = reachableAgentIds({
      seedAgentIds: ['p'],
      nodes: twoNodes,
      agentGrants: twoGrants,
      tenantId: TENANT,
    })
    assert.deepEqual([...cone.agentIds].sort(), ['p', 'q'])
    assert.equal(cone.hasCycle, true)
  })

  await check('teljesen nyitott gráf felismerése (nincs N² él-rajzolás)', () => {
    const open = [
      { ...nodes.get('a')!, inboundRestricted: false, outboundRestricted: false },
      { ...nodes.get('b')!, inboundRestricted: false, outboundRestricted: false },
    ]
    assert.equal(isFullyDefaultOpen(open), true)
    assert.equal(isFullyDefaultOpen([...open, nodes.get('c')!]), false)
  })
}

// ── 3. Service: lista-szűrés, audit, deny-szemantika ──────────────────────────

type AuditRow = { action: string; metadata: Record<string, unknown>; policyDecision: string | null }

function buildService(params: {
  agents: AgentGraphNode[]
  grants?: Array<{
    id: string
    tenantId: string
    subjectType: 'user' | 'agent'
    subjectUserId: string | null
    subjectAgentId: string | null
    targetAgentId: string
    canView: boolean
    canAddress: boolean
  }>
}) {
  const rows = params.grants ?? []
  const audits: AuditRow[] = []

  const matches = (
    row: (typeof rows)[number],
    key: { subjectType: string; subjectUserId?: string | null; subjectAgentId?: string | null },
  ) =>
    row.subjectType === key.subjectType &&
    (key.subjectType === 'user'
      ? row.subjectUserId === key.subjectUserId
      : row.subjectAgentId === key.subjectAgentId)

  const grants = {
    findEdge: async (key) =>
      (rows.find(
        (r) => r.tenantId === key.tenantId && r.targetAgentId === key.targetAgentId && matches(r, key),
      ) ?? null) as never,
    listBySubject: async (key) =>
      rows.filter((r) => r.tenantId === key.tenantId && matches(r, key)) as never,
    listByTarget: async (tenantId, targetAgentId) =>
      rows.filter((r) => r.tenantId === tenantId && r.targetAgentId === targetAgentId) as never,
    listAgentEdgesForTenant: async (tenantId) =>
      rows.filter((r) => r.tenantId === tenantId && r.subjectType === 'agent') as never,
    listForTenant: async (tenantId) => rows.filter((r) => r.tenantId === tenantId) as never,
    upsertEdge: async () => ({ ok: false, reason: 'no_verb' }) as never,
    deleteEdge: async () => ({ ok: false, reason: 'not_found' }) as never,
  } satisfies AgentAccessGrantRepository

  const service = new AgentAccessService({
    agents: {
      findById: async (agentId) => params.agents.find((a) => a.id === agentId) ?? null,
      listForTenant: async (tenantId) => params.agents.filter((a) => a.tenantId === tenantId),
      setRestrictions: async () => ({
        previous: { inboundRestricted: false, outboundRestricted: false },
        next: { inboundRestricted: false, outboundRestricted: false },
      }),
    },
    grants,
    audit: {
      append: async (data) => {
        audits.push({
          action: data.action,
          metadata: (data.metadata ?? {}) as Record<string, unknown>,
          policyDecision: data.policyDecision,
        })
        return {} as never
      },
    },
  })

  return { service, audits }
}

async function serviceTests() {
  console.log('\nService: lista-szűrés, audit, deny-szemantika')

  const open = node({ id: 'open' })
  const closed = node({ id: 'closed', inboundRestricted: true })
  const hidden = node({ id: 'hidden', hiddenFromOperators: true })
  const foreign = node({ id: 'foreign', tenantId: OTHER_TENANT })
  const wizard = node({ id: 'wizard', tenantId: null, name: 'Playbook Author' })
  const webEgress = node({
    id: 'egress',
    name: 'Web-Egress Worker',
    systemRole: 'web_egress',
    inboundRestricted: true,
    outboundRestricted: true,
    hiddenFromOperators: true,
  })
  const caller = node({ id: 'caller' })

  const allAgents = [open, closed, hidden, foreign, wizard, webEgress, caller]

  await check('a szűrt lista MEGEGYEZIK az elemenkénti canAccessAgent halmazzal (user, view)', async () => {
    const { service } = buildService({ agents: allAgents })
    const subject: AgentAccessSubject = { kind: 'user', userId: 'u1', tenantId: TENANT }
    const listed = (await service.listAccessibleAgents(subject, 'view')).map((a) => a.id).sort()

    const perItem: string[] = []
    for (const agent of allAgents) {
      // A lista a napi operátori felületet modellezi: a csak-admin csomópont ott nem
      // jelenik meg, ezért az elemenkénti összevetésből is kihagyjuk.
      if (agent.systemRole === 'web_egress') continue
      const d = await service.canAccessAgent(subject, agent.id, 'view')
      if (d.allowed) perItem.push(agent.id)
    }
    assert.deepEqual(listed, perItem.sort())
  })

  await check('a szűrt lista MEGEGYEZIK az elemenkénti döntésekkel (agent, address)', async () => {
    const { service } = buildService({ agents: allAgents })
    const subject: AgentAccessSubject = { kind: 'agent', agentId: caller.id, tenantId: TENANT }
    const listed = (await service.listAccessibleAgents(subject, 'address')).map((a) => a.id).sort()

    const perItem: string[] = []
    for (const agent of allAgents) {
      if (agent.id === caller.id) continue
      const d = await service.canAccessAgent(subject, agent.id, 'address')
      if (d.allowed) perItem.push(agent.id)
    }
    assert.deepEqual(listed, perItem.sort())
  })

  await check('a lista SOSEM tartalmaz más tenant agentjét vagy panel-varázslót', async () => {
    const { service } = buildService({ agents: allAgents })
    const listed = await service.listAccessibleAgents(
      { kind: 'agent', agentId: caller.id, tenantId: TENANT },
      'view',
    )
    const ids = listed.map((a) => a.id)
    assert.ok(!ids.includes('foreign'))
    assert.ok(!ids.includes('wizard'))
  })

  await check('lista-szűrés NEM ír deny auditot', async () => {
    const { service, audits } = buildService({ agents: allAgents })
    await service.listAccessibleAgents({ kind: 'user', userId: 'u1', tenantId: TENANT }, 'view')
    assert.equal(audits.length, 0)
  })

  await check('sikeres explicit elérés auditja `default-open` alapot rögzít', async () => {
    const { service, audits } = buildService({ agents: allAgents })
    await service.assertCanAccessAgent({
      subject: { kind: 'user', userId: 'u1', tenantId: TENANT },
      targetAgentId: open.id,
      verb: 'address',
      audit: { channel: 'chat' },
    })
    const row = audits.find((a) => a.action === 'agent.access.granted')
    assert.ok(row, 'nincs agent.access.granted esemény')
    assert.equal(row!.metadata.decisionBasis, 'default-open')
    assert.equal(row!.metadata.channel, 'chat')
  })

  await check('sikeres explicit elérés auditja az ENGEDŐ él azonosítóját rögzíti', async () => {
    const { service, audits } = buildService({
      agents: allAgents,
      grants: [
        {
          id: 'grant-1',
          tenantId: TENANT,
          subjectType: 'user',
          subjectUserId: 'u1',
          subjectAgentId: null,
          targetAgentId: closed.id,
          canView: false,
          canAddress: true,
        },
      ],
    })
    await service.assertCanAccessAgent({
      subject: { kind: 'user', userId: 'u1', tenantId: TENANT },
      targetAgentId: closed.id,
      verb: 'address',
      audit: { channel: 'agent_ask' },
    })
    const row = audits.find((a) => a.action === 'agent.access.granted')
    assert.equal(row!.metadata.decisionBasis, 'grant-1')
  })

  await check('deny: `view` engedett, `address` nem → 403 (AGENT_ACCESS_FORBIDDEN)', async () => {
    const { service, audits } = buildService({
      agents: allAgents,
      grants: [
        {
          id: 'grant-view-only',
          tenantId: TENANT,
          subjectType: 'user',
          subjectUserId: 'u1',
          subjectAgentId: null,
          targetAgentId: closed.id,
          canView: true,
          canAddress: false,
        },
      ],
    })
    await assert.rejects(
      () =>
        service.assertCanAccessAgent({
          subject: { kind: 'user', userId: 'u1', tenantId: TENANT },
          targetAgentId: closed.id,
          verb: 'address',
          audit: { channel: 'chat' },
        }),
      (e: unknown) => {
        assert.ok(e instanceof AgentAccessError)
        assert.equal((e as AgentAccessError).code, 'AGENT_ACCESS_FORBIDDEN')
        assert.equal((e as AgentAccessError).httpStatus, 403)
        return true
      },
    )
    const row = audits.find((a) => a.action === 'agent.access.denied')
    assert.equal(row!.metadata.disclosure, 'forbidden')
  })

  await check('deny: `view` sincs → 404-jellegű (AGENT_NOT_FOUND), a cél léte nem szivárog', async () => {
    const { service, audits } = buildService({ agents: allAgents })
    await assert.rejects(
      () =>
        service.assertCanAccessAgent({
          subject: { kind: 'user', userId: 'u1', tenantId: TENANT },
          targetAgentId: closed.id,
          verb: 'address',
          audit: { channel: 'chat' },
        }),
      (e: unknown) => {
        assert.ok(e instanceof AgentAccessError)
        assert.equal((e as AgentAccessError).code, 'AGENT_NOT_FOUND')
        assert.equal((e as AgentAccessError).httpStatus, 404)
        return true
      },
    )
    const row = audits.find((a) => a.action === 'agent.access.denied')
    assert.equal(row!.metadata.disclosure, 'not_found')
  })

  await check('panel-varázsló tool-úton elérhetetlen', async () => {
    const { service } = buildService({ agents: allAgents })
    const d = await service.canAccessAgent(
      { kind: 'agent', agentId: caller.id, tenantId: TENANT },
      wizard.id,
      'address',
    )
    assert.equal(d.allowed, false)
    if (!d.allowed) assert.equal(d.reason, 'platform_agent_unreachable')
  })

  await check('Web-Egress: user közvetlenül NEM címezheti', async () => {
    const { service } = buildService({
      agents: allAgents,
      grants: [
        {
          id: 'g-user-egress',
          tenantId: TENANT,
          subjectType: 'user',
          subjectUserId: 'u1',
          subjectAgentId: null,
          targetAgentId: webEgress.id,
          canView: true,
          canAddress: true,
        },
      ],
    })
    const d = await service.canAccessAgent(
      { kind: 'user', userId: 'u1', tenantId: TENANT },
      webEgress.id,
      'address',
    )
    assert.equal(d.allowed, false)
  })

  await check('Web-Egress: agent→Web-Egress CSAK explicit `address` granttal', async () => {
    const subject: AgentAccessSubject = { kind: 'agent', agentId: caller.id, tenantId: TENANT }

    const without = buildService({ agents: allAgents })
    assert.equal((await without.service.canAccessAgent(subject, webEgress.id, 'address')).allowed, false)

    const withGrant = buildService({
      agents: allAgents,
      grants: [
        {
          id: 'g-agent-egress',
          tenantId: TENANT,
          subjectType: 'agent',
          subjectUserId: null,
          subjectAgentId: caller.id,
          targetAgentId: webEgress.id,
          canView: false,
          canAddress: true,
        },
      ],
    })
    assert.equal((await withGrant.service.canAccessAgent(subject, webEgress.id, 'address')).allowed, true)
  })

  await check('Web-Egress egyirányú: kimenő éle nincs (üres lista)', async () => {
    const { service } = buildService({ agents: allAgents })
    const listed = await service.listAccessibleAgents(
      { kind: 'agent', agentId: webEgress.id, tenantId: TENANT },
      'address',
    )
    assert.equal(listed.length, 0)
  })

  await check('a shadow-check deny esetén `agent.access.bypass`-t ír, engedésnél semmit', async () => {
    // Web-Egress agent→agent grant nélkül deny — a shadow ezt naplózza.
    const denied = buildService({ agents: allAgents })
    await denied.service.recordProcessBypass({
      subject: { kind: 'agent', agentId: caller.id, tenantId: TENANT },
      targetAgentId: webEgress.id,
      verb: 'address',
      processInstanceId: 'proc-1',
    })
    const row = denied.audits.find((a) => a.action === 'agent.access.bypass')
    assert.ok(row, 'nincs agent.access.bypass esemény')
    assert.equal(row!.metadata.shadowDecision, 'denied')
    assert.equal(row!.metadata.processInstanceId, 'proc-1')

    const allowed = buildService({ agents: allAgents })
    await allowed.service.recordProcessBypass({
      subject: { kind: 'agent', agentId: caller.id, tenantId: TENANT },
      targetAgentId: open.id,
      verb: 'address',
      processInstanceId: 'proc-2',
    })
    assert.equal(allowed.audits.length, 0)
  })

  await check('a cross-tenant subject nem éri el a másik tenant agentjét (fail-closed)', async () => {
    const { service } = buildService({ agents: allAgents })
    const d = await service.canAccessAgent(
      { kind: 'user', userId: 'u1', tenantId: OTHER_TENANT },
      open.id,
      'view',
    )
    assert.equal(d.allowed, false)
    if (!d.allowed) assert.equal(d.reason, 'tenant_boundary')
  })

  await check('a kúp az AGENTEK saját jogán megy tovább (I1 — confused deputy hatás)', async () => {
    // u1 csak `caller`-t szólíthatja meg; `caller` outbound-zárt, de explicit éllel
    // eléri `closed`-et. `other` outbound-zárt és nincs rá él → kimarad.
    const lockedCaller = node({ id: 'caller', outboundRestricted: true })
    const lockedClosed = node({ id: 'closed', inboundRestricted: true, outboundRestricted: true })
    const lockedOther = node({ id: 'other', inboundRestricted: true, outboundRestricted: true })
    const { service } = buildService({
      agents: [lockedCaller, lockedClosed, lockedOther],
      grants: [
        {
          id: 'g-user-caller',
          tenantId: TENANT,
          subjectType: 'user',
          subjectUserId: 'u1',
          subjectAgentId: null,
          targetAgentId: lockedCaller.id,
          canView: true,
          canAddress: true,
        },
        {
          id: 'g-caller-closed',
          tenantId: TENANT,
          subjectType: 'agent',
          subjectUserId: null,
          subjectAgentId: lockedCaller.id,
          targetAgentId: lockedClosed.id,
          canView: false,
          canAddress: true,
        },
      ],
    })
    const cone = await service.reachabilityCone({ kind: 'user', userId: 'u1', tenantId: TENANT })
    assert.deepEqual([...cone.agentIds].sort(), ['caller', 'closed'])
    assert.ok(!cone.agentIds.includes('other'))
  })
}

async function main() {
  await pureCoreTests()
  await coneTests()
  await serviceTests()

  console.log(failures === 0 ? '\nMinden teszt zöld.' : `\n${failures} teszt elbukott.`)
  process.exitCode = failures === 0 ? 0 : 1
}

void main()
