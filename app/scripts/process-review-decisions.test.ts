/**
 * Emberi felülvizsgálat lezárása — a három döntés (újrafuttatás / elfogadás / leállítás).
 * Futtatás: npx tsx scripts/process-review-decisions.test.ts
 *
 * DB nélkül, minimális in-memory fake repókkal. Azt igazolja, hogy a döntés
 * MINDIG nyomot hagy a futáson: a lépés-ticket újraindul (a diszpécser fel tudja
 * venni), vagy a folyamat továbblép, vagy a nyitott feladatok lezárulnak.
 */
import assert from 'node:assert/strict'
import type {
  AuditRepository,
  PlaybookV2Repository,
  ProcessRepository,
  TicketRepository,
} from '../src/repositories/interfaces'
import { MAX_HUMAN_RETRY_ATTEMPTS, ProcessService } from '../src/domain/playbook/process-service'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'

let failures = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.error(`  ❌ ${name}`)
    console.error(e)
  }
}

type FakeTicket = {
  id: string
  tenantId: string | null
  state: string
  title: string
  agentId: string | null
  processInstanceId: string | null
  playbookStepId: string | null
  requiredGateId: string | null
  payload: Record<string, unknown>
}

function harness(overrides?: { stepTicket?: Partial<FakeTicket>; processStatus?: string }) {
  const tenantId = 'tenant-1'
  const process = {
    id: 'proc-1',
    tenantId,
    status: overrides?.processStatus ?? 'awaiting_human',
    playbookRef: 'playbook:teszt@v1',
    playbookVersionId: 'ver-1',
    processType: 'adat-feldolgozás',
  }
  const stepInstance = {
    id: 'si-1',
    stepId: 'pdf_beolvasas',
    stepName: 'PDF beolvasása',
    status: 'completed',
    ticketId: 't-step',
    completedAt: new Date(),
  }
  const tickets: FakeTicket[] = [
    {
      id: 't-step',
      tenantId,
      state: 'done',
      title: 'PDF beolvasása',
      agentId: 'agent-1',
      processInstanceId: process.id,
      playbookStepId: 'pdf_beolvasas',
      requiredGateId: null,
      payload: { outcome: { status: 'failed', reason: 'tool_denied' }, answer: 'kész' },
      ...overrides?.stepTicket,
    },
    {
      id: 't-review',
      tenantId,
      state: 'awaiting_human',
      title: 'Emberi felülvizsgálat: pdf_beolvasas',
      agentId: null,
      processInstanceId: process.id,
      playbookStepId: 'pdf_beolvasas',
      requiredGateId: null,
      payload: {},
    },
  ]

  const comments: Array<{ ticketId: string; body: string }> = []
  const transitions: Array<{ ticketId: string; fromState: string; toState: string; note: string | null }> = []
  const audits: Array<{ action: string; metadata: Record<string, unknown> | null }> = []

  const ticketRepo = {
    findById: async (id: string) => tickets.find((t) => t.id === id) ?? null,
    findMany: async (filter?: { processInstanceId?: string }) =>
      tickets.filter((t) => !filter?.processInstanceId || t.processInstanceId === filter.processInstanceId),
    update: async (id: string, data: Record<string, unknown>) => {
      const ticket = tickets.find((t) => t.id === id)
      if (!ticket) throw new Error('no ticket')
      if (typeof data.state === 'string') ticket.state = data.state
      if (data.payload) ticket.payload = data.payload as Record<string, unknown>
      return ticket
    },
    recordTransition: async (data: {
      ticketId: string
      fromState: string
      toState: string
      note: string | null
    }) => {
      transitions.push(data)
      return data
    },
    appendComment: async (data: { ticketId: string; body: string }) => {
      comments.push({ ticketId: data.ticketId, body: data.body })
      return data
    },
  } as unknown as TicketRepository

  const processRepo = {
    findProcess: async (_tenantId: string | null, id: string) => (id === process.id ? process : null),
    findStep: async (_processId: string, stepId: string) =>
      stepId === stepInstance.stepId ? stepInstance : null,
    updateStep: async (_id: string, data: { status?: string; completedAt?: Date | null }) => {
      if (data.status) stepInstance.status = data.status
      if (data.completedAt === null) stepInstance.completedAt = null as unknown as Date
      return stepInstance
    },
    updateProcess: async (_id: string, data: { status?: string }) => {
      if (data.status) process.status = data.status
      return process
    },
  } as unknown as ProcessRepository

  const auditRepo = {
    append: async (entry: { action: string; metadata: Record<string, unknown> | null }) => {
      assertAuditActionRegistered(entry.action)
      audits.push({ action: entry.action, metadata: entry.metadata })
      return entry
    },
  } as unknown as AuditRepository

  const playbookRepo = { findVersion: async () => null } as unknown as PlaybookV2Repository

  const service = new ProcessService(processRepo, playbookRepo, ticketRepo, auditRepo)
  return { service, tenantId, process, stepInstance, tickets, comments, transitions, audits }
}

