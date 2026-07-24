/**
 * Csatorna-agent-hozzáférés (CA-*) — a metszet, a projektkötés és a szervezeti kill-switch
 * VARRATA (Telegram feature-spec #70/#75, D5/D9/D13/D54). Fakes-szel, DB nélkül.
 *
 * A tesztek KIZÁRÓLAG külső viselkedést figyelnek: hatás éri a szolgáltatást (engedélyezés,
 * visszavonás, projektbeállítás, feloldás, váltás), és megnézzük, milyen DÖNTÉS született, mely
 * agentek maradtak a metszetben, és milyen audit-hatás keletkezett. A teszt SOSEM hívja külön a
 * metszet egyik oldalát (platform-jog / kill-switch) sem.
 *
 * Lefedi az AC #8 varrat-tesztjét: metszet MINDKÉT oldala, kill-switch, projektkötés.
 *
 * Futtatás: npm run test:channel-agent-access
 */
import assert from 'node:assert/strict'
import type { ChannelAgentGrant, ChannelIdentity } from '@prisma/client'
import {
  ChannelAgentAccessService,
  type ChannelAgentDirectory,
} from '../src/domain/channel/channel-agent-access-service'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'
import type {
  AuditRepository,
  ChannelAgentGrantRepository,
  ChannelIdentityRepository,
} from '../src/repositories/interfaces'

