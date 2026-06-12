/**
 * Fázis 1 acceptance — spec 14. szakasz
 * Futtatás: npm run test:acceptance (app/)
 */
import { readFile } from 'fs/promises'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import type { UserRole } from '@prisma/client'
import { services } from '../src/domain'
import { prisma } from '../src/lib/db'
import { repositories } from '../src/repositories/postgres'

const SAMPLE_INVOICE = `
SZÁMLA
Szállító: AgroParts Kft.
Számlaszám: AP-2026-0042
Dátum: 2026-05-15
Nettó összeg: 125 000 Ft
ÁFA (27%): 33 750 Ft
Bruttó összeg: 158 750 Ft
Tétel: Traktor alkatrész — hidraulika szivattyú
`.trim()

type Result = { name: string; ok: boolean; detail?: string }

const results: Result[] = []

function pass(name: string, detail?: string) {
  results.push({ name, ok: true, detail })
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
}

function fail(name: string, detail: string) {
  results.push({ name, ok: false, detail })
  console.error(`  ❌ ${name} — ${detail}`)
}

async function getUser(role: 'operator' | 'approver') {
  const externalAuthId = role === 'operator' ? 'seed-operator' : 'seed-approver'
  const user = await prisma.user.findUnique({ where: { externalAuthId } })
  if (!user) throw new Error(`Seed user missing: ${externalAuthId}`)
  return user
}

async function getBookkeeperAgent() {
  const agent = await prisma.agent.findFirst({ where: { name: 'Könyvelő Agent' } })
  if (!agent) throw new Error('Könyvelő Agent not found — run npm run db:seed')
  return agent
}

function actor(role: UserRole, userId: string) {
  return { type: 'human' as const, userId, role }
}

/** 1. End-to-end: feltöltés → LLM → awaiting_human → jóváhagyás → done → audit */
async function scenario1_e2e(operatorId: string, approverId: string, agentId: string) {
  console.log('\n[1] End-to-end könyvelő flow')

  if (!process.env.GEMINI_API_KEY) {
    fail('E2E könyvelő flow', 'GEMINI_API_KEY nincs beállítva')
    return null
  }

  const doc = await repositories.documents.create({
    filename: 'acceptance-invoice.txt',
    storageRef: 'uploads/acceptance-test.txt',
    extractedText: SAMPLE_INVOICE,
    status: 'uploaded',
    uploadedById: operatorId,
  })

  let ticketId: string
  try {
    const { ticketId: id, proposal } = await services.bookkeeper.processDocument(
      doc.id,
      agentId,
      operatorId,
    )
    ticketId = id
    pass('processDocument + Gemini kinyerés', `ticket=${ticketId.slice(0, 8)}… supplier=${proposal.supplier}`)
  } catch (e) {
    fail('processDocument + Gemini kinyerés', e instanceof Error ? e.message : String(e))
    return null
  }

  const awaiting = await repositories.tickets.findById(ticketId)
  if (awaiting?.state === 'awaiting_human') {
    pass('Ticket awaiting_human állapotban')
  } else {
    fail('Ticket állapot', `várt: awaiting_human, kapott: ${awaiting?.state}`)
  }

  try {
    await services.tickets.transition({
      ticketId,
      toState: 'approved',
      actor: actor('approver', approverId),
    })
    await services.tickets.transition({
      ticketId,
      toState: 'in_progress',
      actor: { type: 'system' },
    })
    await services.tickets.transition({
      ticketId,
      toState: 'done',
      actor: { type: 'system' },
    })
    pass('Jóváhagyás → in_progress → done')
  } catch (e) {
    fail('Jóváhagyás lánc', e instanceof Error ? e.message : String(e))
    return ticketId
  }

  const done = await repositories.tickets.findById(ticketId)
  if (done?.state === 'done') {
    pass('Ticket lezárva (done)')
  } else {
    fail('Ticket végső állapot', done?.state ?? 'null')
  }

  const audit = await repositories.audit.findMany({ limit: 50 })
  const hasTransition = audit.some((e) => e.action === 'ticket.transition' && e.targetId === ticketId)
  const hasModelCall = audit.some((e) => e.action === 'model.call')
  if (hasTransition && hasModelCall) {
    pass('Audit log: ticket.transition + model.call')
  } else {
    fail('Audit log', `transition=${hasTransition} model.call=${hasModelCall}`)
  }

  const modelCalls = await prisma.modelCall.findMany({
    where: { ticketId },
    take: 1,
  })
  if (modelCalls.length > 0 && modelCalls[0].promptTokens > 0) {
    pass('model_calls token naplózás', `${modelCalls[0].promptTokens}+${modelCalls[0].completionTokens} token`)
  } else {
    fail('model_calls', 'nincs token rekord')
  }

  return ticketId
}

