/**
 * Tanítás / önfejlesztés — TENANT-HATÁR regressziós teszt.
 *
 * Kontextus: a `TrainingService` három belépési pontja (`createTrainingTicket`,
 * `approveTraining`, `rollbackMemory`) csak a hívó SAJÁT tenantjában vett
 * szerepét ellenőrizte (`requireTenantRole`), a CÉL-agentet és a CÉL-ticketet
 * viszont szűretlen UUID-alapú lekérdezéssel oldotta fel. Egy multi-tenant
 * telepítésen ez cross-tenant memória-írást engedett: az A tenant approvere egy
 * ismert agent-/ticket-UUID-vel a B tenant agentjének memóriáját (az agent
 * utasításkészletét) írhatta át vagy görgethette vissza.
 *
 * A MemoryTraining spec I8 és T11 pontja ezt explicit tiltja
 * ("minden tábla tenant_id-scoped; cross-tenant olvasás/írás tiltott").
 *
 * A deny-utak DB nélkül futnak: a tenant-ellenőrzés minden `prisma`-érintés
 * ELŐTT dob, ezért in-memory fake repókkal determinisztikusak.
 *
 * Futtatás: npm run test:training-tenant
 */
import assert from 'node:assert/strict'
import type { Agent, Ticket } from '@prisma/client'
import { TrainingService, type TrainingActor } from '../src/domain/training/training-service'
import type { AgentRepository, AuditRepository, TicketRepository } from '../src/repositories/interfaces'
import type { TicketService } from '../src/domain/ticket/ticket-service'
import type { WriteGateService } from '../src/domain/writegate/write-gate-service'
import type { EvalService } from '../src/domain/eval/eval-service'
import type { SelfEvolutionGuard } from '../src/domain/training/self-evolution-guard'

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

const TENANT_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const TENANT_B = 'bbbbbbbb-0000-4000-8000-000000000002'

const AGENT_A = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const AGENT_B = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'
const AGENT_SHARED = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'

const TICKET_B = 'dddddddd-0000-4000-8000-00000000000b'
/** Tenant-bélyeg NÉLKÜLI, legacy training ticket a B tenant agentjén. */
const TICKET_LEGACY_B = 'dddddddd-0000-4000-8000-00000000000c'
const APPROVER_A = 'eeeeeeee-0000-4000-8000-00000000000a'

/** Az A tenant approvere — minden negatív esetben ő a támadó. */
const actorA: TrainingActor = { id: APPROVER_A, tenantId: TENANT_A, role: 'approver' }

function agentRow(id: string, tenantId: string | null): Agent {
  return { id, tenantId, name: `agent-${id.slice(0, 4)}` } as unknown as Agent
}

/** A B tenant tanítási ticketje, jóváhagyásra várva. */
function ticketRow(id: string, tenantId: string | null): Ticket {
  return {
    id,
    tenantId,
    type: 'training',
    state: 'awaiting_human',
    agentId: AGENT_B,
    payload: { proposedContent: 'IDEGEN TENANT MEMÓRIÁJA', source: 'attack' },
  } as unknown as Ticket
}

const tickets: Record<string, Ticket> = {
  [TICKET_B]: ticketRow(TICKET_B, TENANT_B),
  [TICKET_LEGACY_B]: ticketRow(TICKET_LEGACY_B, null),
}

const agents: Record<string, Agent> = {
  [AGENT_A]: agentRow(AGENT_A, TENANT_A),
  [AGENT_B]: agentRow(AGENT_B, TENANT_B),
  [AGENT_SHARED]: agentRow(AGENT_SHARED, null),
}

/**
 * A fake-ek szándékosan dobnak, ha a hívás a tenant-kapun TÚLJUT: így a teszt
 * akkor is bukik, ha a guard bekerül, de nem a `prisma` érintése ELŐTT fut.
 */
function makeService() {
  const agentRepo = {
    findById: async (id: string) => agents[id] ?? null,
  } as unknown as AgentRepository

  const ticketRepo = {
    findById: async (id: string) => tickets[id] ?? null,
    create: async () => {
      throw new Error('BOUNDARY_ESCAPED: tickets.create')
    },
  } as unknown as TicketRepository

  const audit = { append: async () => undefined } as unknown as AuditRepository
  const ticketService = {
    transition: async () => {
      throw new Error('BOUNDARY_ESCAPED: ticketService.transition')
    },
  } as unknown as TicketService
  const writeGate = {
    issue: async () => {
      throw new Error('BOUNDARY_ESCAPED: writeGate.issue')
    },
  } as unknown as WriteGateService
  const evalService = {
    findActiveForAgent: async () => null,
  } as unknown as EvalService
  const guard = {} as unknown as SelfEvolutionGuard

  return new TrainingService(
    ticketRepo,
    audit,
    ticketService,
    writeGate,
    evalService,
    agentRepo,
    guard,
  )
}

