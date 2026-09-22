/**
 * Provisioning — GOVERNANCE regressziós teszt (négy-szem + connector-agent tenant-határ).
 *
 * Kontextus két lelet köré:
 *
 *  A) Négy-szem (dual-control) MEGKERÜLHETŐSÉG. Banki-preset vagy L2–L3 connector
 *     aktiválásnál/leszerelésnél a `ProvisioningService` a második jóváhagyóra (`approverId`)
 *     KIZÁRÓLAG annyit követelt meg, hogy KÜLÖNBÖZZÖN az aktivátortól — sehol nem
 *     ellenőrizte, hogy a jóváhagyó valós, AKTÍV, azonos-tenant admin. Így egyetlen admin
 *     tetszőleges (akár nem létező) UUID-vel kielégítette a kaput → a banki connectorokra
 *     kötelező kettős kontroll semmit nem ért.
 *
 *  B) A connector-agent kötés (assign/unassign) TENANT-HATÁRA a service-ben nem volt
 *     defense-in-depth: a cél-agentet a service nem vetette össze az aktor tenantjával,
 *     az `unassign` pedig semmilyen tenant-ellenőrzést nem végzett.
 *
 * A deny-utak DB nélkül futnak: a guardok minden repo-érintés ELŐTT dobnak, ezért
 * in-memory fake repókkal determinisztikusak.
 *
 * Futtatás: npx tsx scripts/provisioning-governance.test.ts
 */
import assert from 'node:assert/strict'
import {
  ProvisioningService,
  type ProvisioningActor,
  type ProvisioningDeps,
} from '../src/domain/provisioning/provisioning-service'
import { ProvisioningError } from '../src/domain/provisioning/errors'
import type { AuditRepository, ConnectorDraftRepository } from '../src/repositories/interfaces'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function expectCode(code: string, fn: () => Promise<unknown>) {
  try {
    await fn()
    assert.fail(`elvárt ProvisioningError(${code}), de a hívás sikeres volt`)
  } catch (e) {
    assert.ok(e instanceof ProvisioningError, `nem ProvisioningError: ${String(e)}`)
    assert.equal(e.code, code, `elvárt ${code}, kapott ${e.code}`)
  }
}

const TENANT_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const TENANT_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const ADMIN_A = 'eeeeeeee-0000-4000-8000-00000000000a' // az aktor (A tenant admin)
const APPROVER_A = 'eeeeeeee-0000-4000-8000-00000000000b' // valid második jóváhagyó (A admin)
const OUTSIDER = 'ffffffff-0000-4000-8000-00000000000f' // nem admin / idegen
const CONNECTOR_A = 'c0c0c0c0-0000-4000-8000-00000000000a'
const AGENT_A = 'a9a9a9a9-0000-4000-8000-00000000000a'
const AGENT_B = 'b9b9b9b9-0000-4000-8000-00000000000b'

const actorA: ProvisioningActor = { type: 'user', userId: ADMIN_A, role: 'admin', tenantId: TENANT_A }
const superadminA: ProvisioningActor = {
  ...actorA,
  canManagePlatformConnectors: true,
}

/** Aktív, tenant-A connector; `secretAlias: null` → a leszerelés nem nyúl a secret-store-hoz. */
function connectorRow(tenantId: string | null) {
  return {
    id: CONNECTOR_A,
    tenantId,
    lifecycleState: 'active',
    secretAlias: null,
    connectorMode: 'fixed' as const,
    activeCapabilitySet: null,
  }
}

/** Csak a teszt-utak által hívott repo-metódusokat valósítjuk meg. */
function fakeDrafts(overrides: Partial<ConnectorDraftRepository> = {}): ConnectorDraftRepository {
  return {
    findConnectorById: async () => connectorRow(TENANT_A),
    decommissionByConnectorId: async ({ connectorId }: { connectorId: string }) => ({
      connectorId,
      affectedAgentIds: [],
    }),
    assignToAgent: async () => {},
    unassignFromAgent: async () => ({ removed: true }),
    isAssignableToAgent: async () => true,
    ...overrides,
  } as unknown as ConnectorDraftRepository
}

const noopAudit = { append: async () => {} } as unknown as AuditRepository

function makeService(deps: Partial<ProvisioningDeps> = {}): ProvisioningService {
  return new ProvisioningService({
    drafts: fakeDrafts(),
    audit: noopAudit,
    resolveEgressAllowlist: async () => [],
    resolveBankPreset: async () => false,
    // Alapból: APPROVER_A az egyetlen aktív A-admin jóváhagyó.
    verifyDualControlApprover: async ({ approverId, tenantId }) =>
      tenantId === TENANT_A && approverId === APPROVER_A,
    // Alapból: AGENT_A az A tenantban, AGENT_B a B-ben.
    resolveAgentTenantId: async (agentId) => {
      if (agentId === AGENT_A) return { found: true, tenantId: TENANT_A }
      if (agentId === AGENT_B) return { found: true, tenantId: TENANT_B }
      return { found: false, tenantId: null }
    },
    ...deps,
  })
}

