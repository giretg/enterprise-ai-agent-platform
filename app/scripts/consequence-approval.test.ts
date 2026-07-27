/**
 * issue #97 — ConsequenceApprovalService egységtesztek (DB nélkül).
 * Futtatás: npm run test:consequence-approval
 */
import assert from 'node:assert/strict'
import type { ConsequenceApproval, ConsequenceApprovalStatus } from '@prisma/client'
import {
  ConsequenceApprovalService,
  CONSEQUENCE_APPROVAL_TTL_MS,
  CONSEQUENCE_APPROVAL_VISIBILITY_MS,
} from '../src/domain/tool-broker/consequence-approval-service'
import type { ToolBrokerInvokeInput } from '../src/domain/tool-broker/tool-broker-types'
import type { ToolBrokerService } from '../src/domain/tool-broker/tool-broker-service'
import type {
  AgentRepository,
  AuditRepository,
  ConsequenceApprovalRepository,
  ConversationRepository,
} from '../src/repositories/interfaces'

let failures = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : String(e)}`)
  }
}

function memoryRepo(): ConsequenceApprovalRepository & {
  rows: Map<string, ConsequenceApproval>
  /** A lista-lekérdezésnek átadott láthatósági vágópont (a szolgáltatás számolja). */
  lastCreatedAfter: { value: Date | null }
} {
  const rows = new Map<string, ConsequenceApproval>()
  const lastCreatedAfter: { value: Date | null } = { value: null }
  return {
    rows,
    lastCreatedAfter,
    async create(data) {
      const row: ConsequenceApproval = {
        id: `appr-${rows.size + 1}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      }
      rows.set(row.id, row)
      return row
    },
    async findById(id) {
      return rows.get(id) ?? null
    },
    async listPendingByConversation(conversationId, createdAfter) {
      lastCreatedAfter.value = createdAfter
      return [...rows.values()]
        .filter(
          (row) =>
            row.conversationId === conversationId &&
            row.status === 'pending' &&
            row.createdAt.getTime() > createdAfter.getTime(),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    },
    async casUpdateStatus(id, expectedStatus, patch) {
      const row = rows.get(id)
      if (!row || row.status !== expectedStatus) return null
      const next: ConsequenceApproval = {
        ...row,
        status: patch.status,
        approvedBy: patch.approvedBy !== undefined ? patch.approvedBy : row.approvedBy,
        approvedAt: patch.approvedAt !== undefined ? patch.approvedAt : row.approvedAt,
        rejectedBy: patch.rejectedBy !== undefined ? patch.rejectedBy : row.rejectedBy,
        rejectedAt: patch.rejectedAt !== undefined ? patch.rejectedAt : row.rejectedAt,
        resultMeta:
          patch.resultMeta !== undefined
            ? (patch.resultMeta as ConsequenceApproval['resultMeta'])
            : row.resultMeta,
        blockedToolCallId:
          patch.blockedToolCallId !== undefined ? patch.blockedToolCallId : row.blockedToolCallId,
        updatedAt: new Date(),
      }
      rows.set(id, next)
      return next
    },
  }
}

function fakeBroker(
  invoked: ToolBrokerInvokeInput[],
  opts?: { failTimes?: number; denyTimes?: number },
) {
  let failLeft = opts?.failTimes ?? 0
  let denyLeft = opts?.denyTimes ?? 0
  return {
    invoke: async (input: ToolBrokerInvokeInput) => {
      invoked.push(input)
      if (failLeft > 0) {
        failLeft -= 1
        throw new Error('broker_boom')
      }
      if (denyLeft > 0) {
        denyLeft -= 1
        return {
          denied: true,
          reason: 'policy_denied',
          trust: 'trusted' as const,
          result: null,
          resultMeta: {},
          latencyMs: 1,
        }
      }
      return {
        denied: false,
        trust: 'trusted' as const,
        result: { path: (input.args as { path?: string }).path ?? 'ok.xlsx' },
        resultMeta: {},
        latencyMs: 1,
      }
    },
  } as unknown as ToolBrokerService
}

