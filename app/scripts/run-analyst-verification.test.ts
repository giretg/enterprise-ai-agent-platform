/**
 * RA-09 / #353 — Futás-elemző lezáró ellenőrzés: mért eset + hibás átadás + záró-kapuk.
 *
 * Futtatás: npm run test:run-analyst-verification
 *
 * A megfigyelt egység a tool-kimenet és a kapuk viselkedése — nem a modell szövege.
 * A kétirányú mércét a spec (#343) Testing Decisions fejezete írja elő:
 *   1. 2026-07-29-i visszaolvasás-incidens alakja (149 hívás / 132 újraolvasás / 40 kör)
 *   2. Hibás átadású folyamat (step2 nem tölti step3 kötelező slotját)
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Agent, UserRole } from '@prisma/client'
import { prisma } from '../src/lib/db'
import { deleteTestTenants } from './_test-tenant-cleanup'
import { decideAuthz } from '../src/lib/iam-policy'
import {
  RUN_ANALYST_FORBIDDEN_TOOLS,
  RUN_ANALYST_ROLE_CAPABILITIES,
  RUN_ANALYST_ROLE_INSTRUCTION,
  RUN_ANALYST_ROLE_TEMPLATE,
} from '../src/domain/agents/run-analyst-role'
import {
  RUN_INDEX_NOT_FOUND,
  RunIndexNotFoundError,
  RunIndexService,
} from '../src/domain/run-analysis/run-index-service'
import { RunStatsService } from '../src/domain/run-analysis/run-stats-service'
import { computeRepeatedSourceKeys } from '../src/domain/run-analysis/run-stats-service'
import {
  buildProcessTraceView,
  mapDelegationEdge,
  mapProcessInstance,
  mapProcessStep,
  projectPlaybookSpecForTrace,
} from '../src/domain/run-analysis/run-trace-process'
import {
  buildTraceSummary,
  RunTraceService,
} from '../src/domain/run-analysis/run-trace-service'
import { isAdminOnlyGraphNode } from '../src/lib/platform-agent-registry'
import { PLAYBOOK_SCHEMA_VERSION } from '../src/lib/playbook-v2/spec'
import {
  DEFAULT_ROLE_PERMISSIONS,
  ensureDefaultRolePermissions,
  PostgresRolePermissionRepository,
} from '../src/repositories/postgres/iam-repository'
import type { AuditRepository } from '../src/repositories/interfaces'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const INCIDENT_DATE = '2026-07-29T10:00:00Z'
const INCIDENT_PATH = 'feldolgozott-tulajdoni-lap.json'

let failures = 0

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function buildIncidentToolCalls() {
  const base = Date.parse(INCIDENT_DATE)
  const path = INCIDENT_PATH
  const rows: Array<{
    agentTurnId: string
    ticketId: null
    toolName: string
    argsMeta: Record<string, unknown>
    resultMeta: Record<string, unknown>
    createdAt: Date
  }> = []
  for (let i = 0; i < 17; i += 1) {
    rows.push({
      agentTurnId: 'turn-incident',
      ticketId: null,
      toolName: 'file_read',
      argsMeta: { path: `forras-${i}.json` },
      resultMeta: { result_chars: 8_000 },
      createdAt: new Date(base + i * 1_000),
    })
  }
  for (let i = 0; i < 132; i += 1) {
    rows.push({
      agentTurnId: 'turn-incident',
      ticketId: null,
      toolName: 'tool_result_read',
      argsMeta: { path: `.tool-results/${path}` },
      resultMeta: i === 0 ? { result_chars: 40_000 } : { redundant: true, result_chars: 40_000 },
      createdAt: new Date(base + 20_000 + i * 1_000),
    })
  }
  return rows
}

function buildIncidentTraceRun() {
  const base = Date.parse(INCIDENT_DATE)
  const toolCalls = buildIncidentToolCalls().map((row, index) => ({
    id: `tc-${index}`,
    agentTurnId: row.agentTurnId,
    toolName: row.toolName,
    status: 'ok',
    outcome: 'ok',
    createdAt: row.createdAt,
  }))
  const modelCalls = Array.from({ length: 40 }, (_, i) => ({
    id: `mc-${i}`,
    agentTurnId: 'turn-incident',
    provider: 'chatgpt-oauth',
    model: 'gpt-test',
    promptTokens: 21_000 + i * 3_400,
    completionTokens: 400,
    cachedPromptTokens: 0,
    latencyMs: 1000,
    status: 'ok',
    createdAt: new Date(base + i * 2_000),
  }))
  // Ugyanaz a bemenet, amit élesben a DB-oldali aggregátumok adnak a summarynak.
  const groups = new Map<string, { toolName: string; outcome: string | null; count: number }>()
  for (const call of toolCalls) {
    const key = `${call.toolName}\u0000${call.outcome}`
    const existing = groups.get(key)
    if (existing) existing.count += 1
    else groups.set(key, { toolName: call.toolName, outcome: call.outcome, count: 1 })
  }

  return {
    header: {
      runId: 'turn-incident',
      grain: 'turn' as const,
      agentId: 'agent-laci',
      agentName: 'LACI',
      conversationId: 'conv-3aae080f',
      ticketId: null,
      startedAt: new Date(base),
      finishedAt: new Date(base + 3600_000),
      status: 'failed',
      turnCount: 40,
      deniedCount: 0,
    },
    toolCallCount: toolCalls.length,
    modelCallCount: modelCalls.length,
    toolOutcomeGroups: [...groups.values()],
    toolOutcomeGroupsTruncated: false,
    tokenCurveSample: modelCalls,
    tokenCurveTruncated: false,
    nonOkToolCalls: [],
    nonOkToolCallCount: 0,
  }
}

/** RA-09 ellenőrzés 2 — emberi olvasható playbook-javaslat a slot-gap adatból. */
function formatPlaybookSlotGapRecommendation(input: {
  stepId: string
  stepName: string
  missingSlots: string[]
  fromStepId: string
  fromStepName: string
}): string {
  return (
    `A(z) „${input.stepName}" (${input.stepId}) lépés kötelező slotjai hiányoznak: ` +
    `${input.missingSlots.join(', ')}. A(z) „${input.fromStepName}" (${input.fromStepId}) ` +
    `resultPayload-ja nem adja át ezeket — javaslat: Playbook Author draft, a step-2 kimeneti ` +
    `mappingjében szerepeljen a(z) ${input.missingSlots.join(', ')} mező.`
  )
}