async function main() {
console.log('process-review-decisions')

await test('újrafuttatás: a LÉPÉS ticketje indul újra, nem a felülvizsgálati', async () => {
  const h = harness()
  const result = await h.service.retryStepFromReview({
    tenantId: h.tenantId,
    reviewTicketId: 't-review',
    clarification: 'A válasz végén add vissza a feldolgozottLapPath értékét.',
    actorUserId: 'user-1',
  })

  assert.equal(result.stepTicketId, 't-step')
  assert.equal(result.attempt, 1)

  const stepTicket = h.tickets.find((t) => t.id === 't-step')!
  // A diszpécser csak `ready` + agenthez kötött ticketet vesz fel.
  assert.equal(stepTicket.state, 'ready')
  assert.equal(stepTicket.agentId, 'agent-1')
  // A régi gépi kudarc-bélyeg nem maradhat rajta.
  assert.equal(stepTicket.payload.outcome, undefined)
  assert.equal(stepTicket.payload.humanRetryAttempt, 1)

  // A pontosítás a LÉPÉS szálába kerül — onnan olvassa a futtató runtime.
  assert.deepEqual(
    h.comments.map((c) => c.ticketId),
    ['t-step'],
  )
  assert.match(h.comments[0].body, /feldolgozottLapPath/)

  // A felülvizsgálati ticket lezárul, a folyamat újra fut.
  assert.equal(h.tickets.find((t) => t.id === 't-review')!.state, 'done')
  assert.equal(h.process.status, 'running')
  assert.equal(h.stepInstance.status, 'ready')
  assert.ok(h.audits.some((a) => a.action === 'process.step.retry'))
})

await test('újrafuttatás: a próbálkozások száma korlátos', async () => {
  const h = harness({
    stepTicket: { payload: { humanRetryAttempt: MAX_HUMAN_RETRY_ATTEMPTS } } as Partial<FakeTicket>,
  })
  await assert.rejects(
    h.service.retryStepFromReview({
      tenantId: h.tenantId,
      reviewTicketId: 't-review',
      clarification: 'még egyszer',
      actorUserId: 'user-1',
    }),
    /nem segít/,
  )
  assert.equal(h.tickets.find((t) => t.id === 't-step')!.state, 'done')
})

await test('újrafuttatás: AI munkatárs nélküli lépés nem indítható újra', async () => {
  const h = harness({ stepTicket: { agentId: null } })
  await assert.rejects(
    h.service.retryStepFromReview({
      tenantId: h.tenantId,
      reviewTicketId: 't-review',
      clarification: 'pótold',
      actorUserId: 'user-1',
    }),
    /nincs AI munkatárs/,
  )
})

await test('újrafuttatás: üres pontosítás nem megy át', async () => {
  const h = harness()
  await assert.rejects(
    h.service.retryStepFromReview({
      tenantId: h.tenantId,
      reviewTicketId: 't-review',
      clarification: '   ',
      actorUserId: 'user-1',
    }),
    /kötelező/,
  )
})

await test('elfogadás: a kézzel pótolt mező a lépés kimenetébe kerül, a hiba felülírva', async () => {
  const h = harness()
  const advancedCalls: Array<{ completedStepId: string; resultPayload?: Record<string, unknown> }> = []
  h.service.advance = (async (input: {
    completedStepId: string
    resultPayload?: Record<string, unknown>
  }) => {
    advancedCalls.push(input)
    return { kind: 'noop' as const, status: 'running' as const }
  }) as ProcessService['advance']

  await h.service.resolveStepFromReview({
    tenantId: h.tenantId,
    reviewTicketId: 't-review',
    outputPatch: { feldolgozottLapPath: 'tulajdoni_lap_handoff.json', ures: '  ' },
    note: 'Kézzel ellenőriztem.',
    actorUserId: 'user-1',
  })

  const stepTicket = h.tickets.find((t) => t.id === 't-step')!
  assert.equal(stepTicket.payload.feldolgozottLapPath, 'tulajdoni_lap_handoff.json')
  // Üres értékkel nem írunk felül semmit.
  assert.equal(stepTicket.payload.ures, undefined)
  assert.deepEqual(stepTicket.payload.outcome, {
    status: 'ok',
    reason: 'human_override',
    message: 'Kézzel ellenőriztem.',
  })

  assert.equal(advancedCalls.length, 1)
  assert.equal(advancedCalls[0].completedStepId, 'pdf_beolvasas')
  assert.equal(h.tickets.find((t) => t.id === 't-review')!.state, 'approved')

  // Az audit a felülbírálás tényét és a kulcsokat őrzi — az értékeket nem.
  const override = h.audits.find((a) => a.action === 'process.step.human_override')
  assert.ok(override)
  assert.deepEqual(override!.metadata?.overridden_fields, ['feldolgozottLapPath'])
  assert.equal(JSON.stringify(override!.metadata).includes('tulajdoni_lap_handoff.json'), false)
})

await test('leállítás: a nyitott feladatok lezárulnak, a lezártakat nem bántjuk', async () => {
  const h = harness()
  const result = await h.service.cancelProcessWithTickets({
    tenantId: h.tenantId,
    processInstanceId: 'proc-1',
    reason: 'Rossz forrásfájllal indult.',
    actorUserId: 'user-1',
  })

  assert.deepEqual(result.closedTicketIds, ['t-review'])
  assert.equal(h.tickets.find((t) => t.id === 't-review')!.state, 'rejected')
  assert.equal(h.tickets.find((t) => t.id === 't-step')!.state, 'done')
  assert.equal(h.process.status, 'cancelled')
  assert.ok(
    h.transitions.some((t) => t.ticketId === 't-review' && /leállítva/.test(t.note ?? '')),
  )
})

await test('lezárt folyamaton már nincs döntés', async () => {
  const h = harness({ processStatus: 'completed' })
  await assert.rejects(
    h.service.retryStepFromReview({
      tenantId: h.tenantId,
      reviewTicketId: 't-review',
      clarification: 'mégis',
      actorUserId: 'user-1',
    }),
    /már lezárult/,
  )
})

  if (failures > 0) {
    console.error(`\n${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('ok')
}

void main()