function buildService(opts?: {
  invoked?: ToolBrokerInvokeInput[]
  /** A beszélgetés tulajdonos-tenantja (a tenant-határ teszteléséhez). */
  conversationTenantId?: string | null
  /** Az agent tenantja; `null` = platform-szintű, minden tenantból elérhető. */
  agentTenantId?: string | null
  failTimes?: number
  denyTimes?: number
}) {
  const repo = memoryRepo()
  const invoked = opts?.invoked ?? []
  const audits: Array<{ action: string }> = []
  // FIGYELEM: itt NEM használható `??` — a `null` ÉRVÉNYES érték (platform-szintű agent,
  // ill. platform-szintű beszélgetés), a `??` viszont visszaejtené az alapértelmezésre,
  // és a legveszélyesebb eset sosem állna elő a tesztben.
  const agentTenantId = opts?.agentTenantId === undefined ? 'tenant-1' : opts.agentTenantId
  const conversationTenantId =
    opts?.conversationTenantId === undefined ? 'tenant-1' : opts.conversationTenantId
  const service = new ConsequenceApprovalService(
    repo,
    {
      // A tenant-szűkített keresés a VALÓDI repository szemantikáját utánozza
      // (`row.tenantId !== tenantId → null`), hogy a tenant-határ tesztelhető legyen.
      findByIdForTenant: async (_id: string, tenantId: string | null) =>
        tenantId === conversationTenantId
          ? ({
              id: 'conv-1',
              tenantId: conversationTenantId,
              createdById: 'user-1',
              agentId: 'agent-1',
            } as never)
          : null,
    } as unknown as ConversationRepository,
    {
      findById: async () => ({ id: 'agent-1', tenantId: agentTenantId }) as never,
    } as unknown as AgentRepository,
    {
      append: async (data: { action: string }) => {
        audits.push(data)
        return {} as never
      },
    } as unknown as AuditRepository,
    fakeBroker(invoked, { failTimes: opts?.failTimes, denyTimes: opts?.denyTimes }),
  )
  return { service, repo, invoked, audits }
}

const actor = { id: 'user-1', tenantId: 'tenant-1', role: 'operator' as const }

const baseInvoke = {
  agentId: 'agent-1',
  agentVersion: 1,
  conversationId: 'conv-1',
  actingUserId: 'user-1',
  tool: 'xlsx_create' as const,
  args: { path: 'out.xlsx', sheets: [{ name: 'S', rows: [['a']] }] },
} as ToolBrokerInvokeInput