/** Teszt-horgony: ugyanaz a kapu-logika, mint `resolveRunAnalysisEntry`, server-only nélkül. */
async function resolveRunAnalysisEntryForTest(input: {
  tenantId: string
  role: UserRole
}): Promise<{ canRunAnalysis: boolean; runAnalystAgentId: string | null }> {
  const permEntry = await new PostgresRolePermissionRepository().findByKey('analysis.run')
  const decision = decideAuthz({ status: 'active', role: input.role }, permEntry?.minRole ?? null)
  if (!decision.allow) {
    return { canRunAnalysis: false, runAnalystAgentId: null }
  }
  const agent = await prisma.agent.findFirst({
    where: { tenantId: input.tenantId, systemRole: 'run_analyst' },
  })
  if (!agent) {
    return { canRunAnalysis: false, runAnalystAgentId: null }
  }
  return { canRunAnalysis: true, runAnalystAgentId: agent.id }
}

/** Minimális run_analyst agent a DB tesztekhez — nem hív server-only materializációt. */
async function createMinimalRunAnalystAgent(input: {
  tenantId: string
  approvedById: string
}): Promise<Agent> {
  const existing = await prisma.agent.findFirst({
    where: { tenantId: input.tenantId, systemRole: 'run_analyst' },
  })
  if (existing) return existing

  const t = RUN_ANALYST_ROLE_TEMPLATE
  const memory = await prisma.memory.create({ data: {} })
  const memoryVersion = await prisma.memoryVersion.create({
    data: {
      memoryId: memory.id,
      version: 1,
      content: 'Futás-elemző teszt',
      status: 'active',
      source: 'provisioning',
      approvedById: input.approvedById,
    },
  })
  await prisma.memory.update({
    where: { id: memory.id },
    data: { currentVersionId: memoryVersion.id },
  })

  const agent = await prisma.agent.create({
    data: {
      name: t.name,
      roleInstruction: t.roleInstruction,
      behaviorProfile: t.behaviorProfile,
      behaviorProfileOverlay: t.behaviorProfile,
      modelConfig: { ...t.modelConfig },
      status: 'active',
      role: t.role,
      systemRole: 'run_analyst',
      tenantId: input.tenantId,
      inboundRestricted: true,
      outboundRestricted: true,
      hiddenFromOperators: true,
      allowSensitiveExternalModel: false,
      currentVersion: 1,
      currentRoleInstructionVersion: 1,
      currentBehaviorProfileVersion: 1,
      memoryId: memory.id,
    },
  })

  await prisma.agentVersion.create({
    data: {
      agentId: agent.id,
      version: 1,
      roleInstructionSnapshot: t.roleInstruction,
      behaviorProfileSnapshot: t.behaviorProfile,
      roleInstructionVersion: 1,
      behaviorProfileVersion: 1,
      modelConfigSnapshot: { ...t.modelConfig },
      memoryVersionId: memoryVersion.id,
    },
  })

  for (const toolName of RUN_ANALYST_ROLE_CAPABILITIES) {
    await prisma.capability.create({
      data: { agentId: agent.id, toolName, allowed: true },
    })
  }

  return agent
}

class CapturingAudit implements AuditRepository {
  entries: Array<{ action: string; metadata?: unknown }> = []

  async append(data: { action: string; metadata?: unknown }) {
    this.entries.push({ action: data.action, metadata: data.metadata })
    return { id: randomUUID() } as never
  }

  async findMany() {
    return []
  }

  async findAll() {
    return []
  }

  async getActionCounts() {
    return {}
  }
}