async function main() {
  console.log('Tanítás / önfejlesztés — tenant-határ regresszió\n')

  // ── createTrainingTicket ──────────────────────────────────────────────────
  await test('createTrainingTicket: idegen tenant agentjére NEM hoz létre javaslatot', async () => {
    await assert.rejects(
      () =>
        makeService().createTrainingTicket({
          agentId: AGENT_B,
          proposedContent: 'Injektált utasítás a B tenant agentjébe',
          source: 'attack',
          actor: actorA,
        }),
      /Agent not found/,
    )
  })

  // ── approveTraining ───────────────────────────────────────────────────────
  await test('approveTraining: idegen tenant training ticketjét NEM hagyja jóvá', async () => {
    await assert.rejects(
      () => makeService().approveTraining(TICKET_B, actorA),
      /Training ticket not found/,
    )
  })

  // A legacy (tenant-bélyeg nélküli) ticketet a MÖGÖTTES AGENT tenantja horgonyozza:
  // a ticket-scope átengedi, de az agent-guard elutasítja. Enélkül minden régi
  // training ticket bármely tenant approverének kezébe kerülne.
  await test('approveTraining: legacy tenant-nélküli ticketet az agent tenantja horgonyoz', async () => {
    await assert.rejects(
      () => makeService().approveTraining(TICKET_LEGACY_B, actorA),
      /Agent not found/,
    )
  })

  await test('approveTraining: a saját tenantban ismeretlen ticket opak hibát ad', async () => {
    await assert.rejects(
      () => makeService().approveTraining('00000000-0000-4000-8000-000000000000', actorA),
      /Training ticket not found/,
    )
  })

  // ── rollbackMemory ────────────────────────────────────────────────────────
  await test('rollbackMemory: idegen tenant agentjének memóriáját NEM görgeti vissza', async () => {
    await assert.rejects(
      () => makeService().rollbackMemory(AGENT_B, 1, actorA),
      /Agent not found/,
    )
  })

  await test('rollbackMemory: nem létező agent ugyanazt az opak hibát adja', async () => {
    await assert.rejects(
      () => makeService().rollbackMemory('00000000-0000-4000-8000-000000000000', 1, actorA),
      /Agent not found/,
    )
  })

  // ── Pozitív kontroll: a határ nem túl szűk ────────────────────────────────
  // A saját tenant agentje és a MEGOSZTOTT (platform-szintű) agent átjut a
  // tenant-kapun; a `BOUNDARY_ESCAPED` dobás bizonyítja, hogy a guard NEM
  // utasította el, a végrehajtás a kapun túlra jutott.
  await test('createTrainingTicket: saját tenant agentje átjut a tenant-kapun', async () => {
    await assert.rejects(
      () =>
        makeService().createTrainingTicket({
          agentId: AGENT_A,
          proposedContent: 'Jogos tanítási javaslat',
          source: 'ui',
          actor: actorA,
        }),
      // A tenant-guard átenged; a `prisma`-hívás DB nélkül bukik el.
      (e: Error) => !/^Agent not found$/.test(e.message),
    )
  })

  // I8 dokumentált korlát: a MEGOSZTOTT (tenantId === null) agent minden tenantból
  // elérhető — ez a platform-szintű agentek tudatos tulajdonsága, l. a PR nyitott
  // döntését. A teszt ezt RÖGZÍTI, hogy a viselkedés ne csússzon el észrevétlenül.
  await test('rollbackMemory: megosztott (platform) agent elérhető marad', async () => {
    await assert.rejects(
      () => makeService().rollbackMemory(AGENT_SHARED, 1, actorA),
      // A tenant-guard átenged; a `prisma`-hívás DB nélkül bukik el.
      (e: Error) => !/^Agent not found$/.test(e.message),
    )
  })

  if (failures > 0) {
    console.error(`\n${failures} tanítási tenant-határ teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden tanítási tenant-határ teszt zöld.')
}

void main()