async function main() {
  console.log('=== consequence-approval service (issue #97) ===')

  await test('createFromBlocked: pending rekord teljes args-szal', async () => {
    const { service, repo, audits } = buildService()
    const card = await service.createFromBlocked({ invoke: baseInvoke, tenantId: 'tenant-1' })
    assert.equal(card.toolName, 'xlsx_create')
    assert.ok(card.approvalId)
    const row = repo.rows.get(card.approvalId)!
    assert.equal(row.status, 'pending')
    assert.deepEqual(row.args, baseInvoke.args)
    assert.ok(row.expiresAt.getTime() > Date.now())
    assert.ok(row.expiresAt.getTime() <= Date.now() + CONSEQUENCE_APPROVAL_TTL_MS + 1000)
    assert.equal(audits.some((a) => a.action === 'consequence.approval.pending'), true)
  })

  await test('approve: egyszer lefuttatja a toolt a brokeren', async () => {
    const invoked: ToolBrokerInvokeInput[] = []
    const { service } = buildService({ invoked })
    const card = await service.createFromBlocked({ invoke: baseInvoke, tenantId: 'tenant-1' })
    const result = await service.approve(card.approvalId, actor)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.outcome, 'approved')
    assert.equal(invoked.length, 1)
    assert.equal(invoked[0].tool, 'xlsx_create')
    assert.deepEqual(invoked[0].args, baseInvoke.args)
  })

  await test('approve CAS: második approve nem hív újra invoke-ot', async () => {
    const invoked: ToolBrokerInvokeInput[] = []
    const { service } = buildService({ invoked })
    const card = await service.createFromBlocked({ invoke: baseInvoke, tenantId: 'tenant-1' })
    await service.approve(card.approvalId, actor)
    const second = await service.approve(card.approvalId, actor)
    assert.equal(second.ok, true)
    assert.equal(invoked.length, 1, 'csak egyszer futott le')
  })

  await test('approve invoke exception: hibát ad, resultMeta megmarad, Újrapróbálom újrafuttat', async () => {
    const invoked: ToolBrokerInvokeInput[] = []
    const { service, repo } = buildService({ invoked, failTimes: 1 })
    const card = await service.createFromBlocked({ invoke: baseInvoke, tenantId: 'tenant-1' })
    const first = await service.approve(card.approvalId, actor)
    assert.equal(first.ok, false)
    if (!first.ok) assert.equal(first.reason, 'broker_boom')
    assert.equal(repo.rows.get(card.approvalId)!.status, 'approved')
    const meta = repo.rows.get(card.approvalId)!.resultMeta as { denied?: boolean; failed?: boolean }
    assert.equal(meta.denied, true)
    assert.equal(meta.failed, true)
    assert.equal(invoked.length, 1)

    const retry = await service.approve(card.approvalId, actor)
    assert.equal(retry.ok, true, 'a második próbálkozásnak sikerülnie kell')
    assert.equal(invoked.length, 2, 'Újrapróbálom ténylegesen újra hívja a brokert')
  })

  await test('approve deny: hiba + Újrapróbálom újrafuttat', async () => {
    const invoked: ToolBrokerInvokeInput[] = []
    const { service } = buildService({ invoked, denyTimes: 1 })
    const card = await service.createFromBlocked({ invoke: baseInvoke, tenantId: 'tenant-1' })
    const first = await service.approve(card.approvalId, actor)
    assert.equal(first.ok, false)
    if (!first.ok) assert.equal(first.reason, 'policy_denied')
    const retry = await service.approve(card.approvalId, actor)
    assert.equal(retry.ok, true)
    assert.equal(invoked.length, 2)
  })

  await test('reject: nem hív invoke-ot', async () => {
    const invoked: ToolBrokerInvokeInput[] = []
    const { service, audits } = buildService({ invoked })
    const card = await service.createFromBlocked({ invoke: baseInvoke, tenantId: 'tenant-1' })
    const result = await service.reject(card.approvalId, actor)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.outcome, 'rejected')
    assert.equal(invoked.length, 0)
    assert.equal(audits.some((a) => a.action === 'consequence.approval.rejected'), true)
  })

  await test('lejárat: expired pending nem approve-olható', async () => {
    const { service, repo } = buildService()
    const card = await service.createFromBlocked({ invoke: baseInvoke, tenantId: 'tenant-1' })
    const row = repo.rows.get(card.approvalId)!
    row.expiresAt = new Date(Date.now() - 1000)
    const result = await service.approve(card.approvalId, actor)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'approval_expired')
    assert.equal(repo.rows.get(card.approvalId)!.status, 'expired' satisfies ConsequenceApprovalStatus)
  })

  // TENANT-HATÁR — a legveszélyesebb konfiguráció: PLATFORM-SZINTŰ agent (tenantId === null),
  // ami minden tenantból elérhető. Ha a kapu csak az agent-elérhetőséget nézné, egy idegen
  // szervezet operátora jóváhagyhatná — és a jóváhagyás szerveroldalon LE IS FUTTATNÁ a
  // mellékhatásos toolt a másik szervezet beszélgetésének kontextusával.
  await test('tenant-határ: idegen tenant operátora NEM hagyhat jóvá (platform-szintű agent mellett sem)', async () => {
    const { service, invoked } = buildService({
      conversationTenantId: 'tenant-1',
      agentTenantId: null,
    })
    const card = await service.createFromBlocked({ invoke: baseInvoke, tenantId: 'tenant-1' })
    const foreign = { id: 'user-9', tenantId: 'tenant-2', role: 'operator' as const }
    const result = await service.approve(card.approvalId, foreign)
    assert.equal(result.ok, false)
    // A tenant-eltérés „nincs ilyen"-ként jelenik meg: a pending LÉTEZÉSE sem szivárog.
    if (!result.ok) assert.equal(result.reason, 'conversation_not_found')
    assert.equal(invoked.length, 0, 'idegen tenant döntése SOHA nem futtathat toolt')
  })

  await test('tenant-határ: idegen tenant operátora NEM utasíthat el (nem tud állapotot rontani)', async () => {
    const { service, repo } = buildService({
      conversationTenantId: 'tenant-1',
      agentTenantId: null,
    })
    const card = await service.createFromBlocked({ invoke: baseInvoke, tenantId: 'tenant-1' })
    const foreign = { id: 'user-9', tenantId: 'tenant-2', role: 'admin' as const }
    const result = await service.reject(card.approvalId, foreign)
    assert.equal(result.ok, false)
    assert.equal(
      repo.rows.get(card.approvalId)!.status,
      'pending' satisfies ConsequenceApprovalStatus,
      'a pending érintetlen marad',
    )
  })

  await test('tenant-határ: a SAJÁT tenant operátora továbbra is dönthet (nem tört el a jó út)', async () => {
    const { service, invoked } = buildService({
      conversationTenantId: 'tenant-1',
      agentTenantId: null,
    })
    const card = await service.createFromBlocked({ invoke: baseInvoke, tenantId: 'tenant-1' })
    const result = await service.approve(card.approvalId, actor)
    assert.equal(result.ok, true)
    assert.equal(invoked.length, 1)
  })

  // ÚJRATÖLTÉS — a kapu üzleti értéke a GOMB. Ha az csak a stream élő pillanatában
  // létezik, a forduló végén / lapfrissítéskor eltűnik, a művelet pedig némán lejár:
  // a felhasználó számára az agent „hazudott", és a munka megáll.
  await test('listOpenForConversation: a függő jóváhagyás újratöltéskor is visszajön', async () => {
    const { service } = buildService()
    const card = await service.createFromBlocked({ invoke: baseInvoke, tenantId: 'tenant-1' })
    const open = await service.listOpenForConversation('conv-1', actor)
    assert.equal(open.length, 1)
    assert.equal(open[0].approvalId, card.approvalId)
    assert.equal(open[0].toolName, 'xlsx_create')
    assert.equal(open[0].summary, 'xlsx_create → out.xlsx')
    assert.equal(open[0].expired, false)
  })

  await test('listOpenForConversation: a lejárt sor NEM tűnik el némán (expired jelöléssel jön)', async () => {
    const { service, repo } = buildService()
    const card = await service.createFromBlocked({ invoke: baseInvoke, tenantId: 'tenant-1' })
    repo.rows.get(card.approvalId)!.expiresAt = new Date(Date.now() - 1000)
    const open = await service.listOpenForConversation('conv-1', actor)
    assert.equal(open.length, 1)
    assert.equal(open[0].expired, true, 'a UI ebből tudja, hogy magyarázatot kell mutatnia gomb helyett')
  })

  await test('listOpenForConversation: a láthatósági ablak a szerver órájából számolódik', async () => {
    const { service, repo } = buildService()
    await service.createFromBlocked({ invoke: baseInvoke, tenantId: 'tenant-1' })
    const before = Date.now()
    await service.listOpenForConversation('conv-1', actor)
    const cutoff = repo.lastCreatedAfter.value
    assert.ok(cutoff, 'a repository kapott vágópontot')
    const delta = before - cutoff!.getTime()
    assert.ok(
      Math.abs(delta - CONSEQUENCE_APPROVAL_VISIBILITY_MS) < 5000,
      `a vágópont ~${CONSEQUENCE_APPROVAL_VISIBILITY_MS} ms, kapott: ${delta}`,
    )
  })

  await test('listOpenForConversation: az eldöntött jóváhagyás már nem jelenik meg', async () => {
    const { service } = buildService()
    const card = await service.createFromBlocked({ invoke: baseInvoke, tenantId: 'tenant-1' })
    await service.approve(card.approvalId, actor)
    const open = await service.listOpenForConversation('conv-1', actor)
    assert.equal(open.length, 0)
  })

  // TENANT-HATÁR a LISTÁN is: a döntés kapuja hiába szigorú, ha a lista kiszivárogtatja,
  // MILYEN mellékhatás vár jóváhagyásra egy másik szervezet beszélgetésében.
  await test('tenant-határ: idegen tenant NEM látja a függő jóváhagyást (platform-szintű agent mellett sem)', async () => {
    const { service } = buildService({ conversationTenantId: 'tenant-1', agentTenantId: null })
    await service.createFromBlocked({ invoke: baseInvoke, tenantId: 'tenant-1' })
    const foreign = { id: 'user-9', tenantId: 'tenant-2', role: 'admin' as const }
    const open = await service.listOpenForConversation('conv-1', foreign)
    assert.deepEqual(open, [], 'a pending LÉTEZÉSE sem szivároghat ki')
  })

  await test('listOpenForConversation: viewer-jogú idegen felhasználó sem lát bele', async () => {
    const { service } = buildService()
    await service.createFromBlocked({ invoke: baseInvoke, tenantId: 'tenant-1' })
    // Saját tenant, de nem a beszélgetés létrehozója és nem operator+.
    const viewer = { id: 'user-7', tenantId: 'tenant-1', role: 'viewer' as const }
    const open = await service.listOpenForConversation('conv-1', viewer)
    assert.deepEqual(open, [])
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld.')
}

void main()