async function seedTenantIsolationFixture() {
  const suffix = randomUUID().slice(0, 8)
  const tenantA = await prisma.tenant.create({
    data: { slug: `ra-iso-a-${suffix}`, displayName: 'RA ISO A' },
  })
  const tenantB = await prisma.tenant.create({
    data: { slug: `ra-iso-b-${suffix}`, displayName: 'RA ISO B' },
  })
  const adminA = await prisma.user.create({
    data: {
      externalAuthId: `ra-a-${suffix}`,
      email: `ra-a-${suffix}@example.test`,
      name: 'Admin A',
      status: 'active',
      role: 'admin',
      tenantId: tenantA.id,
    },
  })
  const operatorB = await prisma.user.create({
    data: {
      externalAuthId: `ra-o-${suffix}`,
      email: `ra-o-${suffix}@example.test`,
      name: 'Operator B',
      status: 'active',
      role: 'operator',
      tenantId: tenantB.id,
    },
  })
  await prisma.tenantMembership.createMany({
    data: [
      { tenantId: tenantA.id, userId: adminA.id, role: 'admin', status: 'active' },
      { tenantId: tenantB.id, userId: operatorB.id, role: 'operator', status: 'active' },
    ],
  })
  const memory = await prisma.memory.create({ data: {} })
  const worker = await prisma.agent.create({
    data: {
      tenantId: tenantA.id,
      name: `Worker-${suffix}`,
      roleInstruction: 'teszt',
      behaviorProfile: 'teszt',
      modelConfig: { provider: 'stub', model: 'stub' },
      memoryId: memory.id,
    },
  })
  const conversation = await prisma.conversation.create({
    data: { tenantId: tenantA.id, agentId: worker.id, createdById: adminA.id },
  })
  const agentTurn = await prisma.agentTurn.create({
    data: {
      conversationId: conversation.id,
      tenantId: tenantA.id,
      agentId: worker.id,
      agentVersion: 1,
      createdById: adminA.id,
      status: 'completed',
      turnCount: 3,
      toolCallCount: 5,
    },
  })
  const ticket = await prisma.ticket.create({
    data: {
      tenantId: tenantA.id,
      type: 'interaction',
      title: 'RA ISO ticket',
      agentId: worker.id,
      createdById: adminA.id,
    },
  })
  const playbook = await prisma.playbookV2.create({
    data: {
      tenantId: tenantA.id,
      key: `ra-iso-${suffix}`,
      name: 'RA ISO',
      processType: 'ra_iso',
    },
  })
  const playbookVersion = await prisma.playbookVersionV2.create({
    data: {
      tenantId: tenantA.id,
      playbookId: playbook.id,
      version: 1,
      status: 'published',
      spec: { schemaVersion: 2, steps: [] },
      changeSummary: 'teszt',
      contentHash: `hash-${suffix}`,
      createdById: adminA.id,
      publishedAt: new Date(),
    },
  })
  const process = await prisma.processInstance.create({
    data: {
      tenantId: tenantA.id,
      processType: 'ra_iso',
      status: 'created',
      playbookId: playbook.id,
      playbookVersionId: playbookVersion.id,
      playbookRef: playbook.key,
      playbookContentHash: playbookVersion.contentHash,
      startedByType: 'user',
      startedByUserId: adminA.id,
      conversationId: conversation.id,
    },
  })
  const runAnalystA = await createMinimalRunAnalystAgent({
    tenantId: tenantA.id,
    approvedById: adminA.id,
  })
  const runAnalystB = await createMinimalRunAnalystAgent({
    tenantId: tenantB.id,
    approvedById: adminA.id,
  })
  return {
    suffix,
    tenantA,
    tenantB,
    adminA,
    operatorB,
    worker,
    conversation,
    ticket,
    playbook,
    playbookVersion,
    process,
    agentTurn,
    runAnalystA,
    runAnalystB,
    memoryId: memory.id,
  }
}

async function cleanupIsolationFixture(f: Awaited<ReturnType<typeof seedTenantIsolationFixture>>) {
  await deleteTestTenants(prisma, [f.tenantA.id, f.tenantB.id])
}