let failures = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? (e.stack ?? e.message) : e}`)
  }
}

type AuditRow = {
  action: string
  targetType: string
  policyDecision: string | null
  metadata: Record<string, unknown>
}

const TENANT_A = '11111111-1111-1111-1111-111111111111'
const TENANT_B = '22222222-2222-2222-2222-222222222222'
const USER_1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const USER_2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const ADMIN = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

function makeHarness() {
  const auditRows: AuditRow[] = []
  const audit: Pick<AuditRepository, 'append'> = {
    async append(row) {
      // Fail-fast: minden action a katalógusban van (mint a valódi append).
      assertAuditActionRegistered(row.action)
      auditRows.push({
        action: row.action,
        targetType: row.targetType,
        policyDecision: row.policyDecision,
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
      })
      return {} as Awaited<ReturnType<AuditRepository['append']>>
    },
  }

  const identities = new Map<string, ChannelIdentity>()
  const identityRepo: Pick<ChannelIdentityRepository, 'findById'> = {
    async findById(id) {
      return identities.get(id) ?? null
    },
  }

  const grants = new Map<string, ChannelAgentGrant>()
  let grantSeq = 0
  const grantRepo: ChannelAgentGrantRepository = {
    async listByIdentity(identityId) {
      return [...grants.values()].filter((g) => g.identityId === identityId)
    },
    async hasAnyGrant(identityId) {
      return [...grants.values()].some((g) => g.identityId === identityId)
    },
    async listByIdentityIds(ids) {
      return [...grants.values()].filter((g) => ids.includes(g.identityId))
    },
    async findByIdentityAndAgent(identityId, agentId) {
      return (
        [...grants.values()].find((g) => g.identityId === identityId && g.agentId === agentId) ??
        null
      )
    },
    async create(input) {
      const g: ChannelAgentGrant = {
        id: `grant-${++grantSeq}`,
        identityId: input.identityId,
        agentId: input.agentId,
        projectKey: input.projectKey ?? '__general__',
        grantedById: input.grantedById,
        grantedAt: new Date(),
        createdAt: new Date(),
      }
      grants.set(g.id, g)
      return g
    },
    async updateProjectKey(id, projectKey) {
      const g = grants.get(id)
      if (!g) throw new Error(`no grant ${id}`)
      const next = { ...g, projectKey }
      grants.set(id, next)
      return next
    },
    async deleteById(id) {
      grants.delete(id)
    },
  }

  type AgentRow = { id: string; name: string; tenantId: string | null; usable: boolean }
  const agentRows = new Map<string, AgentRow>()
  const directory: ChannelAgentDirectory = {
    async listForTenant(tenantId) {
      return [...agentRows.values()]
        .filter((a) => a.tenantId === tenantId)
        .map((a) => ({ id: a.id, name: a.name, usable: a.usable }))
    },
    async findInTenant(agentId, tenantId) {
      const a = agentRows.get(agentId)
      if (!a || a.tenantId !== tenantId) return null
      return { id: a.id, name: a.name, usable: a.usable }
    },
  }

  // Szervezeti kill-switch: tenantId → elzárva?
  const killSwitch = new Map<string, boolean>()
  const isChannelEnabled = async (tenantId: string | null) =>
    tenantId ? !(killSwitch.get(tenantId) ?? false) : false

  const service = new ChannelAgentAccessService({
    grants: grantRepo,
    identities: identityRepo,
    agents: directory,
    isChannelEnabled,
    audit,
  })

  // ── Segédek ──────────────────────────────────────────────────────────────
  let idSeq = 0
  function addIdentity(opts?: {
    userId?: string
    tenantId?: string | null
    status?: ChannelIdentity['status']
  }): ChannelIdentity {
    const now = new Date('2026-07-23T10:00:00Z')
    const row: ChannelIdentity = {
      id: `identity-${++idSeq}`,
      channelType: 'telegram',
      externalUserIdEnc: 'enc',
      lookupHash: `hash-${idSeq}`,
      tenantId: opts?.tenantId === undefined ? TENANT_A : opts.tenantId,
      userId: opts?.userId ?? USER_1,
      status: opts?.status ?? 'active',
      linkedAt: now,
      createdAt: now,
      updatedAt: now,
    }
    identities.set(row.id, row)
    return row
  }
  function addAgent(id: string, name: string, tenantId: string | null, usable = true) {
    agentRows.set(id, { id, name, tenantId, usable })
  }

  return {
    service,
    auditRows,
    grants,
    killSwitch,
    addIdentity,
    addAgent,
    actionsOf: () => auditRows.map((r) => r.action),
  }
}

async function main() {
  // ── Engedélyezés alapja + audit ────────────────────────────────────────────

  await test('CA-1 grant: admin engedélyez → grant jön létre, audit granted, projekt = gyűjtő', async () => {
    const h = makeHarness()
    const idn = h.addIdentity()
    h.addAgent('agent-1', 'Pénzügyi agent', TENANT_A)

    const res = await h.service.grantAgent({
      identityId: idn.id,
      agentId: 'agent-1',
      actorUserId: ADMIN,
      actorTenantId: TENANT_A,
    })
    assert.equal(res.ok, true)
    assert.equal(res.ok && res.created, true)
    assert.equal(res.ok && res.grant.projectKey, '__general__')
    assert.deepEqual(h.actionsOf(), ['channel.agent.granted'])
    // Álnevesített azonosító az auditban, nyers külső id sosem.
    assert.ok(typeof h.auditRows[0].metadata.pseudonym === 'string')
  })

  await test('CA-2 grant idempotens: második engedélyezés nem hoz létre új sort, nem auditál újra', async () => {
    const h = makeHarness()
    const idn = h.addIdentity()
    h.addAgent('agent-1', 'A', TENANT_A)
    await h.service.grantAgent({ identityId: idn.id, agentId: 'agent-1', actorUserId: ADMIN, actorTenantId: TENANT_A })
    const again = await h.service.grantAgent({ identityId: idn.id, agentId: 'agent-1', actorUserId: ADMIN, actorTenantId: TENANT_A })
    assert.equal(again.ok && again.created, false)
    assert.equal(h.grants.size, 1)
    assert.deepEqual(h.actionsOf(), ['channel.agent.granted'])
  })

  await test('CA-3 grant fail-closed: másik szervezet kötése / inaktív kötés / nem-aktív agent tiltva', async () => {
    const h = makeHarness()
    const foreign = h.addIdentity({ tenantId: TENANT_B })
    const inactive = h.addIdentity({ status: 'revoked' })
    const idn = h.addIdentity()
    h.addAgent('agent-1', 'A', TENANT_A)
    h.addAgent('agent-retired', 'Nyugdíjas', TENANT_A, false)

    const cross = await h.service.grantAgent({ identityId: foreign.id, agentId: 'agent-1', actorUserId: ADMIN, actorTenantId: TENANT_A })
    assert.equal(cross.ok === false && cross.reason, 'cross_tenant')

    const dead = await h.service.grantAgent({ identityId: inactive.id, agentId: 'agent-1', actorUserId: ADMIN, actorTenantId: TENANT_A })
    assert.equal(dead.ok === false && dead.reason, 'identity_inactive')

    const notUsable = await h.service.grantAgent({ identityId: idn.id, agentId: 'agent-retired', actorUserId: ADMIN, actorTenantId: TENANT_A })
    assert.equal(notUsable.ok === false && notUsable.reason, 'agent_not_usable')

    const missing = await h.service.grantAgent({ identityId: idn.id, agentId: 'agent-x', actorUserId: ADMIN, actorTenantId: TENANT_A })
    assert.equal(missing.ok === false && missing.reason, 'agent_not_found')

    assert.equal(h.grants.size, 0)
    assert.deepEqual(h.actionsOf(), []) // egyetlen fail-closed eset sem ír grant-auditot
  })

  // ── Metszet MINDKÉT oldala (D5) ─────────────────────────────────────────────

  await test('CA-4 metszet: csak a (platformon elérhető ∩ Telegramra engedélyezett) agent választható', async () => {
    const h = makeHarness()
    const idn = h.addIdentity()
    // agent-ok: engedélyezett+aktív; engedélyezett de platformon elvett; NEM engedélyezett de aktív.
    h.addAgent('agent-ok', 'Elérhető agent', TENANT_A, true)
    h.addAgent('agent-removed', 'Elvett agent', TENANT_A, false)
    h.addAgent('agent-not-granted', 'Nem engedélyezett agent', TENANT_A, true)

    // Engedélyezzük az elsőt; a másodikat is (majd platformon "elvesszük" — usable=false már most).
    await h.service.grantAgent({ identityId: idn.id, agentId: 'agent-ok', actorUserId: ADMIN, actorTenantId: TENANT_A })
    // agent-removed usable=false, ezért grant-hoz agent_not_usable lenne — a metszet teszteléséhez
    // közvetlenül helyezünk el grantot rá (a platform utólag vette el a jogot).
    h.grants.set('g-removed', {
      id: 'g-removed', identityId: idn.id, agentId: 'agent-removed', projectKey: '__general__',
      grantedById: ADMIN, grantedAt: new Date(), createdAt: new Date(),
    })

    const available = await h.service.resolveAvailableAgents(idn.id)
    assert.deepEqual(available.map((a) => a.agentId), ['agent-ok'])

    // Váltás: engedélyezett+elérhető → ok
    const okSel = await h.service.selectAgent({ identityId: idn.id, agentId: 'agent-ok' })
    assert.equal(okSel.ok, true)
    // Telegramra ENGEDÉLYEZETT, de platformon ELVETT → nem választható, érthető ok (nem nyers hiba)
    const removedSel = await h.service.selectAgent({ identityId: idn.id, agentId: 'agent-removed' })
    assert.equal(removedSel.ok === false && removedSel.reason, 'agent_removed')
    // Platformon elérhető, de Telegramra NEM engedélyezett → nem választható
    const notGranted = await h.service.selectAgent({ identityId: idn.id, agentId: 'agent-not-granted' })
    assert.equal(notGranted.ok === false && notGranted.reason, 'not_granted')
  })

  await test('CA-5 leírás: describeIdentityAgents jelzi a metszet agent-oldalát (available / agent_removed)', async () => {
    const h = makeHarness()
    const idn = h.addIdentity()
    h.addAgent('agent-ok', 'Elérhető', TENANT_A, true)
    await h.service.grantAgent({ identityId: idn.id, agentId: 'agent-ok', actorUserId: ADMIN, actorTenantId: TENANT_A })
    h.grants.set('g-removed', {
      id: 'g-removed', identityId: idn.id, agentId: 'agent-removed', projectKey: '__general__',
      grantedById: ADMIN, grantedAt: new Date(), createdAt: new Date(),
    })
    h.addAgent('agent-removed', 'Elvett', TENANT_A, false)

    const view = await h.service.describeIdentityAgents(idn.id)
    assert.equal(view.channelEnabled, true)
    const map = new Map(view.agents.map((a) => [a.agentId, a.availability]))
    assert.equal(map.get('agent-ok'), 'available')
    assert.equal(map.get('agent-removed'), 'agent_removed')
  })

  // ── Kill-switch (D54) ───────────────────────────────────────────────────────

  await test('CA-6 kill-switch: elzárt szervezet → üres metszet és channel_disabled váltáskor (fail-closed)', async () => {
    const h = makeHarness()
    const idn = h.addIdentity()
    h.addAgent('agent-ok', 'Elérhető', TENANT_A, true)
    await h.service.grantAgent({ identityId: idn.id, agentId: 'agent-ok', actorUserId: ADMIN, actorTenantId: TENANT_A })

    // Kapcsoló BE: elérhető
    let available = await h.service.resolveAvailableAgents(idn.id)
    assert.deepEqual(available.map((a) => a.agentId), ['agent-ok'])

    // Kapcsoló KI (kill-switch): azonnal fail-closed minden úton
    h.killSwitch.set(TENANT_A, true)
    available = await h.service.resolveAvailableAgents(idn.id)
    assert.deepEqual(available, [])
    const view = await h.service.describeIdentityAgents(idn.id)
    assert.equal(view.channelEnabled, false)
    const sel = await h.service.selectAgent({ identityId: idn.id, agentId: 'agent-ok' })
    assert.equal(sel.ok === false && sel.reason, 'channel_disabled')
  })

  await test('CA-7 fail-closed: inaktív (visszavont) kötés → csatorna zárva, üres metszet', async () => {
    const h = makeHarness()
    const idn = h.addIdentity({ status: 'revoked' })
    h.grants.set('g1', {
      id: 'g1', identityId: idn.id, agentId: 'agent-ok', projectKey: '__general__',
      grantedById: ADMIN, grantedAt: new Date(), createdAt: new Date(),
    })
    h.addAgent('agent-ok', 'Elérhető', TENANT_A, true)

    const view = await h.service.describeIdentityAgents(idn.id)
    assert.equal(view.channelEnabled, false)
    assert.deepEqual(await h.service.resolveAvailableAgents(idn.id), [])
  })

  // ── Projektkötés (D9/D33) ───────────────────────────────────────────────────

  await test('CA-8 projektkötés: a tulajdonos átállítja a projektet, a feloldás EZT a kulcsot adja', async () => {
    const h = makeHarness()
    const idn = h.addIdentity({ userId: USER_1 })
    h.addAgent('agent-ok', 'Elérhető', TENANT_A, true)
    await h.service.grantAgent({ identityId: idn.id, agentId: 'agent-ok', actorUserId: ADMIN, actorTenantId: TENANT_A })

    const set = await h.service.setProjectKey({
      identityId: idn.id, agentId: 'agent-ok', projectKey: 'penzugy-2026',
      actorUserId: USER_1, expectUserId: USER_1,
    })
    assert.equal(set.ok, true)
    assert.equal(set.ok && set.grant.projectKey, 'penzugy-2026')

    const available = await h.service.resolveAvailableAgents(idn.id)
    assert.equal(available[0].projectKey, 'penzugy-2026')
    assert.ok(h.actionsOf().includes('channel.agent.project_set'))
  })

  await test('CA-9 projektkötés fail-closed: idegen felhasználó / hibás kulcs / nem engedélyezett agent', async () => {
    const h = makeHarness()
    const idn = h.addIdentity({ userId: USER_1 })
    h.addAgent('agent-ok', 'Elérhető', TENANT_A, true)
    await h.service.grantAgent({ identityId: idn.id, agentId: 'agent-ok', actorUserId: ADMIN, actorTenantId: TENANT_A })

    const notOwner = await h.service.setProjectKey({
      identityId: idn.id, agentId: 'agent-ok', projectKey: 'x',
      actorUserId: USER_2, expectUserId: USER_2,
    })
    assert.equal(notOwner.ok === false && notOwner.reason, 'not_owner')

    const badKey = await h.service.setProjectKey({
      identityId: idn.id, agentId: 'agent-ok', projectKey: 'nem jó kulcs',
      actorUserId: USER_1, expectUserId: USER_1,
    })
    assert.equal(badKey.ok === false && badKey.reason, 'invalid_project_key')

    const noGrant = await h.service.setProjectKey({
      identityId: idn.id, agentId: 'agent-nincs', projectKey: 'ok',
      actorUserId: USER_1, expectUserId: USER_1,
    })
    assert.equal(noGrant.ok === false && noGrant.reason, 'not_found')

    // A grant projektje végig a gyűjtő maradt.
    const available = await h.service.resolveAvailableAgents(idn.id)
    assert.equal(available[0].projectKey, '__general__')
  })

  // ── Visszavonás ─────────────────────────────────────────────────────────────

  await test('CA-10 visszavonás: az engedély eltűnik, az agent már nem választható, audit revoked', async () => {
    const h = makeHarness()
    const idn = h.addIdentity()
    h.addAgent('agent-ok', 'Elérhető', TENANT_A, true)
    await h.service.grantAgent({ identityId: idn.id, agentId: 'agent-ok', actorUserId: ADMIN, actorTenantId: TENANT_A })

    const rev = await h.service.revokeAgent({ identityId: idn.id, agentId: 'agent-ok', actorUserId: ADMIN, actorTenantId: TENANT_A })
    assert.equal(rev.ok, true)
    assert.deepEqual(await h.service.resolveAvailableAgents(idn.id), [])
    const sel = await h.service.selectAgent({ identityId: idn.id, agentId: 'agent-ok' })
    assert.equal(sel.ok === false && sel.reason, 'not_granted')
    assert.ok(h.actionsOf().includes('channel.agent.revoked'))

    const again = await h.service.revokeAgent({ identityId: idn.id, agentId: 'agent-ok', actorUserId: ADMIN, actorTenantId: TENANT_A })
    assert.equal(again.ok === false && again.reason, 'not_found')
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt bukott.`)
    process.exit(1)
  }
  console.log('\nMinden csatorna-agent-hozzáférés teszt zöld.')
}

void main()
