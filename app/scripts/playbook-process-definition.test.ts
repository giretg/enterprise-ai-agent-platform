/**
 * Determinisztikus teszt a Folyamat-réteghez (Folyamat-feature-spec §4.1, §4.5, §4.8,
 * §4.11, §7) — DB és LLM NÉLKÜL, minimál in-memory stub-repókkal.
 *
 * Fedi:
 *   - ProcessDefinitionService.runActivationGate (WP-6): unbound role, alkalmatlan
 *     agent, hiányzó config-rés, ismeretlen permission; happy-path → nincs violation.
 *   - checkCronResolvability (WP-6): feloldhatatlan kötelező trigger-rés.
 *   - ProcessService.startProcess Folyamat-ág (WP-7): belépő ticket a KÖTÖTT agenthez;
 *     alkalmatlan kötés → blocked + process.blocked audit; hiányzó trigger-rés → blocked.
 *
 * Futtatás: npm run test:playbook-process-def
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PlaybookCompiler } from '../src/domain/playbook/playbook-compiler'
import { parsePlaybookSpecV2, type PlaybookSpecV2 } from '../src/lib/playbook-v2/spec'
import {
  missingRequiredTriggerSlots,
  resolveChatTriggerInputPayload,
  resolveTicketTriggerInputPayload,
} from '../src/lib/playbook-v2/trigger-input'
import {
  ProcessDefinitionService,
} from '../src/domain/playbook/process-definition-service'
import { ProcessService } from '../src/domain/playbook/process-service'

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

// --- Fixtures --------------------------------------------------------------

const TENANT = 't1'
const AGENT_ID = randomUUID()
const USER_ID = randomUUID()

/** Egy agent belépő lépés trigger-réssel + egy config-rés a lépés-utasításban. */
function specFixture(): PlaybookSpecV2 {
  return parsePlaybookSpecV2({
    schemaVersion: '1.0',
    key: 'company-report',
    name: 'Céges riport',
    processType: 'company_report',
    entryStepId: 'research',
    roles: [
      { key: 'researcher', type: 'agent_role', requiredCapabilities: ['tool:web_fetch'] },
    ],
    steps: [
      {
        id: 'research',
        name: 'Kutatás',
        ticketType: 'company_report',
        assignedRole: 'researcher',
        instructionTemplate: 'Készíts riportot a(z) {{ceg}} cégről a(z) {{sablon}} sablon alapján.',
        inputSlots: [
          { name: 'ceg', type: 'string', required: true, source: 'trigger' },
          { name: 'sablon', type: 'string', required: true, source: 'config' },
        ],
        allowedStates: ['ready', 'in_progress', 'done', 'failed'],
        timeoutMinutes: 60,
      },
    ],
    gates: [],
    transitions: [],
  })
}

function humanEntrySpecFixture(): PlaybookSpecV2 {
  return parsePlaybookSpecV2({
    schemaVersion: '1.0',
    key: 'approval',
    name: 'Jóváhagyás',
    processType: 'approval',
    entryStepId: 'approve',
    roles: [
      { key: 'approver', type: 'human_role', requiredPermissions: ['ticket:approve'] },
    ],
    steps: [
      {
        id: 'approve',
        name: 'Jóváhagyás',
        ticketType: 'interaction',
        assignedRole: 'approver',
        allowedStates: ['awaiting_human', 'approved'],
      },
    ],
    gates: [],
    transitions: [],
  })
}

const compiler = new PlaybookCompiler()

function versionFixture() {
  const spec = specFixture()
  return {
    id: randomUUID(),
    tenantId: TENANT,
    playbookId: randomUUID(),
    version: 1,
    status: 'published' as const,
    spec,
    compiledSpec: compiler.compile(spec, { playbookVersionId: 'v1' }),
    contentHash: 'sha256:deadbeef',
  }
}