/** 2. Visszadobás: rejected → operator javít → in_review */
async function scenario2_rejection(operatorId: string, approverId: string, agentId: string) {
  console.log('\n[2] Visszadobás flow')

  const ticket = await repositories.tickets.create({
    type: 'interaction',
    title: 'Acceptance: visszadobás teszt',
    state: 'awaiting_human',
    assigneeType: 'human',
    assigneeId: null,
    agentId,
    payload: { proposal: { supplier: 'Teszt Kft.' } },
    sourceDocumentId: null,
    executeAfter: null,
    dueBy: null,
    createdById: operatorId,
  })

  try {
    await services.tickets.transition({
      ticketId: ticket.id,
      toState: 'rejected',
      actor: actor('approver', approverId),
      note: 'Hibás főkönyvi szám — javítandó',
    })
    pass('Approver rejected indoklással')
  } catch (e) {
    fail('Rejected átmenet', e instanceof Error ? e.message : String(e))
    return
  }

  const rejected = await repositories.tickets.findById(ticket.id)
  const payload = rejected?.payload as { transitionNote?: string }
  if (rejected?.state === 'rejected' && payload?.transitionNote) {
    pass('Rejected állapot + indoklás payload-ban')
  } else {
    fail('Rejected ellenőrzés', `state=${rejected?.state}`)
  }

  try {
    await services.tickets.transition({
      ticketId: ticket.id,
      toState: 'in_review',
      actor: actor('operator', operatorId),
    })
    pass('Operator: rejected → in_review')
  } catch (e) {
    fail('Operator javítás átmenet', e instanceof Error ? e.message : String(e))
  }
}

/** 3. Tanítás: training ticket → jóváhagyás → új memória */
async function scenario3_training(operatorId: string, approverId: string, agentId: string) {
  console.log('\n[3] Tanítás flow')

  const before = await repositories.agents.findByIdWithDetails(agentId)
  const versionBefore = before?.memoryVersion ?? 0

  const proposedContent = `${before?.memoryContent ?? ''}\n- Acceptance teszt szabály: 9999 szám minden AgroParts számlánál.`

  const trainingTicket = await services.training.createTrainingTicket({
    agentId,
    proposedContent,
    source: 'acceptance-test',
    createdById: operatorId,
  })

  if (trainingTicket.state === 'awaiting_human') {
    pass('Training ticket létrehozva (awaiting_human)')
  } else {
    fail('Training ticket állapot', trainingTicket.state)
  }

  const payload = trainingTicket.payload as { diff?: unknown }
  if (payload?.diff) {
    pass('Diff kiszámítva payload-ban')
  } else {
    fail('Diff', 'hiányzik')
  }

  try {
    const mv = await services.training.approveTraining(trainingTicket.id, approverId)
    pass('Tanítás jóváhagyva', `memory v${mv.version}`)
  } catch (e) {
    fail('approveTraining', e instanceof Error ? e.message : String(e))
    return
  }

  const after = await repositories.agents.findByIdWithDetails(agentId)
  if ((after?.memoryVersion ?? 0) > versionBefore) {
    pass('Új memória-verzió aktív', `v${versionBefore} → v${after?.memoryVersion}`)
  } else {
    fail('Memória verzió', `nem nőtt: ${versionBefore} → ${after?.memoryVersion}`)
  }

  const audit = await repositories.audit.findMany({ action: 'memory.update', limit: 5 })
  if (audit.some((e) => e.targetType === 'memory')) {
    pass('Audit: memory.update')
  } else {
    fail('Audit memory.update', 'nincs bejegyzés')
  }

  return after?.memoryVersion ?? versionBefore
}

/** 4. Rollback memória */
async function scenario4_rollback(approverId: string, agentId: string, rollbackToVersion: number) {
  console.log('\n[4] Rollback flow')

  if (rollbackToVersion < 1) {
    fail('Rollback', 'nincs korábbi verzió')
    return
  }

  try {
    await services.training.rollbackMemory(agentId, rollbackToVersion, approverId)
    pass(`Memória visszagörgetve v${rollbackToVersion}-re`)
  } catch (e) {
    fail('rollbackMemory', e instanceof Error ? e.message : String(e))
    return
  }

  const after = await repositories.agents.findByIdWithDetails(agentId)
  if (after?.memoryVersion === rollbackToVersion) {
    pass('Aktív memória verzió ellenőrizve')
  } else {
    fail('Rollback ellenőrzés', `várt v${rollbackToVersion}, aktív v${after?.memoryVersion}`)
  }

  const audit = await repositories.audit.findMany({ action: 'memory.rollback', limit: 5 })
  if (audit.length > 0) {
    pass('Audit: memory.rollback')
  } else {
    fail('Audit memory.rollback', 'nincs bejegyzés')
  }
}