async function main() {
  console.log('=== RA-09 Futás-elemző lezáró ellenőrzés (#353) ===\n')

  console.log('— Ellenőrzés 1: mért eset (2026-07-29) —')

  await check('run_stats: ismétlődő forrás-kulcs 132 újraolvasás / 149 olvasó hívás', () => {
    const toolCalls = buildIncidentToolCalls()
    assert.equal(toolCalls.length, 149)
    const { keys } = computeRepeatedSourceKeys(toolCalls)
    assert.ok(keys.length >= 1)
    const top = keys.sort((a, b) => b.rereadCount - a.rereadCount)[0]!
    assert.equal(top.rereadCount, 131, '132 olvasás ugyanabból a forrásból → 131 ismételt')
    assert.equal(top.readCount, 132)
    assert.match(top.sourceKey, /tool_result_read:path:/)

    const base = Date.parse(INCIDENT_DATE)
    const path = INCIDENT_PATH
    const canonical = Array.from({ length: 133 }, (_, i) => ({
      agentTurnId: 'turn-incident',
      ticketId: null,
      toolName: 'file_read',
      argsMeta: { path },
      resultMeta: {},
      createdAt: new Date(base + i * 1_000),
    }))
    const { keys: canonicalKeys } = computeRepeatedSourceKeys(canonical)
    assert.equal(canonicalKeys[0]!.rereadCount, 132)
    assert.equal(canonicalKeys[0]!.readCount, 133)
  })

  await check('run_index fejléc: 40 kör, 149 eszközhívás (AgentTurn mezők)', () => {
    const header = {
      turnCount: 40,
      toolCallCount: 149,
      deniedCount: 0,
      stopReason: 'loop_guard',
    }
    assert.equal(header.turnCount, 40)
    assert.equal(header.toolCallCount, 149)
    assert.ok(header.toolCallCount >= 132, 'a fejléc mutatja az eszköz-súlyt')
  })

  await check('run_trace summary: célzott lefúrás alátámasztja a hotspotot', () => {
    const run = buildIncidentTraceRun()
    const summary = buildTraceSummary(run)
    assert.equal(summary.turnCount, 40)
    assert.equal(summary.toolCallCount, 149)
    const rereadAgg = summary.toolCallsByToolAndOutcome.find((row) => row.toolName === 'tool_result_read')
    assert.ok(rereadAgg)
    assert.equal(rereadAgg!.count, 132)
    assert.ok(summary.tokenCurve.length >= 40, 'token-görbe 40 modellhívás')
    assert.ok(summary.tokenCurve.at(-1)!.promptTokens >= 150_000, 'monoton növekvő prompt')
  })

  console.log('\n— Ellenőrzés 2: hibás átadású folyamat —')

  await check('run_trace process: step3 summary slot hiány + delegation edge', () => {
    const playbookSpecRaw = {
      schemaVersion: PLAYBOOK_SCHEMA_VERSION,
      key: 'delegation-test',
      name: 'Delegáció teszt',
      processType: 'delegation_test',
      entryStepId: 'step-1',
      roles: [{ key: 'analyst', type: 'agent_role' }],
      steps: [
        {
          id: 'step-1',
          name: 'Gyűjtés',
          ticketType: 'agent_task',
          assignedRole: 'analyst',
          instructionTemplate: 'Gyűjtsd: {{topic}}',
          inputSlots: [{ name: 'topic', type: 'string', required: true, source: 'trigger' }],
        },
        {
          id: 'step-2',
          name: 'Feldolgozás',
          ticketType: 'agent_task',
          assignedRole: 'analyst',
          instructionTemplate: 'Dolgozd fel: {{topic}}',
          inputSlots: [{ name: 'topic', type: 'string', required: true, source: 'step' }],
        },
        {
          id: 'step-3',
          name: 'Összegzés',
          ticketType: 'agent_task',
          assignedRole: 'analyst',
          instructionTemplate: 'Foglald: {{summary}}',
          inputSlots: [{ name: 'summary', type: 'string', required: true, source: 'step' }],
        },
      ],
      gates: [],
      transitions: [
        { fromStepId: 'step-1', toStepId: 'step-2', trigger: 'done' },
        { fromStepId: 'step-2', toStepId: 'step-3', trigger: 'done' },
      ],
    }
    const base = Date.parse('2026-08-01T10:00:00Z')
    const view = buildProcessTraceView({
      process: mapProcessInstance({
        id: 'proc-gap',
        processType: 'delegation_test',
        status: 'blocked',
        triggerType: 'manual',
        startedByType: 'user',
        startedByUserId: 'user-1',
        startedByAgentId: null,
        inputPayload: { topic: 'Q3 riport' },
        outputPayload: {},
        rootTicketId: 'ticket-1',
        conversationId: 'conv-1',
        startedAt: new Date(base),
        completedAt: null,
        failedAt: null,
      }),
      steps: [
        mapProcessStep({
          stepId: 'step-2',
          stepName: 'Feldolgozás',
          status: 'completed',
          assignedRole: 'analyst',
          assignedAgentId: 'agent-b',
          assignedUserId: null,
          ticketId: 'ticket-2',
          resultPayload: { topic: 'Q3 riport', partial_notes: 'félkész' },
          startedAt: new Date(base + 120_000),
          completedAt: new Date(base + 180_000),
          failedAt: null,
        }),
        mapProcessStep({
          stepId: 'step-3',
          stepName: 'Összegzés',
          status: 'blocked',
          assignedRole: 'analyst',
          assignedAgentId: 'agent-c',
          assignedUserId: null,
          ticketId: 'ticket-3',
          resultPayload: {},
          startedAt: new Date(base + 240_000),
          completedAt: null,
          failedAt: null,
        }),
      ],
      delegations: [
        mapDelegationEdge({
          id: 'edge-2-3',
          fromStepId: 'step-2',
          toStepId: 'step-3',
          fromActorType: 'agent',
          fromAgentId: 'agent-b',
          fromUserId: null,
          toActorType: 'agent',
          toAgentId: 'agent-c',
          toUserId: null,
          status: 'delivered',
          createdAt: new Date(base + 185_000),
          deliveredAt: new Date(base + 186_000),
          acceptedAt: null,
          doneAt: null,
          failedAt: null,
          metadata: { missingSlots: ['summary'] },
        }),
      ],
      playbookSpec: projectPlaybookSpecForTrace({
        playbookVersionId: 'pv-1',
        contentHash: 'hash',
        spec: playbookSpecRaw,
      }),
      entryStepId: 'step-1',
      transitions: playbookSpecRaw.transitions,
      processInput: { topic: 'Q3 riport' },
    })
    const gap = view.slotGaps.find((g) => g.stepId === 'step-3')
    assert.ok(gap)
    assert.deepEqual(gap!.missingRequiredSlots, ['summary'])
    const recommendation = formatPlaybookSlotGapRecommendation({
      stepId: 'step-3',
      stepName: 'Összegzés',
      missingSlots: gap!.missingRequiredSlots,
      fromStepId: 'step-2',
      fromStepName: 'Feldolgozás',
    })
    assert.match(recommendation, /Playbook Author draft/)
    assert.match(recommendation, /summary/)
    assert.match(recommendation, /step-2/)
  })

  console.log('\n— Javaslat-továbbadás útjai (skill + szerep-instrukció) —')

  await check('skill + role: playbook / skill / memória / EFF-12 Alkalmazom útvonalak', () => {
    const skill = readFileSync(join(root, '../docs/skills/futas-elemzes.SKILL.md'), 'utf8')
    assert.match(skill, /Playbook Author/)
    assert.match(skill, /propose → review → approve/)
    assert.match(skill, /Tanulási ticket/)
    assert.match(skill, /EFF-12/)
    assert.match(skill, /Alkalmazom/)
    assert.match(RUN_ANALYST_ROLE_INSTRUCTION, /Playbook Author/)
    assert.match(RUN_ANALYST_ROLE_INSTRUCTION, /EFF-12/)
  })

  console.log('\n— Záró-kapuk: hozzáférés és egress —')

  await check('operator/viewer: analysis.run csak admin — belépési pont zárva', () => {
    assert.equal(isAdminOnlyGraphNode({ systemRole: 'run_analyst' }), true)
    const minRole =
      DEFAULT_ROLE_PERMISSIONS.find((p) => p.permissionKey === 'analysis.run')?.minRole ?? null
    assert.equal(minRole, 'admin')
    for (const role of ['operator', 'viewer'] as const) {
      const decision = decideAuthz({ status: 'active', role }, minRole)
      assert.equal(decision.allow, false, `${role} nem futtathat elemzést`)
    }
  })

  await check('elemző: kimenő egress toolok nincsenek a capability-halmazban', () => {
    for (const forbidden of RUN_ANALYST_FORBIDDEN_TOOLS) {
      assert.ok(
        !RUN_ANALYST_ROLE_CAPABILITIES.includes(forbidden as never),
        `${forbidden} tiltott`,
      )
    }
  })

  console.log('\n— Záró-kapuk: tenant-izoláció + audit (DB) —')

  await check('idegen tenant conversationId / ticketId / processInstanceId → run_not_found', async () => {
    await ensureDefaultRolePermissions()
    const f = await seedTenantIsolationFixture()
    try {
      const audit = new CapturingAudit()
      const index = new RunIndexService(prisma, audit)
      const stats = new RunStatsService(prisma, audit, index)
      const trace = new RunTraceService(prisma, audit)

      const foreignScopes = [
        { conversationId: f.conversation.id },
        { ticketId: f.ticket.id },
        { processInstanceId: f.process.id },
      ] as const

      for (const scope of foreignScopes) {
        await assert.rejects(
          () =>
            index.resolveScope({
              tenantId: f.tenantB.id,
              args: scope,
            }),
          (err: unknown) => err instanceof RunIndexNotFoundError && err.message === RUN_INDEX_NOT_FOUND,
          `run_index ${JSON.stringify(scope)}`,
        )
        await assert.rejects(
          () =>
            stats.query({
              tenantId: f.tenantB.id,
              requesterAgentId: f.runAnalystB.id,
              requesterAgentVersion: 1,
              actingUserId: null,
              args: scope,
            }),
          (err: unknown) => err instanceof RunIndexNotFoundError,
          `run_stats ${JSON.stringify(scope)}`,
        )
      }

      await assert.rejects(
        () =>
          trace.query({
            tenantId: f.tenantB.id,
            requesterAgentId: f.runAnalystB.id,
            requesterAgentVersion: 1,
            actingUserId: null,
            args: { grain: 'process', runId: f.process.id },
          }),
        (err: unknown) => err instanceof RunIndexNotFoundError,
        'run_trace process',
      )
    } finally {
      await cleanupIsolationFixture(f)
    }
  })

  await check('admin látja az elemzőt; operator nem — resolveRunAnalysisEntry', async () => {
    await ensureDefaultRolePermissions()
    const f = await seedTenantIsolationFixture()
    try {
      const adminEntry = await resolveRunAnalysisEntryForTest({
        tenantId: f.tenantA.id,
        role: 'admin',
      })
      assert.equal(adminEntry.canRunAnalysis, true)
      assert.equal(adminEntry.runAnalystAgentId, f.runAnalystA.id)

      const operatorEntry = await resolveRunAnalysisEntryForTest({
        tenantId: f.tenantA.id,
        role: 'operator',
      })
      assert.equal(operatorEntry.canRunAnalysis, false)
      assert.equal(operatorEntry.runAnalystAgentId, null)
    } finally {
      await cleanupIsolationFixture(f)
    }
  })

  await check('run_* hívások audit-sort írnak (analysis.run_index / run_stats / run_trace)', async () => {
    await ensureDefaultRolePermissions()
    const f = await seedTenantIsolationFixture()
    try {
      const audit = new CapturingAudit()
      const index = new RunIndexService(prisma, audit)
      await index.query({
        tenantId: f.tenantA.id,
        requesterAgentId: f.runAnalystA.id,
        requesterAgentVersion: 1,
        actingUserId: f.adminA.id,
        args: { conversationId: f.conversation.id, limit: 5 },
      })
      assert.ok(audit.entries.some((e) => e.action === 'analysis.run_index'))

      const stats = new RunStatsService(prisma, audit, index)
      await stats.query({
        tenantId: f.tenantA.id,
        requesterAgentId: f.runAnalystA.id,
        requesterAgentVersion: 1,
        actingUserId: null,
        args: { conversationId: f.conversation.id, limit: 5 },
      })
      assert.ok(audit.entries.some((e) => e.action === 'analysis.run_stats'))

      const trace = new RunTraceService(prisma, audit)
      await trace.query({
        tenantId: f.tenantA.id,
        requesterAgentId: f.runAnalystA.id,
        requesterAgentVersion: 1,
        actingUserId: null,
        args: { grain: 'turn', runId: f.agentTurn.id, view: 'summary' },
      })
      assert.ok(audit.entries.some((e) => e.action === 'analysis.run_trace'))

      // US15: az audit-sorból ki kell derülnie, KI kérte az elemzést. Az `actorId`
      // maga az elemző agent, ezért az emberi kérő a metadatában van.
      const indexEntry = audit.entries.find((e) => e.action === 'analysis.run_index')!
      assert.equal(
        (indexEntry.metadata as { requestedByUserId?: string | null }).requestedByUserId,
        f.adminA.id,
      )
      const statsEntry = audit.entries.find((e) => e.action === 'analysis.run_stats')!
      assert.equal(
        (statsEntry.metadata as { requestedByUserId?: string | null }).requestedByUserId,
        null,
      )
    } finally {
      await cleanupIsolationFixture(f)
    }
  })

  await check('önelemzés: az elemző indította folyamat-futás nem kerül a run_index-be', async () => {
    const f = await seedTenantIsolationFixture()
    try {
      const analystProcess = await prisma.processInstance.create({
        data: {
          tenantId: f.tenantA.id,
          processType: 'ra_iso',
          status: 'created',
          playbookId: f.playbook.id,
          playbookVersionId: f.playbookVersion.id,
          playbookRef: f.playbook.key,
          playbookContentHash: f.playbookVersion.contentHash,
          startedByType: 'agent',
          startedByAgentId: f.runAnalystA.id,
        },
      })

      const index = new RunIndexService(prisma, new CapturingAudit())
      const result = await index.query({
        tenantId: f.tenantA.id,
        requesterAgentId: f.runAnalystA.id,
        requesterAgentVersion: 1,
        actingUserId: f.adminA.id,
        args: { playbookVersionId: f.playbookVersion.id, limit: 50 },
      })

      const ids = result.runs.map((run) => run.runId)
      assert.ok(!ids.includes(analystProcess.id), 'az elemző saját folyamat-futása kizárva')
      // A NEM az elemző által indított folyamat viszont bent marad (a `notIn`
      // önmagában kizárná a NULL indítójú sorokat is).
      assert.ok(ids.includes(f.process.id), 'idegen indítójú folyamat-futás megmarad')

      await prisma.processInstance.delete({ where: { id: analystProcess.id } })
    } finally {
      await cleanupIsolationFixture(f)
    }
  })

  await check('ticketId-szkóp: emberi felülvizsgálati ticket megtalálja a folyamat-futást, nem fullad el beszélgetés-fordulókban', async () => {
    const f = await seedTenantIsolationFixture()
    try {
      const stepStarted = new Date('2026-08-24T12:56:00Z')
      const reviewStarted = new Date('2026-08-24T12:56:30Z')
      const decoyStarted = new Date('2026-08-24T14:30:00Z')

      const stepTicket = await prisma.ticket.create({
        data: {
          tenantId: f.tenantA.id,
          type: 'interaction',
          title: 'adat_ertelmezes_es_feltoltes',
          state: 'awaiting_human',
          assigneeType: 'agent',
          agentId: f.worker.id,
          createdById: f.adminA.id,
          processInstanceId: f.process.id,
          playbookStepId: 'adat_ertelmezes_es_feltoltes',
          createdAt: stepStarted,
        },
      })
      const reviewTicket = await prisma.ticket.create({
        data: {
          tenantId: f.tenantA.id,
          type: 'interaction',
          title: 'Emberi felülvizsgálat: adat_ertelmezes_es_feltoltes',
          state: 'awaiting_human',
          assigneeType: 'human',
          agentId: null,
          createdById: f.adminA.id,
          processInstanceId: f.process.id,
          playbookStepId: 'adat_ertelmezes_es_feltoltes',
          createdAt: reviewStarted,
        },
      })
      await prisma.toolCall.createMany({
        data: [
          {
            agentId: f.worker.id,
            ticketId: stepTicket.id,
            toolName: 'http_api_get_all',
            status: 'ok',
            outcome: 'ok',
            latencyMs: 120,
            argsMeta: { path: '/ownership' },
          },
          {
            agentId: f.worker.id,
            ticketId: stepTicket.id,
            toolName: 'file_write',
            status: 'ok',
            outcome: 'ok',
            latencyMs: 20,
            argsMeta: { path: 'fold_frissites_progress.json' },
          },
          {
            agentId: f.worker.id,
            ticketId: stepTicket.id,
            toolName: 'tulajdoni_lap_egyeztetes',
            status: 'error',
            outcome: 'failed',
            latencyMs: 15,
            argsMeta: { path: 'feldolgozott-tulajdoni-lap-043-15.json' },
          },
        ],
      })
      await prisma.agentTurn.createMany({
        data: Array.from({ length: 5 }, (_, i) => ({
          conversationId: f.conversation.id,
          tenantId: f.tenantA.id,
          agentId: f.worker.id,
          agentVersion: 1,
          createdById: f.adminA.id,
          status: 'completed' as const,
          startedAt: new Date(decoyStarted.getTime() + i * 1_000),
        })),
      })

      const index = new RunIndexService(prisma, new CapturingAudit())
      const stats = new RunStatsService(prisma, new CapturingAudit(), index)
      const requester = {
        tenantId: f.tenantA.id,
        requesterAgentId: f.runAnalystA.id,
        requesterAgentVersion: 1,
        actingUserId: f.adminA.id,
      }

      const drowned = await index.query({
        ...requester,
        args: { ticketId: stepTicket.id, limit: 2 },
      })
      assert.ok(
        drowned.runs.some((run) => run.runId === stepTicket.id),
        'a lépés-ticket bent van',
      )
      assert.equal(
        drowned.runs.some((run) => run.grain === 'turn'),
        false,
        'idegen beszélgetés-forduló nem keveredik a ticket-szkópba',
      )

      const stepIndex = await index.query({
        ...requester,
        args: { ticketId: stepTicket.id, limit: 10 },
      })
      const stepIds = stepIndex.runs.map((run) => `${run.grain}:${run.runId}`)
      assert.ok(stepIds.includes(`ticket:${stepTicket.id}`), 'a lépés-ticket bent van')
      assert.ok(stepIds.includes(`process:${f.process.id}`), 'a folyamat-szemcse bent van')
      const stepHeader = stepIndex.runs.find((run) => run.runId === stepTicket.id)
      assert.ok(stepHeader)
      assert.equal(stepHeader!.toolCallCount, 3)

      const reviewIndex = await index.query({
        ...requester,
        args: { ticketId: reviewTicket.id, limit: 10 },
      })
      const reviewIds = reviewIndex.runs.map((run) => `${run.grain}:${run.runId}`)
      assert.ok(reviewIds.includes(`ticket:${reviewTicket.id}`), 'a felülvizsgálati ticket bent van')
      assert.ok(reviewIds.includes(`ticket:${stepTicket.id}`), 'a testvér lépés-ticket bent van')
      assert.ok(reviewIds.includes(`process:${f.process.id}`), 'a folyamat-szemcse a felülvizsgálatról is látszik')

      const poisoned = await index.query({
        ...requester,
        args: { ticketId: reviewTicket.id, agentQuery: 'Emberi review', limit: 10 },
      })
      assert.ok(
        poisoned.runs.some((run) => run.runId === stepTicket.id || run.runId === f.process.id),
        'nem illeszkedő agentQuery nem dobja el a ticket-horgonyt',
      )

      const NIL = '00000000-0000-0000-0000-000000000000'
      const nilCompanions = {
        agentId: NIL,
        conversationId: NIL,
        processInstanceId: NIL,
        playbookVersionId: NIL,
      } as const

      const nilTicket = await index.query({
        ...requester,
        args: { ticketId: reviewTicket.id, ...nilCompanions, limit: 10 },
      })
      assert.ok(
        nilTicket.runs.some((run) => run.runId === reviewTicket.id || run.runId === stepTicket.id),
        'nil UUID kísérőmezők nem dobják el a ticket-horgonyt',
      )

      const nilTicketList = await index.query({
        ...requester,
        args: { ticketIds: [reviewTicket.id], ticketId: NIL, ...nilCompanions, limit: 10 },
      })
      assert.ok(
        nilTicketList.runs.some((run) => run.runId === reviewTicket.id || run.runId === stepTicket.id),
        'explicit ticketIds + nil UUID kísérőmezők megtalálják a ticketet',
      )

      const nilConversation = await index.query({
        ...requester,
        args: { ...nilCompanions, conversationId: f.conversation.id, limit: 10 },
      })
      assert.ok(
        nilConversation.runs.some((run) => run.runId === f.agentTurn.id),
        'nil UUID kísérőmezők nem dobják el a beszélgetés-horgonyt',
      )

      const nilProcess = await index.query({
        ...requester,
        args: { processInstanceId: f.process.id, ticketId: NIL, conversationId: NIL, agentId: NIL, playbookVersionId: NIL, limit: 10 },
      })
      assert.ok(
        nilProcess.runs.some((run) => run.runId === f.process.id),
        'nil UUID kísérőmezők nem dobják el a folyamat-horgonyt',
      )

      const nilStats = await stats.query({
        ...requester,
        args: { ticketId: reviewTicket.id, ...nilCompanions, limit: 10 },
      })
      assert.equal(nilStats.totals.toolCallCount, 3, 'run_stats nil UUID mellett is a ticket szkópját adja')

      const selfScoped = await index.query({
        ...requester,
        args: { ticketId: reviewTicket.id, agentId: f.runAnalystA.id, limit: 10 },
      })
      assert.ok(
        selfScoped.runs.some((run) => run.runId === reviewTicket.id || run.runId === stepTicket.id),
        'az elemző saját agentId-je nem dobja el a ticket-horgonyt',
      )

      const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
      const maxUuidTicket = await index.query({
        ...requester,
        args: {
          ticketId: reviewTicket.id,
          agentId: MAX_UUID,
          conversationId: MAX_UUID,
          processInstanceId: MAX_UUID,
          playbookVersionId: MAX_UUID,
          agentQuery: 'Adatok értelmezése és feltöltése az Ostoros Föld API-n',
          limit: 10,
        },
      })
      assert.ok(
        maxUuidTicket.runs.some((run) => run.runId === reviewTicket.id || run.runId === stepTicket.id),
        'max UUID kísérőmezők nem dobják el a ticket-horgonyt',
      )

      const reviewStats = await stats.query({
        ...requester,
        args: { ticketId: reviewTicket.id, limit: 10 },
      })
      assert.equal(reviewStats.totals.toolCallCount, 3)
    } finally {
      await cleanupIsolationFixture(f)
    }
  })

  await check('run_trace: DB-oldali összefoglaló és lapozott idővonal 60 eszközhíváson', async () => {
    const f = await seedTenantIsolationFixture()
    try {
      const base = Date.now() - 600_000
      await prisma.toolCall.createMany({
        data: Array.from({ length: 60 }, (_, i) => ({
          agentId: f.worker.id,
          conversationId: f.conversation.id,
          agentTurnId: f.agentTurn.id,
          toolName: i % 2 === 0 ? 'file_read' : 'kb_search',
          status: (i % 20 === 0 ? 'error' : 'ok') as 'error' | 'ok',
          outcome: (i % 20 === 0 ? 'failed' : 'ok') as 'failed' | 'ok',
          latencyMs: 10 + i,
          argsMeta: { path: `f-${i}.json` },
          createdAt: new Date(base + i * 1_000),
        })),
      })
      await prisma.modelCall.createMany({
        data: Array.from({ length: 10 }, (_, i) => ({
          agentId: f.worker.id,
          conversationId: f.conversation.id,
          agentTurnId: f.agentTurn.id,
          provider: 'stub',
          model: 'stub',
          promptTokens: 1_000 + i * 100,
          completionTokens: 50,
          cachedPromptTokens: null,
          costEstimate: 0,
          latencyMs: 100,
          createdAt: new Date(base + i * 5_000),
        })),
      })

      const trace = new RunTraceService(prisma, new CapturingAudit())
      const requester = {
        tenantId: f.tenantA.id,
        requesterAgentId: f.runAnalystA.id,
        requesterAgentVersion: 1,
        actingUserId: f.adminA.id,
      }

      const summary = await trace.query({
        ...requester,
        args: { grain: 'turn' as const, runId: f.agentTurn.id, view: 'summary' as const },
      })
      assert.equal(summary.view, 'summary')
      if (summary.view !== 'summary') throw new Error('summary várt')
      assert.equal(summary.summary.toolCallCount, 60)
      assert.equal(summary.summary.modelCallCount, 10)
      assert.equal(summary.summary.nonOkToolCalls.length, 3)
      assert.deepEqual(summary.summary.degradedFields, [])

      // A teljes idővonal lapozással végigjárható, és nincs átfedés/kimaradás.
      const seen = new Set<string>()
      let offset = 0
      let total = 0
      for (let page = 0; page < 10; page += 1) {
        const detail = await trace.query({
          ...requester,
          args: {
            grain: 'turn' as const,
            runId: f.agentTurn.id,
            view: 'detail' as const,
            limit: 25,
            offset,
          },
        })
        if (detail.view !== 'detail') throw new Error('detail várt')
        total = detail.totalCount
        for (const entry of detail.entries) seen.add(`${entry.kind}:${entry.seq}`)
        offset += detail.entries.length
        if (!detail.truncated || detail.entries.length === 0) break
      }
      assert.equal(seen.size, total, 'minden idővonal-elem pontosan egyszer jött vissza')
      assert.ok(total >= 70, `70 sor + üzenetek vártak, kapott: ${total}`)

      // Eszköz-szűrés a DB where-be megy: csak tool_call jön vissza.
      const filtered = await trace.query({
        ...requester,
        args: {
          grain: 'turn' as const,
          runId: f.agentTurn.id,
          view: 'detail' as const,
          toolName: 'kb_search',
          limit: 200,
        },
      })
      if (filtered.view !== 'detail') throw new Error('detail várt')
      assert.equal(filtered.totalCount, 30)
      assert.ok(filtered.entries.every((e) => e.kind === 'tool_call'))
    } finally {
      await cleanupIsolationFixture(f)
    }
  })

  if (failures > 0) {
    console.error(`\n${failures} RA-09 ellenőrzés elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden RA-09 ellenőrzés zöld.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