/** Minimál stub-repók a két service-hez; csak a ténylegesen hívott metódusokat töltik. */
function makeStubs(opts: {
  agentStatus?: string
  agentCaps?: { toolName: string; allowed: boolean }[]
  knownPermissions?: string[]
}) {
  const version = versionFixture()
  const playbook = {
    id: version.playbookId,
    tenantId: TENANT,
    key: 'company-report',
    version: 1,
    processType: 'company_report',
  }
  const tickets: Record<string, unknown>[] = []
  const audits: { action: string; metadata: Record<string, unknown> }[] = []
  const processes: Record<string, Record<string, unknown>> = {}
  const steps: Record<string, unknown>[] = []

  const playbooks = {
    findVersion: async () => version,
    findPlaybook: async () => playbook,
  }
  const agents = {
    findById: async (id: string) =>
      id === AGENT_ID
        ? { id: AGENT_ID, tenantId: TENANT, status: opts.agentStatus ?? 'active' }
        : null,
  }
  const toolBroker = {
    findCapabilitiesForAgent: async () =>
      opts.agentCaps ?? [{ toolName: 'tool:web_fetch', allowed: true }],
  }
  const rolePermissions = {
    findByKey: async (key: string) =>
      (opts.knownPermissions ?? []).includes(key) ? { permissionKey: key, minRole: 'approver' } : null,
  }
  const users = {
    findById: async (id: string) =>
      id === USER_ID
        ? { id: USER_ID, tenantId: TENANT, status: 'active', role: 'approver', name: 'Jóváhagyó', email: 'ok@example.com' }
        : null,
  }
  const audit = {
    append: async (e: { action: string; metadata?: Record<string, unknown> }) => {
      audits.push({ action: e.action, metadata: e.metadata ?? {} })
    },
  }
  const processRepo = {
    createProcess: async (input: Record<string, unknown>) => {
      const id = randomUUID()
      processes[id] = { id, status: 'created', ...input }
      return processes[id]
    },
    findProcess: async (_t: string | null, id: string) => processes[id] ?? null,
    updateProcess: async (id: string, data: Record<string, unknown>) => {
      processes[id] = { ...processes[id], ...data }
      return processes[id]
    },
    createStep: async (input: Record<string, unknown>) => {
      const step = { id: randomUUID(), ...input }
      steps.push(step)
      return step
    },
    updateStep: async (id: string, data: Record<string, unknown>) => ({ id, ...data }),
    createDelegation: async (input: Record<string, unknown>) => ({ id: randomUUID(), ...input }),
    updateDelegation: async (id: string, data: Record<string, unknown>) => ({ id, ...data }),
  }
  const ticketRepo = {
    create: async (input: Record<string, unknown>) => {
      const t = { id: randomUUID(), ...input }
      tickets.push(t)
      return t
    },
  }

  const defRow = {
    id: randomUUID(),
    tenantId: TENANT,
    status: 'active' as const,
    playbookId: version.playbookId,
    playbookVersionId: version.id,
    roleBindings: { researcher: AGENT_ID } as Record<string, string>,
    configValues: { sablon: 'negyedéves' } as Record<string, unknown>,
    triggers: [],
  }
  const defsRepo = {
    findById: async () => defRow,
    create: async () => defRow,
    list: async () => [defRow],
    update: async (_id: string, data: Record<string, unknown>) => ({ ...defRow, ...data }),
    createTrigger: async (input: Record<string, unknown>) => ({ id: randomUUID(), ...input }),
    findTrigger: async () => null,
    listTriggers: async () => [],
    deleteTrigger: async () => {},
  }

  return { version, tickets, audits, processes, steps, defRow, playbooks, agents, toolBroker, rolePermissions, users, audit, processRepo, ticketRepo, defsRepo }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeDefService(s: ReturnType<typeof makeStubs>) {
  return new ProcessDefinitionService(
    s.defsRepo as any,
    s.playbooks as any,
    s.agents as any,
    s.toolBroker as any,
    s.rolePermissions as any,
    s.users as any,
    s.audit as any,
  )
}

function makeProcessService(s: ReturnType<typeof makeStubs>) {
  return new ProcessService(
    s.processRepo as any,
    s.playbooks as any,
    s.ticketRepo as any,
    s.audit as any,
    s.defsRepo as any,
    s.agents as any,
    s.toolBroker as any,
    s.users as any,
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function main() {
  console.log('=== runActivationGate (§4.8, WP-6) ===')

  await test('happy path: kötött+alkalmas agent → nincs activation violation', async () => {
    const s = makeStubs({})
    const svc = makeDefService(s)
    const violations = await svc.runActivationGate(s.defRow as never)
    assert.deepEqual(violations, [])
  })

  await test('unbound role → ROLE_UNBOUND', async () => {
    const s = makeStubs({})
    s.defRow.roleBindings = {}
    const svc = makeDefService(s)
    const violations = await svc.runActivationGate(s.defRow as never)
    assert.ok(violations.some((v) => v.code === 'ROLE_UNBOUND'))
  })

  await test('alkalmatlan (fedetlen capability) agent → AGENT_UNSUITABLE', async () => {
    const s = makeStubs({ agentCaps: [{ toolName: 'tool:web_fetch', allowed: false }] })
    const svc = makeDefService(s)
    const violations = await svc.runActivationGate(s.defRow as never)
    assert.ok(violations.some((v) => v.code === 'AGENT_UNSUITABLE'))
  })

  await test('human role kötött aktív, jogosult userhez → nincs violation', async () => {
    const s = makeStubs({ knownPermissions: ['ticket:approve'] })
    const humanSpec = humanEntrySpecFixture()
    s.version.spec = humanSpec
    s.version.compiledSpec = compiler.compile(humanSpec, { playbookVersionId: 'v1' })
    s.defRow.roleBindings = { approver: USER_ID }
    const svc = makeDefService(s)
    const violations = await svc.runActivationGate(s.defRow as never)
    assert.deepEqual(violations, [])
  })

  await test('human role kötés nélkül → HUMAN_ROLE_UNBOUND', async () => {
    const s = makeStubs({ knownPermissions: ['ticket:approve'] })
    const humanSpec = humanEntrySpecFixture()
    s.version.spec = humanSpec
    s.version.compiledSpec = compiler.compile(humanSpec, { playbookVersionId: 'v1' })
    s.defRow.roleBindings = {}
    const svc = makeDefService(s)
    const violations = await svc.runActivationGate(s.defRow as never)
    assert.ok(violations.some((v) => v.code === 'HUMAN_ROLE_UNBOUND'))
  })

  console.log('=== checkCronResolvability (§4.5, WP-6) ===')

  await test('feloldhatatlan kötelező trigger-rés → CRON_SLOT_UNRESOLVABLE', async () => {
    const s = makeStubs({})
    const svc = makeDefService(s)
    const violations = svc.checkCronResolvability(s.version.compiledSpec, { contextMap: {} })
    assert.ok(violations.some((v) => v.code === 'CRON_SLOT_UNRESOLVABLE'))
  })

  await test('contextMap-ból feloldható trigger-rés → nincs violation', async () => {
    const s = makeStubs({})
    const svc = makeDefService(s)
    const violations = svc.checkCronResolvability(s.version.compiledSpec, {
      contextMap: { ceg: 'now()' },
    })
    assert.deepEqual(violations, [])
  })

  console.log('=== startProcess Folyamat-ág (§7, WP-7) ===')

  await test('belépő lépés-ticket a KÖTÖTT agenthez jön létre', async () => {
    const s = makeStubs({})
    const svc = makeProcessService(s)
    const proc = await svc.startProcess({
      tenantId: TENANT,
      processDefinitionId: s.defRow.id,
      triggerType: 'manual',
      inputPayload: { ceg: 'Acme Kft', sablon: 'vezetői' },
      startedBy: { type: 'user', id: randomUUID() },
    })
    assert.equal(proc.status, 'running')
    assert.equal(s.tickets.length, 1)
    assert.equal(s.tickets[0].agentId, AGENT_ID)
    assert.equal(s.tickets[0].assigneeType, 'agent')
    assert.deepEqual(s.tickets[0].payload, { ceg: 'Acme Kft', sablon: 'vezetői' })
    assert.ok(s.audits.some((a) => a.action === 'process.start' && a.metadata.process_definition_id === s.defRow.id))
  })

  await test('alkalmatlan kötés → blocked + process.blocked audit (nem néma)', async () => {
    const s = makeStubs({ agentStatus: 'retired' })
    const svc = makeProcessService(s)
    const proc = await svc.startProcess({
      tenantId: TENANT,
      processDefinitionId: s.defRow.id,
      triggerType: 'manual',
      inputPayload: { ceg: 'Acme Kft', sablon: 'vezetői' },
      startedBy: { type: 'user', id: randomUUID() },
    })
    assert.equal(proc.status, 'blocked')
    assert.equal(s.tickets.length, 0)
    assert.ok(s.audits.some((a) => a.action === 'process.blocked'))
  })

  await test('hiányzó kötelező step input-rés → blocked, nincs lépés-ticket', async () => {
    const s = makeStubs({})
    const svc = makeProcessService(s)
    const proc = await svc.startProcess({
      tenantId: TENANT,
      processDefinitionId: s.defRow.id,
      triggerType: 'monitor_cron',
      inputPayload: { ceg: 'Acme Kft' }, // 'sablon' hiányzik az entry tickethez
      startedBy: { type: 'system' },
    })
    assert.equal(proc.status, 'blocked')
    assert.equal(s.tickets.length, 0)
    assert.ok(s.audits.some((a) => a.action === 'process.blocked'))
  })

  await test('human belépő lépés-ticket a KÖTÖTT userhez jön létre', async () => {
    const s = makeStubs({ knownPermissions: ['ticket:approve'] })
    const humanSpec = humanEntrySpecFixture()
    s.version.spec = humanSpec
    s.version.compiledSpec = compiler.compile(humanSpec, { playbookVersionId: 'v1' })
    s.defRow.roleBindings = { approver: USER_ID }
    const svc = makeProcessService(s)
    const proc = await svc.startProcess({
      tenantId: TENANT,
      processDefinitionId: s.defRow.id,
      triggerType: 'manual',
      inputPayload: {},
      startedBy: { type: 'user', id: randomUUID() },
    })
    assert.equal(proc.status, 'running')
    assert.equal(s.tickets.length, 1)
    assert.equal(s.tickets[0].assigneeType, 'human')
    assert.equal(s.tickets[0].assigneeId, USER_ID)
    assert.equal(s.steps[0].assignedUserId, USER_ID)
  })

  console.log('=== ticket trigger input-feloldás (§4.4, WP-9) ===')

  await test('ticket fieldMap → inputPayload payloadból és ticket meta mezőkből', async () => {
    const now = new Date('2026-07-03T10:00:00.000Z')
    const payload = resolveTicketTriggerInputPayload(
      {
        fieldMap: {
          ceg: 'payload.company',
          leiras: 'task',
          triggerTicketId: 'ticket.id',
          cim: 'title',
        },
      },
      {
        id: 'ticket-1',
        title: 'Céges riport kérése',
        type: 'interaction',
        state: 'awaiting_human',
        payload: { company: 'Acme Kft', task: 'Riport kell' },
        createdAt: now,
        updatedAt: now,
      } as never,
    )
    assert.deepEqual(payload, {
      ceg: 'Acme Kft',
      leiras: 'Riport kell',
      triggerTicketId: 'ticket-1',
      cim: 'Céges riport kérése',
    })
  })

  await test('ticket-triggeres Futás a trigger-ticketet rootTicketId-ként tartja meg', async () => {
    const s = makeStubs({})
    const svc = makeProcessService(s)
    const rootTicketId = randomUUID()
    const proc = await svc.startProcess({
      tenantId: TENANT,
      processDefinitionId: s.defRow.id,
      triggerType: 'ticket',
      inputPayload: { ceg: 'Acme Kft', sablon: 'vezetői' },
      rootTicketId,
      startedBy: { type: 'user', id: randomUUID() },
    })
    assert.equal(proc.status, 'running')
    assert.equal(proc.rootTicketId, rootTicketId)
    assert.equal(s.tickets.length, 1)
    assert.equal(s.tickets[0].agentId, AGENT_ID)
  })

  console.log('=== chat trigger input-feloldás (§4.4, WP-9) ===')

  await test('chat slotNames + aliasok → inputPayload explicit és üzenet mezőkből', async () => {
    const payload = resolveChatTriggerInputPayload(
      {
        slotNames: ['ceg', 'prioritas', 'sablon'],
        aliases: { ceg: ['company'], prioritas: ['priority'] },
      },
      'company: Acme Kft\npriority: 3\nirrelevant: kimarad',
      { sablon: 'vezetői' },
    )
    assert.deepEqual(payload, { ceg: 'Acme Kft', prioritas: 3, sablon: 'vezetői' })
  })

  await test('chat trigger hiányzó kötelező slotokat név szerint jelzi', async () => {
    const s = makeStubs({})
    const missing = missingRequiredTriggerSlots(s.version.compiledSpec, {})
    assert.deepEqual(missing, ['ceg'])
  })

  await test('chat-triggeres Futás conversationId-vel linkelt', async () => {
    const s = makeStubs({})
    const svc = makeProcessService(s)
    const conversationId = randomUUID()
    const proc = await svc.startProcess({
      tenantId: TENANT,
      processDefinitionId: s.defRow.id,
      triggerType: 'chat',
      inputPayload: { ceg: 'Acme Kft', sablon: 'vezetői' },
      conversationId,
      startedBy: { type: 'user', id: randomUUID() },
    })
    assert.equal(proc.status, 'running')
    assert.equal(proc.conversationId, conversationId)
    assert.equal(s.tickets.length, 1)
    assert.equal(s.tickets[0].agentId, AGENT_ID)
  })

  console.log('')
  if (failures > 0) {
    console.error(`❌ ${failures} teszt elbukott`)
    process.exit(1)
  }
  console.log('✅ Minden Folyamat-réteg teszt zöld')
}

void main()