/** 5. Tiltott átmenet */
async function scenario5_forbiddenTransition(operatorId: string, agentId: string) {
  console.log('\n[5] Tiltott átmenet')

  const ticket = await repositories.tickets.create({
    type: 'interaction',
    title: 'Acceptance: tiltott átmenet',
    state: 'backlog',
    assigneeType: null,
    assigneeId: null,
    agentId,
    payload: {},
    sourceDocumentId: null,
    executeAfter: null,
    dueBy: null,
    createdById: operatorId,
  })

  let blocked = false
  try {
    await services.tickets.transition({
      ticketId: ticket.id,
      toState: 'done',
      actor: actor('operator', operatorId),
    })
  } catch (e) {
    blocked = true
    pass('Tiltott backlog → done elutasítva', e instanceof Error ? e.message : String(e))
  }

  if (!blocked) {
    fail('Tiltott átmenet', 'átmenet engedélyezett volt — hiba!')
  }

  const unchanged = await repositories.tickets.findById(ticket.id)
  if (unchanged?.state === 'backlog') {
    pass('Állapot nem változott')
  } else {
    fail('Állapot megmaradt', `state=${unchanged?.state}`)
  }
}

/** 6. Reprodukálhatóság — lezárt ticketnél agent-verzió + modell */
async function scenario6_reproducibility(ticketId: string | null, agentId: string) {
  console.log('\n[6] Reprodukálhatóság')

  if (!ticketId) {
    fail('Reprodukálhatóság', 'nincs lezárt ticket az 1. scenárióból')
    return
  }

  const ticket = await repositories.tickets.findById(ticketId)
  const payload = ticket?.payload as {
    agentVersion?: number
    model?: string
    proposal?: unknown
  }

  if (payload?.agentVersion && payload?.model) {
    pass('Ticket payload: agentVersion + model', `v${payload.agentVersion}, ${payload.model}`)
  } else {
    fail('Ticket payload meta', JSON.stringify({ agentVersion: payload?.agentVersion, model: payload?.model }))
  }

  const agentVersion = await prisma.agentVersion.findUnique({
    where: { agentId_version: { agentId, version: payload?.agentVersion ?? 1 } },
    include: { memoryVersion: true },
  })

  if (agentVersion) {
    pass(
      'AgentVersion visszakereshető',
      `memory v${agentVersion.memoryVersion.version}, model=${JSON.stringify(agentVersion.modelConfigSnapshot)}`,
    )
  } else {
    fail('AgentVersion', 'nem található')
  }
}

async function readSeedDemoApiKey(): Promise<string | null> {
  try {
    const raw = await readFile(resolve(process.cwd(), '.seed-demo-api-key'), 'utf8')
    return raw.trim() || null
  } catch {
    return null
  }
}

/** Agent API-kulcs smoke teszt */
async function scenarioAgentApi(agentId: string) {
  console.log('\n[+] Agent API-kulcs (bonus)')

  const rawKey = await readSeedDemoApiKey()
  if (!rawKey) {
    fail('API-kulcs auth', 'nincs .seed-demo-api-key — futtasd: npm run db:seed')
    return
  }

  const auth = await repositories.agents.authenticateApiKey(rawKey)
  if (auth?.agentId === agentId) {
    pass('API-kulcs auth (seed demo key)')
  } else {
    fail('API-kulcs auth', 'seed kulcs nem validálódott — futtasd: npm run db:seed')
  }
}

async function main() {
  console.log('=== Fázis 1 Acceptance (spec §14) ===\n')

  const operator = await getUser('operator')
  const approver = await getUser('approver')
  const agent = await getBookkeeperAgent()

  console.log(`Agent: ${agent.name} (${agent.id.slice(0, 8)}…)`)
  console.log(`Operator: ${operator.name}, Approver: ${approver.name}`)

  const memoryVersionBeforeTraining = (
    await repositories.agents.findByIdWithDetails(agent.id)
  )?.memoryVersion ?? 1

  const ticketId = await scenario1_e2e(operator.id, approver.id, agent.id)
  await scenario2_rejection(operator.id, approver.id, agent.id)
  const memoryAfterTraining = await scenario3_training(operator.id, approver.id, agent.id)
  if (memoryAfterTraining && memoryAfterTraining > 1) {
    await scenario4_rollback(approver.id, agent.id, memoryVersionBeforeTraining)
  }
  await scenario5_forbiddenTransition(operator.id, agent.id)
  await scenario6_reproducibility(ticketId, agent.id)
  await scenarioAgentApi(agent.id)

  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length

  console.log('\n=== Összesítés ===')
  console.log(`  ${passed} sikeres, ${failed} sikertelen / ${results.length} összesen`)

  if (failed > 0) {
    console.log('\nSikertelen tesztek:')
    results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.detail}`))
    process.exit(1)
  }

  console.log('\n✅ Minden acceptance forgatókönyv sikeres.')
}

main()
  .catch((e) => {
    console.error('\nFatal:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