async function main() {
  console.log('Provisioning governance — négy-szem + tenant-határ:')

  // ── A) Dual-control jóváhagyó-hitelesítés (decommissionActiveConnector, L2) ──

  await test('G1 L2 + jogosulatlan jóváhagyó (nem admin) → APPROVER_NOT_AUTHORIZED', async () => {
    const svc = makeService()
    await expectCode('APPROVER_NOT_AUTHORIZED', () =>
      svc.decommissionActiveConnector(
        { connectorId: CONNECTOR_A, criticality: 'L2', approverId: OUTSIDER },
        actorA,
      ),
    )
  })

  await test('G2 L2 + valós, különböző A-admin jóváhagyó → archived', async () => {
    const svc = makeService()
    const res = await svc.decommissionActiveConnector(
      { connectorId: CONNECTOR_A, criticality: 'L2', approverId: APPROVER_A },
      actorA,
    )
    assert.equal(res.lifecycleState, 'archived')
  })

  await test('G3 L2 + jóváhagyó === aktor → APPROVAL_SAME_ACTOR (a hitelesítés előtt)', async () => {
    const svc = makeService()
    await expectCode('APPROVAL_SAME_ACTOR', () =>
      svc.decommissionActiveConnector(
        { connectorId: CONNECTOR_A, criticality: 'L2', approverId: ADMIN_A },
        actorA,
      ),
    )
  })

  await test('G4 L2 + a hitelesítő nincs bekötve → DUAL_CONTROL_NOT_CONFIGURED (fail-closed)', async () => {
    const svc = makeService({ verifyDualControlApprover: undefined })
    await expectCode('DUAL_CONTROL_NOT_CONFIGURED', () =>
      svc.decommissionActiveConnector(
        { connectorId: CONNECTOR_A, criticality: 'L2', approverId: APPROVER_A },
        actorA,
      ),
    )
  })

  await test('G5 L1 (nincs dual-control) → jóváhagyó nélkül is archived', async () => {
    const svc = makeService()
    const res = await svc.decommissionActiveConnector(
      { connectorId: CONNECTOR_A, criticality: 'L1' },
      actorA,
    )
    assert.equal(res.lifecycleState, 'archived')
  })

  await test('G6 banki-preset → L1 is dual-control, jogosulatlan jóváhagyó tilt', async () => {
    const svc = makeService({ resolveBankPreset: async () => true })
    await expectCode('APPROVER_NOT_AUTHORIZED', () =>
      svc.decommissionActiveConnector(
        { connectorId: CONNECTOR_A, criticality: 'L1', approverId: OUTSIDER },
        actorA,
      ),
    )
  })

  await test('G6a tenant-admin globális connectort nem szerelhet le', async () => {
    const svc = makeService({
      drafts: fakeDrafts({ findConnectorById: async () => connectorRow(null) }),
    })
    await expectCode('PLATFORM_CONNECTOR_FORBIDDEN', () =>
      svc.decommissionActiveConnector({ connectorId: CONNECTOR_A }, actorA),
    )
  })

  await test('G6b superadmin globális connectort leszerelhet', async () => {
    const svc = makeService({
      drafts: fakeDrafts({ findConnectorById: async () => connectorRow(null) }),
    })
    const res = await svc.decommissionActiveConnector(
      { connectorId: CONNECTOR_A },
      superadminA,
    )
    assert.equal(res.lifecycleState, 'archived')
  })

  // ── B) Connector-agent kötés tenant-határa ──────────────────────────────────

  await test('G7 assign idegen-tenant (B) agentre → AGENT_NOT_IN_TENANT', async () => {
    const svc = makeService()
    await expectCode('AGENT_NOT_IN_TENANT', () =>
      svc.assignConnectorToAgent(
        { connectorId: CONNECTOR_A, agentId: AGENT_B, accessMode: 'read' },
        actorA,
      ),
    )
  })

  await test('G8 assign saját (A) agentre → sikeres', async () => {
    const svc = makeService()
    const res = await svc.assignConnectorToAgent(
      { connectorId: CONNECTOR_A, agentId: AGENT_A, accessMode: 'read' },
      actorA,
    )
    assert.equal(res.agentId, AGENT_A)
  })

  await test('G9 unassign idegen-tenant connectorról → CONNECTOR_NOT_FOUND_OR_FORBIDDEN', async () => {
    const svc = makeService({
      drafts: fakeDrafts({ findConnectorById: async () => connectorRow(TENANT_B) }),
    })
    await expectCode('CONNECTOR_NOT_FOUND_OR_FORBIDDEN', () =>
      svc.unassignConnectorFromAgent({ connectorId: CONNECTOR_A, agentId: AGENT_A }, actorA),
    )
  })

  await test('G10 unassign idegen-tenant (B) agentről → AGENT_NOT_IN_TENANT', async () => {
    const svc = makeService()
    await expectCode('AGENT_NOT_IN_TENANT', () =>
      svc.unassignConnectorFromAgent({ connectorId: CONNECTOR_A, agentId: AGENT_B }, actorA),
    )
  })

  await test('G11 unassign saját connector + saját agent → removed', async () => {
    const svc = makeService()
    const res = await svc.unassignConnectorFromAgent(
      { connectorId: CONNECTOR_A, agentId: AGENT_A },
      actorA,
    )
    assert.equal(res.removed, true)
  })

  console.log(failures === 0 ? '\n✅ MIND ZÖLD' : `\n❌ ${failures} teszt bukott`)
  if (failures > 0) process.exitCode = 1
}

void main()
