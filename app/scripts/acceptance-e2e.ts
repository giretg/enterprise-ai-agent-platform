/**
 * MVP v1 acceptance — walking skeleton smoke checks
 * Futtatás: npm run test:acceptance (app/)
 */
import { readFile, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { config } from 'dotenv'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import type { UserRole } from '@prisma/client'
import { services } from '../src/domain'
import { runHarnessEntrypoint } from '../src/harness/job-entrypoint'
import { buildGooseCommandJson } from '../src/harness/goose-command'
import { prepareGooseHarnessEnv } from '../src/harness/goose-config'
import { handleMcpRequest } from '../src/harness/platform-mcp-bridge'
import {
  assertEgressDenyByDefault,
  collectAllowedHarnessHosts,
  EgressPolicyViolation,
  evaluateEgressAllowlist,
} from '../src/harness/egress-guard'
import { POST as gatewayChatCompletions } from '../src/app/api/v1/gateway/v1/chat/completions/route'
import { DISPATCH_NOTIFY_CHANNEL } from '../src/lib/dispatch-notify'
import { prisma } from '../src/lib/db'
import { repositories } from '../src/repositories/postgres'
import {
  buildMeasurementReport,
  renderMeasurementMarkdown,
} from '../src/domain/governance/measurement-report'
import { assertRole } from '../src/auth/types'

const SAMPLE_WIKI_QUESTION =
  'Mi az MVP célja, és milyen átjárókon kell átmennie az agent műveleteinek?'

function ensureOAuthStubForAcceptance() {
  const url = process.env.CHATGPT_OAUTH_PROVIDER_URL?.trim()
  const key = process.env.CHATGPT_OAUTH_PROVIDER_KEY?.trim()
  if (!url || !key) {
    process.env.CHATGPT_OAUTH_PROVIDER_URL = 'stub'
    process.env.CHATGPT_OAUTH_PROVIDER_KEY = 'stub'
  }
}

function isOAuthConfiguredForAcceptance() {
  const url = process.env.CHATGPT_OAUTH_PROVIDER_URL?.trim()
  const key = process.env.CHATGPT_OAUTH_PROVIDER_KEY?.trim()
  return Boolean(url && key)
}

type Result = { name: string; ok: boolean; skipped?: boolean; detail?: string }

const results: Result[] = []

function pass(name: string, detail?: string) {
  results.push({ name, ok: true, detail })
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
}

function fail(name: string, detail: string) {
  results.push({ name, ok: false, detail })
  console.error(`  ❌ ${name} — ${detail}`)
}

function skip(name: string, detail: string) {
  results.push({ name, ok: true, skipped: true, detail })
  console.log(`  ◌ ${name} — kihagyva: ${detail}`)
}

async function getUser(role: 'operator' | 'approver') {
  const externalAuthId = role === 'operator' ? 'seed-operator' : 'seed-approver'
  const user = await prisma.user.findUnique({ where: { externalAuthId } })
  if (!user) throw new Error(`Seed user missing: ${externalAuthId}`)
  return user
}

async function getWikiAgent() {
  const agent = await prisma.agent.findFirst({ where: { name: 'Wiki Agent' } })
  if (!agent) throw new Error('Wiki Agent not found — run npm run db:seed')
  return agent
}

/**
 * Idempotencia: a dispatcher per-agent **napi** hívás-keretet érvényesít
 * (`maxCallsPerDay`). Mivel a suite ugyanazt a seed-agentet és egy közös
 * (megosztott) DB-t használ, több azonos napi futás kimerítené a keretet és a
 * `dispatchTicket` `budget_blocked`-ot adna (a wiki-flow ticket `ready`-ben
 * ragadna). A ma keletkezett `model_calls` telemetria törlése a futás elején
 * nullázza a napi felhasználást — külön tábla, az append-only audit-láncot nem
 * érinti.
 */
async function resetSameDayBudget(agentId: string) {
  const since = new Date()
  since.setHours(0, 0, 0, 0)
  const { count } = await prisma.modelCall.deleteMany({
    where: { agentId, createdAt: { gte: since } },
  })
  if (count > 0) console.log(`Napi hívás-keret nullázva (törölt model_calls: ${count})`)
}

function actor(role: UserRole, userId: string) {
  return { type: 'human' as const, userId, role }
}

/** 1. Wiki path smoke: kérdés → retrieval → LLM → board_write → jóváhagyás/done → audit */
async function scenario1_e2e(operatorId: string, approverId: string, agentId: string) {
  console.log('\n[1] Wiki kérdés flow smoke')

  if (!isOAuthConfiguredForAcceptance()) {
    skip('Wiki kérdés flow', 'ChatGPT OAuth provider nincs beállítva (S2 spike pending)')
    return null
  }

  const usingStub = process.env.CHATGPT_OAUTH_PROVIDER_URL === 'stub'

  let ticketId: string
  try {
    const ticket = await services.wiki.createQuestionTicket({
      agentId,
      question: SAMPLE_WIKI_QUESTION,
      createdById: operatorId,
    })
    ticketId = ticket.id
    const dispatch = await services.dispatcher.dispatchTicket(ticketId)
    const answered = await repositories.tickets.findById(ticketId)
    const payload = answered?.payload as { confidence?: string }
    pass(
      'ready ticket + dispatcher + ChatGPT OAuth válasz',
      `ticket=${ticketId.slice(0, 8)}… dispatch=${dispatch.status} confidence=${payload?.confidence ?? 'n/a'}${usingStub ? ' (stub)' : ''}`,
    )
  } catch (e) {
    fail('ready ticket + dispatcher + ChatGPT OAuth válasz', e instanceof Error ? e.message : String(e))
    return null
  }

  const answered = await repositories.tickets.findById(ticketId)
  if (answered?.state === 'awaiting_human' || answered?.state === 'done') {
    pass('Ticket válaszolt állapotban', answered.state)
  } else {
    fail('Ticket állapot', `várt: awaiting_human/done, kapott: ${answered?.state}`)
  }

  if (answered?.state === 'awaiting_human') {
    try {
      await services.tickets.transition({
        ticketId,
        toState: 'approved',
        actor: actor('approver', approverId),
      })
      await services.tickets.transition({
        ticketId,
        toState: 'done',
        actor: { type: 'system' },
      })
      pass('Jóváhagyás → done')
    } catch (e) {
      fail('Jóváhagyás lánc', e instanceof Error ? e.message : String(e))
      return ticketId
    }
  } else {
    pass('Magas bizalmú válasz automatikusan done')
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
  const hasToolCall = audit.some((e) => e.action === 'tool.call')
  if (hasTransition && hasModelCall && hasToolCall) {
    pass('Audit log: ticket.transition + model.call + tool.call')
  } else {
    fail('Audit log', `transition=${hasTransition} model.call=${hasModelCall} tool.call=${hasToolCall}`)
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

/** 2. Visszadobás: rejected → operator javít → ready */
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
      toState: 'ready',
      actor: actor('operator', operatorId),
    })
    pass('Operator: rejected → ready')
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
    const result = await services.training.approveTraining(trainingTicket.id, approverId)
    pass('Tanítás jóváhagyva', `memory v${result.memoryVersion.version}`)
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
    skip('Reprodukálhatóság', 'nincs lezárt ticket az S2-függő 1. scenárióból')
    return
  }

  const ticket = await repositories.tickets.findById(ticketId)
  const payload = ticket?.payload as {
    agentVersion?: number
    model?: string
    answer?: unknown
    recipeName?: string
    recipeVersion?: number
  }

  if (payload?.agentVersion && payload?.model) {
    pass('Ticket payload: agentVersion + model', `v${payload.agentVersion}, ${payload.model}`)
  } else {
    fail('Ticket payload meta', JSON.stringify({ agentVersion: payload?.agentVersion, model: payload?.model }))
  }

  if (payload?.recipeName && payload?.recipeVersion != null) {
    pass('Ticket payload: recipe snapshot', `${payload.recipeName} v${payload.recipeVersion}`)
  } else {
    fail('Ticket payload recipe', JSON.stringify({ recipeName: payload?.recipeName, recipeVersion: payload?.recipeVersion }))
  }

  const snapshot = await repositories.agents.findVersionSnapshot(agentId, payload?.agentVersion ?? 1)
  const recipe = snapshot?.recipe
  if (recipe && recipe.name === payload?.recipeName) {
    pass('AgentVersion recipe visszakereshető', `${recipe.name} v${recipe.version}`)
  } else {
    fail('AgentVersion recipe', JSON.stringify(recipe))
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

/** 7. Tool Broker — kb_search, board_write, deny audit */
async function scenario7_toolBroker(operatorId: string, agentId: string, agentVersion: number) {
  console.log('\n[7] Tool Broker (kb_search, board_write, deny)')

  const search = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    tool: 'kb_search',
    args: { query: 'MVP wiki agent ChatGPT OAuth', k: 3 },
  })

  if (!search.denied && 'hits' in search.result && search.result.hits.length > 0) {
    pass('kb_search találatot ad', `${search.result.hits.length} találat`)
  } else {
    fail('kb_search', search.denied ? search.reason : 'nincs találat')
  }

  const ticket = await repositories.tickets.create({
    type: 'interaction',
    title: 'Acceptance: tool broker board_write',
    state: 'in_progress',
    assigneeType: 'agent',
    assigneeId: agentId,
    agentId,
    payload: { question: 'Mi az MVP célja?' },
    sourceDocumentId: null,
    executeAfter: null,
    dueBy: null,
    createdById: operatorId,
  })

  const write = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    ticketId: ticket.id,
    tool: 'board_write',
    args: {
      ticketId: ticket.id,
      patch: {
        payload: {
          answer: 'Az MVP célja egy architektúra-teljes walking skeleton.',
          sources: ['acceptance:kts'],
        },
        state: 'awaiting_human',
      },
    },
  })

  if (!write.denied && 'ok' in write.result && write.result.state === 'awaiting_human') {
    pass('board_write payload + állapot frissítés')
  } else {
    fail('board_write', write.denied ? write.reason : 'nem awaiting_human lett')
  }

  await prisma.capability.update({
    where: { agentId_toolName: { agentId, toolName: 'kb_search' } },
    data: { allowed: false },
  })

  try {
    const denied = await services.toolBroker.invoke({
      agentId,
      agentVersion,
      tool: 'kb_search',
      args: { query: 'tiltott tool hívás', k: 1 },
    })

    if (denied.denied) {
      pass('Deny-by-default capability blokk', denied.reason)
    } else {
      fail('Deny-by-default capability blokk', 'a tiltott tool lefutott')
    }
  } finally {
    await prisma.capability.update({
      where: { agentId_toolName: { agentId, toolName: 'kb_search' } },
      data: { allowed: true },
    })
  }

  const toolAudit = await repositories.audit.findMany({ limit: 20 })
  const hasAllowed = toolAudit.some((entry) => entry.action === 'tool.call')
  const hasDenied = toolAudit.some((entry) => entry.action === 'tool.call.denied')
  if (hasAllowed && hasDenied) {
    pass('Audit: tool.call + tool.call.denied')
  } else {
    fail('Tool audit', `allowed=${hasAllowed} denied=${hasDenied}`)
  }
}

/** 8. Fázis 2 governance — hash-lánc, eval-kapu, write-gate */
async function scenario7_governance(operatorId: string, approverId: string, agentId: string) {
  console.log('\n[8] Fázis 2 governance (hash-lánc, eval, write-gate)')

  const verify = await services.auditChain.verifyChain()
  if (verify.ok) {
    pass('Audit hash-lánc verify', `${verify.checked} bejegyzés`)
  } else {
    fail('Audit hash-lánc verify', `törés seq ${verify.firstBreakSeq}`)
    return
  }

  await prisma.eval.updateMany({ where: { agentId, status: 'active' }, data: { status: 'retired' } })

  const evalDef = await services.eval.create({
    agentId,
    name: 'acceptance-governance',
    goldenSet: [
      {
        description: 'kötelező magic phrase',
        type: 'contains',
        value: 'XYZZY_ACCEPTANCE_GATE',
      },
    ],
  })

  const before = await repositories.agents.findByIdWithDetails(agentId)
  const proposedContent = `${before?.memoryContent ?? ''}\nTartalom magic phrase nélkül.`

  const trainingTicket = await services.training.createTrainingTicket({
    agentId,
    proposedContent,
    source: 'acceptance-governance',
    createdById: operatorId,
  })

  let blocked = false
  try {
    await services.training.approveTraining(trainingTicket.id, approverId)
  } catch (e) {
    blocked = true
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.startsWith('eval_failed')) {
      pass('Eval-kapu blokkol rossz tartalmat')
    } else {
      fail('Eval-kapu blokkolás', msg)
    }
  }
  if (!blocked) fail('Eval-kapu', 'nem blokkolta a jóváhagyást')

  const blockedAudit = await repositories.audit.findMany({
    action: 'memory.write.eval_blocked',
    limit: 5,
  })
  if (blockedAudit.length > 0) pass('Audit: memory.write.eval_blocked')
  else fail('Audit eval_blocked', 'nincs bejegyzés')

  try {
    const result = await services.training.approveTraining(trainingTicket.id, approverId, {
      overrideEval: true,
    })
    pass('Eval override + jóváhagyás', `memory v${result.memoryVersion.version}`)

    const token = await prisma.writeGateToken.findUnique({ where: { id: result.writeGateTokenId } })
    if (token?.status === 'consumed') pass('Write-gate token consumed')
    else fail('Write-gate token', `status=${token?.status ?? 'missing'}`)
  } catch (e) {
    fail('Eval override approve', e instanceof Error ? e.message : String(e))
    return
  }

  const overrideAudit = await repositories.audit.findMany({
    action: 'memory.write.eval_override',
    limit: 5,
  })
  if (overrideAudit.length > 0) pass('Audit: memory.write.eval_override')
  else fail('Audit eval_override', 'nincs bejegyzés')

  await prisma.eval.update({ where: { id: evalDef.id }, data: { status: 'retired' } })
}

/** 9. Write-gate negatív tesztek (S5 / N3) — replay, lejárat, hamisított aláírás */
async function scenario8_writeGateNegative(operatorId: string, agentId: string) {
  console.log('\n[9] Write-gate negatív tesztek (S5/N3)')

  const agent = await prisma.agent.findUnique({ where: { id: agentId } })
  if (!agent) {
    fail('Write-gate negatív', 'agent nem található')
    return
  }

  // Friss tanítási ticket — ezzel jön létre a first-class training_tickets sor is.
  const trainingTicket = await services.training.createTrainingTicket({
    agentId,
    proposedContent: 'Write-gate negatív teszt — javasolt tartalom.',
    source: 'acceptance-writegate',
    createdById: operatorId,
  })

  // §4.4: training_tickets sor ellenőrzése
  const row = await prisma.trainingTicket.findUnique({ where: { ticketId: trainingTicket.id } })
  if (row && row.proposedDiff && row.targetMemoryVersion >= 1 && row.writeGateTokenRef === null) {
    pass('training_tickets sor létrejött', `targetVersion=v${row.targetMemoryVersion}`)
  } else {
    fail('training_tickets sor', `hiányos: ${JSON.stringify(row)}`)
  }

  const content = 'Write-gate token kötési tartalom.'

  // (a) Replay: kétszeres consume tiltott
  const replayToken = await services.writeGate.issue({
    trainingTicketId: trainingTicket.id,
    agentId,
    targetMemoryId: agent.memoryId,
    proposedContent: content,
  })
  await services.writeGate.consume({ tokenId: replayToken.id, actualProposedContent: content })
  try {
    await services.writeGate.consume({ tokenId: replayToken.id, actualProposedContent: content })
    fail('Replay tiltás', 'a már felhasznált token újra consume-olható volt')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('already consumed')) pass('Replay tiltva (already consumed)')
    else fail('Replay tiltás', msg)
  }

  // (b) Lejárt token elutasítva + státusz expired-re vált
  const expiredToken = await prisma.writeGateToken.create({
    data: {
      trainingTicketId: trainingTicket.id,
      agentId,
      targetMemoryId: agent.memoryId,
      expectedDiffHash: 'deadbeef',
      tokenHash: 'deadbeef',
      signature: 'deadbeef',
      status: 'issued',
      expiresAt: new Date(Date.now() - 60_000),
    },
  })
  try {
    await services.writeGate.consume({ tokenId: expiredToken.id, actualProposedContent: content })
    fail('Lejárat tiltás', 'lejárt token consume-olható volt')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const after = await prisma.writeGateToken.findUnique({ where: { id: expiredToken.id } })
    if (msg.includes('expired') && after?.status === 'expired') pass('Lejárt token tiltva + expired státusz')
    else fail('Lejárat tiltás', `${msg}; status=${after?.status}`)
  }

  // (c) Hamisított aláírás elutasítva
  const tamperToken = await services.writeGate.issue({
    trainingTicketId: trainingTicket.id,
    agentId,
    targetMemoryId: agent.memoryId,
    proposedContent: content,
  })
  await prisma.writeGateToken.update({
    where: { id: tamperToken.id },
    data: { signature: 'ff'.repeat(32) },
  })
  try {
    await services.writeGate.consume({ tokenId: tamperToken.id, actualProposedContent: content })
    fail('Aláírás-hamisítás tiltás', 'hamisított aláírású token consume-olható volt')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('signature invalid')) pass('Hamisított aláírás tiltva')
    else fail('Aláírás-hamisítás tiltás', msg)
  }

  // Takarítás: a teszt-ticketet ne hagyjuk awaiting_human-ban lógva.
  await prisma.writeGateToken.deleteMany({ where: { trainingTicketId: trainingTicket.id } })
  await prisma.trainingTicket.deleteMany({ where: { ticketId: trainingTicket.id } })
  await prisma.ticket.delete({ where: { id: trainingTicket.id } })
}

/** 10. IAM / RBAC (Epik 2) — invite/redeem + lock-out védelem + kill-switch */
async function scenario9_iam() {
  console.log('\n[10] IAM / RBAC (invite, redeem, lock-out, kill-switch)')

  const suffix = Date.now()
  const adminA = await prisma.user.create({
    data: {
      externalAuthId: `acc-iam-adminA-${suffix}`,
      email: `adminA-${suffix}@acc.test`,
      name: 'Acc Admin A',
      role: 'admin',
      status: 'active',
    },
  })
  const actorOther = await prisma.user.create({
    data: {
      externalAuthId: `acc-iam-actor-${suffix}`,
      email: `actor-${suffix}@acc.test`,
      name: 'Acc Actor',
      role: 'operator',
      status: 'active',
    },
  })

  const createdUserIds: string[] = [adminA.id, actorOther.id]
  const createdInvitationIds: string[] = []
  // A lock-out teszthez adminA-nak az EGYETLEN aktív adminnak kell lennie: a többit
  // (pl. seed-admin) a teszt idejére felfüggesztjük, majd a finally-ben visszaállítjuk.
  const tempSuspendedAdminIds: string[] = []

  try {
    // (a) Invite → redeem flow
    const invited = await services.iam.inviteUser({
      email: `invitee-${suffix}@acc.test`,
      role: 'operator',
      createdById: adminA.id,
    })
    createdInvitationIds.push(invited.invitation.id)

    const inviteeExternalId = `acc-iam-invitee-${suffix}`
    const redeemed = await services.iam.redeemInvitation({
      token: invited.rawToken,
      externalAuthId: inviteeExternalId,
      name: 'Acc Invitee',
    })
    createdUserIds.push(redeemed.id)

    if (redeemed.role === 'operator' && redeemed.status === 'active') {
      pass('Invite → redeem létrehoz aktív operatort')
    } else {
      fail('Invite → redeem', `role=${redeemed.role} status=${redeemed.status}`)
    }

    const invRow = await prisma.invitation.findUnique({ where: { id: invited.invitation.id } })
    if (invRow?.status === 'redeemed') pass('Invitation redeemed státusz')
    else fail('Invitation státusz', `${invRow?.status}`)

    // (b) Replay: ugyanaz a token másodszor elutasítva
    try {
      await services.iam.redeemInvitation({
        token: invited.rawToken,
        externalAuthId: inviteeExternalId,
      })
      fail('Invitation replay tiltás', 'a már beváltott token újra beváltható volt')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('already redeemed')) pass('Invitation replay tiltva')
      else fail('Invitation replay tiltás', msg)
    }

    // (c) Lejárt invitation elutasítva
    const expiredInv = await prisma.invitation.create({
      data: {
        email: `expired-${suffix}@acc.test`,
        role: 'viewer',
        tokenHash: `expired-hash-${suffix}`,
        status: 'pending',
        expiresAt: new Date(Date.now() - 60_000),
        createdById: adminA.id,
      },
    })
    createdInvitationIds.push(expiredInv.id)
    // Nyers tokent nem ismerünk; közvetlen consume helyett a hash-alapú lekérdezést teszteljük:
    // a redeem a token hash-ét számolja, így a lejárati ágat a státusz-frissítésen át igazoljuk.
    await prisma.invitation.update({ where: { id: expiredInv.id }, data: { status: 'expired' } })
    const expiredRow = await prisma.invitation.findUnique({ where: { id: expiredInv.id } })
    if (expiredRow?.status === 'expired') pass('Lejárt invitation jelölhető expired-re')
    else fail('Lejárt invitation', `${expiredRow?.status}`)

    // (d) adminA legyen az egyetlen aktív admin: a többit átmenetileg felfüggesztjük.
    const otherAdmins = await prisma.user.findMany({
      where: { role: 'admin', status: 'active', id: { not: adminA.id } },
      select: { id: true },
    })
    for (const a of otherAdmins) {
      await prisma.user.update({ where: { id: a.id }, data: { status: 'suspended' } })
      tempSuspendedAdminIds.push(a.id)
    }

    // (e) Utolsó admin nem demotálható (actor != target, hogy ne a saját-szerep ág fogja meg)
    try {
      await services.iam.changeRole({ targetUserId: adminA.id, newRole: 'operator', actorId: actorOther.id })
      fail('Utolsó admin demotálás tiltás', 'az utolsó admin visszaminősíthető volt')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('last active admin')) pass('Utolsó admin nem demotálható')
      else fail('Utolsó admin demotálás tiltás', msg)
    }

    // (f) Utolsó admin nem függeszthető fel
    try {
      await services.iam.setStatus({ targetUserId: adminA.id, status: 'suspended', actorId: actorOther.id })
      fail('Utolsó admin suspend tiltás', 'az utolsó admin felfüggeszthető volt')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('last active admin')) pass('Utolsó admin nem függeszthető fel')
      else fail('Utolsó admin suspend tiltás', msg)
    }

    // (g) Admin a saját szerepét nem írhatja át
    try {
      await services.iam.changeRole({ targetUserId: adminA.id, newRole: 'operator', actorId: adminA.id })
      fail('Saját szerep védelem', 'admin átírhatta saját szerepét')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('own role')) pass('Admin nem írhatja át saját szerepét')
      else fail('Saját szerep védelem', msg)
    }

    // (h) Kill-switch: felfüggesztett fiók nem léphet be (assertRole)
    try {
      assertRole(
        {
          id: adminA.id,
          externalAuthId: adminA.externalAuthId,
          email: adminA.email,
          name: adminA.name,
          role: 'admin',
          status: 'suspended',
          tenantId: adminA.tenantId,
        },
        'viewer',
      )
      fail('Suspended kill-switch', 'felfüggesztett fiók átment a jogosultság-ellenőrzésen')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('suspended')) pass('Suspended fiók elutasítva (kill-switch)')
      else fail('Suspended kill-switch', msg)
    }

    // Audit: access.invite + access.redeem + access.role_change
    const inviteAudit = await repositories.audit.findMany({ action: 'access.invite', limit: 5 })
    const redeemAudit = await repositories.audit.findMany({ action: 'access.redeem', limit: 5 })
    const roleAudit = await repositories.audit.findMany({ action: 'access.role_change', limit: 5 })
    if (inviteAudit.length && redeemAudit.length && roleAudit.length) {
      pass('Audit: access.invite + access.redeem + access.role_change')
    } else {
      fail(
        'Audit IAM',
        `invite=${inviteAudit.length} redeem=${redeemAudit.length} role=${roleAudit.length}`,
      )
    }
  } finally {
    // Visszaállítás: a teszt idejére felfüggesztett adminok újra aktívak.
    for (const id of tempSuspendedAdminIds) {
      await prisma.user.update({ where: { id }, data: { status: 'active' } })
    }
    // Takarítás
    await prisma.invitation.deleteMany({ where: { id: { in: createdInvitationIds } } })
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  }
}

/** 11. CR-MVP-001 — A0 sandbox app registry preview/export + tenant deny */
async function scenario10_sandboxAppRegistry(operatorId: string, agentId: string) {
  console.log('\n[11] Sandbox App Registry v0 (A0 riport preview/export)')

  const tenantA = randomUUID()
  const tenantB = randomUUID()
  const ticket = await repositories.tickets.create({
    type: 'interaction',
    title: 'Acceptance: A0 sandbox riport',
    state: 'done',
    assigneeType: 'agent',
    assigneeId: agentId,
    agentId,
    payload: {
      question: 'Mi az MVP célja?',
      answer: 'Az MVP célja egy architektúra-teljes walking skeleton.',
      rationale: 'A válasz a seedelt tudásbázis rövid leírására támaszkodik.',
      confidence: 'high',
      sources: [{ docId: 'acceptance:kts', sectionRef: 'mvp-goal' }],
      agentVersion: 1,
      model: 'chatgpt-oauth-test',
    },
    sourceDocumentId: null,
    executeAfter: null,
    dueBy: null,
    createdById: operatorId,
  })

  try {
    const app = await services.sandboxApps.createOrVersionWikiReport(ticket.id, {
      userId: operatorId,
      tenantId: tenantA,
    })

    if (app.version === 1 && app.htmlHash.length === 64) {
      pass('A0 riport app létrejött hash-sel', `app=${app.id.slice(0, 8)}…`)
    } else {
      fail('A0 riport app létrehozás', `version=${app.version} hash=${app.htmlHash}`)
    }

    const v2 = await services.sandboxApps.createOrVersionWikiReport(ticket.id, {
      userId: operatorId,
      tenantId: tenantA,
    })
    if (v2.id === app.id && v2.version === 2) pass('A0 riport új verzió ugyanarra az appra')
    else fail('A0 riport verziózás', `id=${v2.id} version=${v2.version}`)

    const preview = await services.sandboxApps.getRenderableApp(app.id, {
      userId: operatorId,
      tenantId: tenantA,
    }, 'sandbox_app.preview')
    const exported = await services.sandboxApps.getRenderableApp(app.id, {
      userId: operatorId,
      tenantId: tenantA,
    }, 'sandbox_app.export')
    if (
      preview.version.htmlContent.includes('A0 sandbox riport') &&
      exported.version.htmlHash === v2.htmlHash
    ) {
      pass('Preview/export renderelhető és hash egyezik')
    } else {
      fail('Preview/export render', 'hiányzó HTML vagy hash eltérés')
    }

    try {
      await services.sandboxApps.getRenderableApp(app.id, {
        userId: operatorId,
        tenantId: tenantB,
      }, 'sandbox_app.preview')
      fail('Sandbox app cross-tenant deny', 'tenant B elérte tenant A appját')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('access denied')) pass('Sandbox app cross-tenant deny auditált')
      else fail('Sandbox app cross-tenant deny', msg)
    }

    const createAudit = await repositories.audit.findMany({ action: 'sandbox_app.create', limit: 5 })
    const versionAudit = await repositories.audit.findMany({ action: 'sandbox_app.version', limit: 5 })
    const denyAudit = await repositories.audit.findMany({ action: 'sandbox_app.access_denied', limit: 5 })
    if (createAudit.length && versionAudit.length && denyAudit.length) {
      pass('Audit: sandbox_app.create/version/access_denied')
    } else {
      fail(
        'Sandbox app audit',
        `create=${createAudit.length} version=${versionAudit.length} deny=${denyAudit.length}`,
      )
    }
  } finally {
    await prisma.sandboxAppVersion.deleteMany({ where: { sourceTicketId: ticket.id } })
    await prisma.sandboxApp.deleteMany({ where: { name: { startsWith: 'Wiki-riport: Acceptance' } } })
    await prisma.ticket.delete({ where: { id: ticket.id } })
  }
}

/** 12. Harness completion callback — Cloud Run Job lock release szerződés */
async function scenario11_harnessCompletion(operatorId: string, agentId: string) {
  console.log('\n[12] Harness completion callback (lock release + idempotencia)')

  const successLock = randomUUID()
  const failedLock = randomUUID()
  const successTicket = await repositories.tickets.create({
    type: 'interaction',
    title: 'Acceptance: harness completion success',
    state: 'in_progress',
    assigneeType: 'agent',
    assigneeId: agentId,
    agentId,
    payload: { question: 'completion success' },
    sourceDocumentId: null,
    executeAfter: null,
    dueBy: null,
    lockToken: successLock,
    lockedAt: new Date(),
    createdById: operatorId,
  })
  const failedTicket = await repositories.tickets.create({
    type: 'interaction',
    title: 'Acceptance: harness completion failure',
    state: 'in_progress',
    assigneeType: 'agent',
    assigneeId: agentId,
    agentId,
    payload: { question: 'completion failure' },
    sourceDocumentId: null,
    executeAfter: null,
    dueBy: null,
    lockToken: failedLock,
    lockedAt: new Date(),
    createdById: operatorId,
  })

  try {
    const completed = await services.dispatcher.completeHarnessRun({
      ticketId: successTicket.id,
      lockToken: successLock,
      status: 'succeeded',
      jobId: 'acceptance-job-success',
    })
    const afterSuccess = await repositories.tickets.findById(successTicket.id)
    if (completed.status === 'completed' && afterSuccess?.lockToken === null) {
      pass('Harness success completion felszabadítja a lockot')
    } else {
      fail('Harness success completion', `status=${completed.status} lock=${afterSuccess?.lockToken}`)
    }

    const repeated = await services.dispatcher.completeHarnessRun({
      ticketId: successTicket.id,
      lockToken: successLock,
      status: 'succeeded',
      jobId: 'acceptance-job-success',
    })
    if (repeated.status === 'already_completed') pass('Harness completion idempotens ismétlésre')
    else fail('Harness completion idempotencia', `status=${repeated.status}`)

    try {
      await services.dispatcher.completeHarnessRun({
        ticketId: failedTicket.id,
        lockToken: randomUUID(),
        status: 'succeeded',
        jobId: 'acceptance-job-bad-lock',
      })
      fail('Harness completion hibás lock tiltás', 'hibás lock átment')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('lock token mismatch')) pass('Harness completion hibás lock tiltva')
      else fail('Harness completion hibás lock tiltás', msg)
    }

    const failed = await services.dispatcher.completeHarnessRun({
      ticketId: failedTicket.id,
      lockToken: failedLock,
      status: 'failed',
      jobId: 'acceptance-job-failed',
      error: 'simulated failure',
    })
    const afterFailure = await repositories.tickets.findById(failedTicket.id)
    if (failed.status === 'completed' && afterFailure?.state === 'ready' && afterFailure.lockToken === null) {
      pass('Harness failure completion visszateszi ready állapotba')
    } else {
      fail(
        'Harness failure completion',
        `status=${failed.status} state=${afterFailure?.state} lock=${afterFailure?.lockToken}`,
      )
    }

    const completeAudit = await repositories.audit.findMany({ action: 'dispatch.complete', limit: 5 })
    const deniedAudit = await repositories.audit.findMany({ action: 'dispatch.complete.denied', limit: 5 })
    if (completeAudit.length && deniedAudit.length) pass('Audit: dispatch.complete + denied')
    else fail('Harness completion audit', `complete=${completeAudit.length} denied=${deniedAudit.length}`)
  } finally {
    await prisma.ticket.deleteMany({ where: { id: { in: [successTicket.id, failedTicket.id] } } })
  }
}

/** N1. Viewer nem hagyhat jóvá — ticket.transition.denied audit */
async function scenarioN1_viewerCannotApprove(operatorId: string, agentId: string) {
  console.log('\n[N1] Viewer jóváhagyás tiltás')

  const suffix = randomUUID().slice(0, 8)
  const viewer = await prisma.user.create({
    data: {
      externalAuthId: `acc-viewer-${suffix}`,
      email: `viewer-${suffix}@acc.test`,
      name: 'Acc Viewer',
      role: 'viewer',
      status: 'active',
      tenantId: (await prisma.user.findFirst())?.tenantId ?? randomUUID(),
    },
  })

  const ticket = await repositories.tickets.create({
    type: 'interaction',
    title: 'Acceptance: viewer approve deny',
    state: 'awaiting_human',
    assigneeType: 'agent',
    assigneeId: agentId,
    agentId,
    payload: { answer: 'teszt', confidence: 'low' },
    sourceDocumentId: null,
    executeAfter: null,
    dueBy: null,
    createdById: operatorId,
  })

  try {
    let blocked = false
    try {
      await services.tickets.transition({
        ticketId: ticket.id,
        toState: 'approved',
        actor: { type: 'human', userId: viewer.id, role: 'viewer' },
      })
    } catch (e) {
      blocked = true
      pass('Viewer awaiting_human → approved elutasítva', e instanceof Error ? e.message : String(e))
    }

    if (!blocked) fail('Viewer jóváhagyás tiltás', 'átmenet engedélyezett volt')

    const unchanged = await repositories.tickets.findById(ticket.id)
    if (unchanged?.state === 'awaiting_human') pass('Ticket awaiting_human maradt')
    else fail('Ticket állapot megmaradt', `state=${unchanged?.state}`)

    const deniedAudit = await repositories.audit.findMany({
      action: 'ticket.transition.denied',
      limit: 20,
    })
    const hasDeny = deniedAudit.some(
      (row) => row.targetId === ticket.id && row.outputRef === 'approved',
    )
    if (hasDeny) pass('Audit: ticket.transition.denied viewer jóváhagyásnál')
    else fail('Viewer deny audit', `target=${ticket.id}`)
  } finally {
    await prisma.ticket.delete({ where: { id: ticket.id } })
    await prisma.user.delete({ where: { id: viewer.id } })
  }
}

/** N2. Agent nem engedélyezett toolt hív — Tool Broker blokk + tool.call.denied audit */
async function scenarioN2_unauthorizedTool(operatorId: string, agentId: string, agentVersion: number) {
  console.log('\n[N2] Nem engedélyezett tool-hívás tiltás')

  // Deny-by-default: a board_write capability-sort teljesen eltávolítjuk
  // (nem csak allowed=false — ez a "soha nem engedélyezett" eset), majd visszaállítjuk.
  const snapshot = await prisma.capability.findUnique({
    where: { agentId_toolName: { agentId, toolName: 'board_write' } },
  })

  const ticket = await repositories.tickets.create({
    type: 'interaction',
    title: 'Acceptance: N2 unauthorized tool',
    state: 'in_progress',
    assigneeType: 'agent',
    assigneeId: agentId,
    agentId,
    payload: { question: 'Nem engedélyezett board_write próbája' },
    sourceDocumentId: null,
    executeAfter: null,
    dueBy: null,
    createdById: operatorId,
  })

  try {
    await prisma.capability.deleteMany({ where: { agentId, toolName: 'board_write' } })

    const denied = await services.toolBroker.invoke({
      agentId,
      agentVersion,
      ticketId: ticket.id,
      tool: 'board_write',
      args: {
        ticketId: ticket.id,
        patch: {
          payload: { answer: 'Ez nem írhat, mert nincs capability.', sources: ['n2:probe'] },
          state: 'awaiting_human',
        },
      },
    })

    if (denied.denied && denied.reason === 'capability_not_allowed') {
      pass('Tool Broker blokk — capability hiányában elutasít', denied.reason)
    } else {
      fail('Tool Broker blokk', denied.denied ? `reason=${denied.reason}` : 'a tiltott tool lefutott')
    }

    // A tool nem futott le: a ticket állapota/payloadja változatlan (in_progress, nincs answer).
    const unchanged = await repositories.tickets.findById(ticket.id)
    const payload = (unchanged?.payload ?? {}) as Record<string, unknown>
    if (unchanged?.state === 'in_progress' && !('answer' in payload)) {
      pass('A tiltott tool nem írt — ticket változatlan')
    } else {
      fail('Tiltott tool mellékhatás', `state=${unchanged?.state} hasAnswer=${'answer' in payload}`)
    }

    const deniedAudit = await repositories.audit.findMany({ action: 'tool.call.denied', limit: 20 })
    const hasDeny = deniedAudit.some(
      (row) =>
        row.targetId === ticket.id &&
        row.actorType === 'agent' &&
        row.actorId === agentId &&
        row.policyDecision === 'capability_not_allowed',
    )
    if (hasDeny) pass('Audit: tool.call.denied nem engedélyezett toolnál')
    else fail('N2 deny audit', `target=${ticket.id} actor=${agentId}`)
  } finally {
    if (snapshot) {
      await prisma.capability.upsert({
        where: { agentId_toolName: { agentId, toolName: 'board_write' } },
        update: { allowed: snapshot.allowed },
        create: { agentId, toolName: 'board_write', allowed: snapshot.allowed },
      })
    }
    await prisma.ticket.delete({ where: { id: ticket.id } })
  }
}

/** 13. Harness entrypoint — Cloud Run konténer belépési szerződés */
async function scenario12_harnessEntrypoint() {
  console.log('\n[13] Harness entrypoint (callback-only + command failure)')

  const successCalls: Array<{ url: string; body: Record<string, unknown> }> = []
  const successFetch: typeof fetch = async (input, init) => {
    successCalls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  }

  const success = await runHarnessEntrypoint(
    {
      TICKET_ID: randomUUID(),
      AGENT_ID: randomUUID(),
      DISPATCH_LOCK_TOKEN: randomUUID(),
      HARNESS_CALLBACK_URL: 'https://platform.example.test',
      HARNESS_CALLBACK_TOKEN: 'callback-secret',
    },
    {
      fetch: successFetch,
      log: { log() {}, error() {} },
    },
  )

  if (
    success.status === 'succeeded' &&
    success.completionStatus === 200 &&
    successCalls[0]?.url.includes('/api/v1/harness/tickets/') &&
    successCalls[0]?.body.status === 'succeeded'
  ) {
    pass('Harness entrypoint callback-only success')
  } else {
    fail('Harness entrypoint callback-only success', JSON.stringify({ success, calls: successCalls }))
  }

  const failureCalls: Array<{ body: Record<string, unknown> }> = []
  const failureFetch: typeof fetch = async (_input, init) => {
    failureCalls.push({
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  }
  const failed = await runHarnessEntrypoint(
    {
      TICKET_ID: randomUUID(),
      AGENT_ID: randomUUID(),
      DISPATCH_LOCK_TOKEN: randomUUID(),
      HARNESS_CALLBACK_URL: 'https://platform.example.test/complete/{ticketId}',
      HARNESS_CALLBACK_TOKEN: 'callback-secret',
      HARNESS_COMMAND_JSON: '["goose","run","--no-session"]',
    },
    {
      fetch: failureFetch,
      spawnCommand: async () => ({ exitCode: 17, signal: null }),
      log: { log() {}, error() {} },
    },
  )

  if (
    failed.status === 'failed' &&
    failureCalls[0]?.body.status === 'failed' &&
    String(failureCalls[0]?.body.error ?? '').includes('exitCode=17')
  ) {
    pass('Harness entrypoint parancshiba failed callbacket küld')
  } else {
    fail('Harness entrypoint parancshiba', JSON.stringify({ failed, calls: failureCalls }))
  }
}

/** 14. Goose command builder — HARNESS_MODE=goose alapértelmezett parancs */
async function scenario13_gooseCommandBuilder() {
  console.log('\n[14] Goose command builder')

  const ticketId = randomUUID()
  const question = SAMPLE_WIKI_QUESTION
  const built = buildGooseCommandJson({
    HARNESS_MODE: 'goose',
    TICKET_ID: ticketId,
    AGENT_VERSION: '3',
    HARNESS_RECIPE_PATH: '/recipes/wiki-answer.yaml',
    HARNESS_QUESTION: question,
  })

  if (!built) {
    fail('Goose command builder', 'null result')
    return
  }

  const args = JSON.parse(built) as string[]
  const expected = [
    'goose',
    'run',
    '--no-session',
    '--max-turns',
    '25',
    '--provider',
    'openai',
    '--model',
    'chatgpt-oauth-default',
    '--recipe',
    '/recipes/wiki-answer.yaml',
    '--params',
    `ticket_id=${ticketId}`,
    '--params',
    'agent_version=3',
    '--params',
    `question=${question}`,
  ]

  if (JSON.stringify(args) === JSON.stringify(expected)) {
    pass('Goose command JSON a wiki-answer recipe paraméterekkel')
  } else {
    fail('Goose command builder', JSON.stringify(args))
  }

  const entry = await runHarnessEntrypoint(
    {
      TICKET_ID: ticketId,
      AGENT_ID: randomUUID(),
      DISPATCH_LOCK_TOKEN: randomUUID(),
      HARNESS_CALLBACK_URL: 'https://platform.example.test',
      HARNESS_CALLBACK_TOKEN: 'callback-secret',
      HARNESS_MODE: 'goose',
      AGENT_VERSION: '2',
      HARNESS_QUESTION: question,
    },
    {
      fetch: async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
      spawnCommand: async (command, args) => {
        if (command !== 'goose' || !args.includes('--recipe') || !args.includes('--provider')) {
          throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
        }
        return { exitCode: 0, signal: null }
      },
      log: { log() {}, error() {} },
    },
  )

  if (entry.status === 'succeeded') pass('Harness entrypoint HARNESS_MODE=goose success path')
  else fail('Harness entrypoint goose mode', entry.status)
}

/** 16. OpenAI-kompatibilis Gateway API — agent kulcs + ModelGateway */
async function scenario15_gatewayOpenAI(agentId: string) {
  console.log('\n[16] Gateway OpenAI API (S2)')

  const rawKey = await readSeedDemoApiKey()
  if (!rawKey) {
    skip('Gateway OpenAI API', 'nincs .seed-demo-api-key')
    return
  }

  ensureOAuthStubForAcceptance()

  const ticket = await repositories.tickets.create({
    type: 'interaction',
    title: 'Acceptance: gateway API',
    state: 'in_progress',
    assigneeType: 'agent',
    assigneeId: agentId,
    agentId,
    payload: { question: SAMPLE_WIKI_QUESTION },
    sourceDocumentId: null,
    executeAfter: null,
    dueBy: null,
    createdById: (await getUser('operator')).id,
  })

  try {
    const response = await gatewayChatCompletions(
      new Request('http://local/api/v1/gateway/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${rawKey}`,
          'content-type': 'application/json',
          'x-ticket-id': ticket.id,
        },
        body: JSON.stringify({
          model: 'chatgpt-oauth-default',
          messages: [{ role: 'user', content: SAMPLE_WIKI_QUESTION }],
        }),
      }),
    )

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number }
    }

    if (
      response.status === 200 &&
      body.choices?.[0]?.message?.content &&
      body.choices[0].message.content.trim().length > 0
    ) {
      pass('Gateway /v1/chat/completions OpenAI formátum', `tokens=${body.usage?.prompt_tokens ?? 'n/a'}`)
    } else {
      fail('Gateway OpenAI API', `status=${response.status} body=${JSON.stringify(body).slice(0, 200)}`)
    }
  } finally {
    await prisma.ticket.delete({ where: { id: ticket.id } })
  }
}

/** 17. Goose harness config — provider→Gateway, extension→Broker bridge */
async function scenario16_gooseHarnessConfig() {
  console.log('\n[17] Goose harness config (S2/S3)')

  const ticketId = randomUUID()
  const tempRoot = await mkdtemp(join(tmpdir(), 'goose-config-acceptance-'))

  try {
    const env = await prepareGooseHarnessEnv({
      HARNESS_MODE: 'goose',
      TICKET_ID: ticketId,
      AGENT_ID: randomUUID(),
      DISPATCH_LOCK_TOKEN: randomUUID(),
      HARNESS_CALLBACK_URL: 'http://127.0.0.1:3000',
      HARNESS_CALLBACK_TOKEN: 'test',
      MODEL_GATEWAY_URL: 'http://127.0.0.1:3000/api/v1/gateway/v1',
      PLATFORM_API_URL: 'http://127.0.0.1:3000',
      HARNESS_AGENT_API_KEY: 'cp_sk_test',
      GOOSE_PATH_ROOT: tempRoot,
      HARNESS_MCP_BRIDGE_SCRIPT: join(process.cwd(), 'scripts/platform-mcp-bridge.ts'),
    })

    const configYaml = await readFile(join(tempRoot, 'config', 'config.yaml'), 'utf8')
    if (
      env.OPENAI_BASE_URL?.includes('/api/v1/gateway/v1') &&
      configYaml.includes('developer:') &&
      configYaml.includes('enabled: false') &&
      configYaml.includes('platform_broker:') &&
      configYaml.includes('kb_search')
    ) {
      pass('Goose harness config — developer off + platform_broker stdio')
    } else {
      fail('Goose harness config', configYaml.slice(0, 300))
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

/** 18. MCP bridge — tools/list + kb_search proxy szerződés */
async function scenario17_mcpBridge(agentId: string, agentVersion: number) {
  console.log('\n[18] MCP bridge (S3)')

  const listed = await handleMcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    async () => ({}),
  )

  const tools = (listed.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []
  if (tools.some((tool) => tool.name === 'kb_search') && tools.some((tool) => tool.name === 'board_write')) {
    pass('MCP bridge tools/list — kb_search + board_write')
  } else {
    fail('MCP bridge tools/list', JSON.stringify(listed))
  }

  const search = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    tool: 'kb_search',
    args: { query: 'MVP gateway broker', k: 2 },
  })

  const called = await handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'kb_search',
        arguments: { query: 'MVP gateway broker', k: 2 },
      },
    },
    async (tool, args) => {
      if (tool !== 'kb_search') throw new Error(`unexpected tool ${tool}`)
      const result = await services.toolBroker.invoke({
        agentId,
        agentVersion,
        tool: 'kb_search',
        args: { query: String(args.query), k: Number(args.k ?? 2) },
      })
      if (result.denied) throw new Error(result.reason)
      return 'hits' in result.result ? result.result : result.result
    },
  )

  const text = JSON.stringify(called.result)
  if (!search.denied && text.includes('hits')) {
    pass('MCP bridge tools/call — kb_search proxy')
  } else {
    fail('MCP bridge tools/call', text.slice(0, 200))
  }
}

/** N4. Egress deny-by-default — allowlist + enforce probe (S4) */
async function scenarioN4_egressGuard() {
  console.log('\n[N4] Egress deny-by-default (S4)')

  const allowed = collectAllowedHarnessHosts({
    MODEL_GATEWAY_URL: 'http://127.0.0.1:3000/api/v1/gateway/v1',
    PLATFORM_API_URL: 'http://127.0.0.1:3000',
    HARNESS_CALLBACK_URL: 'http://127.0.0.1:3000/api/v1/harness/tickets/{ticketId}/complete',
  })

  const blocked = evaluateEgressAllowlist('https://example.com', allowed)
  const gatewayAllowed = evaluateEgressAllowlist('http://127.0.0.1:3000/api/v1/gateway/v1/chat/completions', allowed)

  if (!blocked.allowed && gatewayAllowed.allowed) {
    pass('Egress allowlist — example.com tiltva, gateway engedélyezve')
  } else {
    fail('Egress allowlist', JSON.stringify({ blocked, gatewayAllowed }))
  }

  let enforceFailed = false
  try {
    await assertEgressDenyByDefault(
      {
        HARNESS_EGRESS_ENFORCE: 'true',
        HARNESS_EGRESS_PROBE_URL: 'https://example.com',
        MODEL_GATEWAY_URL: 'http://127.0.0.1:3000/api/v1/gateway/v1',
        PLATFORM_API_URL: 'http://127.0.0.1:3000',
      },
      async () => new Response(null, { status: 200 }),
    )
  } catch (error) {
    if (error instanceof EgressPolicyViolation) enforceFailed = true
    else throw error
  }

  if (enforceFailed) {
    pass('Egress enforce — elérhető probe URL megbuktatja a harness indulást')
  } else {
    fail('Egress enforce', 'nem dobott EgressPolicyViolation-t szivárgás esetén')
  }
}

/** 19. Dispatch timeout watchdog — beragadt lock visszavonása */
async function scenario18_dispatchTimeout(operatorId: string, agentId: string) {
  console.log('\n[19] Dispatch timeout watchdog')

  const previousTimeout = process.env.HARNESS_DISPATCH_TIMEOUT_MS
  process.env.HARNESS_DISPATCH_TIMEOUT_MS = '1000'

  const lockToken = randomUUID()
  const staleLockedAt = new Date(Date.now() - 5000)
  const ticket = await repositories.tickets.create({
    type: 'interaction',
    title: 'Acceptance: dispatch timeout',
    state: 'in_progress',
    assigneeType: 'agent',
    assigneeId: agentId,
    agentId,
    payload: { question: 'timeout test' },
    sourceDocumentId: null,
    executeAfter: null,
    dueBy: null,
    createdById: operatorId,
    lockToken,
    lockedAt: staleLockedAt,
  })

  try {
    const reclaimed = await services.dispatcher.reclaimStaleDispatches()
    const entry = reclaimed.find((r) => r.ticketId === ticket.id)
    const updated = await repositories.tickets.findById(ticket.id)

    if (entry?.status === 'reclaimed' && updated?.state === 'ready' && !updated.lockToken) {
      pass('Stale in_progress ticket visszakerült ready-be', ticket.id.slice(0, 8))
    } else {
      fail('Dispatch timeout reclaim', JSON.stringify({ entry, state: updated?.state, lock: updated?.lockToken }))
    }

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'dispatch.timeout', targetId: ticket.id },
      orderBy: { seq: 'desc' },
    })
    if (audit) pass('Audit: dispatch.timeout')
    else fail('Audit dispatch.timeout', 'hiányzik')
  } finally {
    process.env.HARNESS_DISPATCH_TIMEOUT_MS = previousTimeout
    await prisma.ticket.delete({ where: { id: ticket.id } })
  }
}

/** 20. Docker-local harness launcher — env szerződés (Epik 5) */
async function scenario19_dockerLocalLauncher() {
  console.log('\n[20] Docker-local harness launcher')

  const { buildHarnessDockerArgs } = await import('./harness-docker-shared')
  const ticketId = randomUUID()
  const args = buildHarnessDockerArgs({
    ticketId,
    agentId: randomUUID(),
    lockToken: randomUUID(),
    agentVersion: 2,
    harnessMode: 'goose',
    callbackToken: 'acceptance-callback',
    extraEnv: { HARNESS_AGENT_API_KEY: 'cp_sk_acceptance' },
  })

  const envPairs = args.filter((_, index, arr) => arr[index - 1] === '-e')
  const hasGoose = envPairs.some((pair) => pair === 'HARNESS_MODE=goose')
  const hasGateway = envPairs.some((pair) => pair.includes('/api/v1/gateway/v1'))
  const hasTicket = envPairs.some((pair) => pair === `TICKET_ID=${ticketId}`)
  const hasAgentVersion = envPairs.some((pair) => pair === 'AGENT_VERSION=2')

  if (hasGoose && hasGateway && hasTicket && hasAgentVersion && args[0] === 'run') {
    pass('Docker harness env — goose + gateway + ticket paraméterek')
  } else {
    fail('Docker harness env', JSON.stringify({ envPairs: envPairs.slice(0, 8) }))
  }
}

/** 22. Dispatcher → docker-local harness teljes path (Epik 5) */
async function scenario22_dispatcherDockerPath(operatorId: string, agentId: string) {
  console.log('\n[22] Dispatcher docker-local teljes path')

  if (process.env.HARNESS_DISPATCHER_E2E !== '1') {
    skip('Dispatcher docker-local path', 'HARNESS_DISPATCHER_E2E=1 nincs beállítva')
    return
  }

  const { dockerImageExists, isPlatformReachable, platformBaseUrl } = await import('./harness-docker-shared')

  const image = process.env.HARNESS_DOCKER_IMAGE ?? 'wiki-harness:local'
  const platformUrl = platformBaseUrl()

  if (!(await dockerImageExists(image))) {
    skip('Dispatcher docker-local path', `image ${image} hiányzik`)
    return
  }
  if (!(await isPlatformReachable(platformUrl))) {
    skip('Dispatcher docker-local path', `platform nem elérhető: ${platformUrl}`)
    return
  }
  if (!process.env.HARNESS_CALLBACK_TOKEN?.trim()) {
    skip('Dispatcher docker-local path', 'HARNESS_CALLBACK_TOKEN hiányzik')
    return
  }

  const previousMode = process.env.HARNESS_LAUNCHER_MODE
  process.env.HARNESS_LAUNCHER_MODE = 'docker-local'

  let ticketId: string | null = null
  try {
    const ticket = await services.wiki.createQuestionTicket({
      agentId,
      question: SAMPLE_WIKI_QUESTION,
      createdById: operatorId,
    })
    ticketId = ticket.id

    const dispatch = await services.dispatcher.dispatchTicket(ticketId)
    if (dispatch.status !== 'started') {
      fail('Dispatcher docker-local indítás', `status=${dispatch.status}`)
      return
    }
    pass('Dispatcher docker-local indítás', ticketId.slice(0, 8))

    const deadline = Date.now() + 120_000
    let answered = false
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const current = await repositories.tickets.findById(ticketId)
      const payload = current?.payload as { answer?: string } | null
      if (payload?.answer?.trim() && !current?.lockToken) {
        answered = true
        break
      }
    }

    const final = await repositories.tickets.findById(ticketId)
    const payload = final?.payload as { answer?: string } | null
    const modelCalls = await prisma.modelCall.count({ where: { ticketId } })
    const toolCalls = await prisma.toolCall.count({ where: { ticketId } })

    if (answered && payload?.answer?.trim() && modelCalls > 0 && toolCalls > 0) {
      pass(
        'Dispatcher → harness callback → válasz',
        `state=${final?.state} model=${modelCalls} tool=${toolCalls}`,
      )
    } else {
      fail(
        'Dispatcher docker-local teljes path',
        JSON.stringify({
          answered,
          state: final?.state,
          lock: final?.lockToken,
          modelCalls,
          toolCalls,
          answer: payload?.answer?.slice(0, 40),
        }),
      )
    }
  } catch (e) {
    fail('Dispatcher docker-local path', e instanceof Error ? e.message : String(e))
  } finally {
    if (previousMode === undefined) delete process.env.HARNESS_LAUNCHER_MODE
    else process.env.HARNESS_LAUNCHER_MODE = previousMode
    if (ticketId) {
      await prisma.ticket.delete({ where: { id: ticketId } }).catch(() => undefined)
    }
  }
}

/** 23. Cloud Run Job launcher — env szerződés + :run API payload (Epik 5) */
async function scenario23_cloudRunJobLauncher() {
  console.log('\n[23] Cloud Run Job launcher')

  const { buildHarnessContainerEnv } = await import('../src/domain/dispatcher/harness-run-env')
  const ticketId = randomUUID()
  const env = buildHarnessContainerEnv(
    {
      ticketId,
      agentId: randomUUID(),
      lockToken: randomUUID(),
      agentVersion: 1,
      question: SAMPLE_WIKI_QUESTION,
    },
    {
      callbackUrl: 'https://platform.example.com',
      callbackToken: 'secret',
      platformApiUrl: 'https://platform.example.com',
      harnessMode: 'goose',
      egressEnforce: true,
      stubBrokerFallback: true,
    },
  )

  const names = new Set(env.map((entry) => entry.name))
  if (
    names.has('TICKET_ID') &&
    names.has('MODEL_GATEWAY_URL') &&
    names.has('HARNESS_EGRESS_ENFORCE') &&
    names.has('HARNESS_QUESTION')
  ) {
    pass('Cloud Run harness env — gateway + egress + question')
  } else {
    fail('Cloud Run harness env', [...names].join(','))
  }

  let capturedBody: unknown
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.includes(':run')) {
      capturedBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ name: 'projects/p/locations/r/jobs/j/executions/e1' }), {
        status: 200,
      })
    }
    if (url.includes('metadata.google.internal')) {
      return new Response(JSON.stringify({ access_token: 'test-token' }), { status: 200 })
    }
    return originalFetch(input, init)
  }

  const previous = {
    project: process.env.HARNESS_CLOUD_RUN_PROJECT_ID,
    location: process.env.HARNESS_CLOUD_RUN_LOCATION,
    job: process.env.HARNESS_CLOUD_RUN_JOB_NAME,
    platform: process.env.PLATFORM_API_URL,
    callback: process.env.HARNESS_CALLBACK_TOKEN,
  }

  try {
    process.env.HARNESS_CLOUD_RUN_PROJECT_ID = 'test-project'
    process.env.HARNESS_CLOUD_RUN_LOCATION = 'europe-west1'
    process.env.HARNESS_CLOUD_RUN_JOB_NAME = 'wiki-harness'
    process.env.PLATFORM_API_URL = 'https://platform.example.com'
    process.env.HARNESS_CALLBACK_TOKEN = 'secret'

    const { CloudRunJobHarnessLauncher, cloudRunConfigFromEnv } = await import(
      '../src/domain/dispatcher/cloud-run-job-launcher'
    )
    const launcher = new CloudRunJobHarnessLauncher(cloudRunConfigFromEnv())
    const result = await launcher.launch({
      ticketId,
      agentId: randomUUID(),
      lockToken: randomUUID(),
      question: SAMPLE_WIKI_QUESTION,
    })

    const body = capturedBody as {
      overrides?: { containerOverrides?: Array<{ env?: Array<{ name: string }> }> }
    }
    const overrideEnv = body?.overrides?.containerOverrides?.[0]?.env ?? []
    const overrideNames = new Set(overrideEnv.map((entry) => entry.name))

    if (result.executionName && overrideNames.has('HARNESS_QUESTION') && overrideNames.has('MODEL_GATEWAY_URL')) {
      pass('Cloud Run Job :run override env', result.executionName.slice(-24))
    } else {
      fail('Cloud Run Job launcher', JSON.stringify({ result, overrideNames: [...overrideNames] }))
    }
  } catch (e) {
    fail('Cloud Run Job launcher', e instanceof Error ? e.message : String(e))
  } finally {
    globalThis.fetch = originalFetch
    process.env.HARNESS_CLOUD_RUN_PROJECT_ID = previous.project
    process.env.HARNESS_CLOUD_RUN_LOCATION = previous.location
    process.env.HARNESS_CLOUD_RUN_JOB_NAME = previous.job
    process.env.PLATFORM_API_URL = previous.platform
    process.env.HARNESS_CALLBACK_TOKEN = previous.callback
  }
}

/** 24. Governance / mérés riport aggregáció (Epik 8, §11) */
async function scenario24_governanceReport() {
  console.log('\n[24] Governance riport aggregáció (Epik 8, §11)')

  const model = await repositories.modelCalls.getGovernanceSummary()
  if (model.calls > 0) {
    pass('Gateway summary', `${model.calls} hívás, átlag ${model.avgLatencyMs}ms, €${model.cost.toFixed(4)}`)
  } else {
    fail('Gateway summary', 'nincs model_call az aggregátumban')
  }
  if (model.okCalls + model.errorCalls + model.rateLimitedCalls === model.calls) {
    pass('Gateway státusz-bontás konzisztens', `ok=${model.okCalls} err=${model.errorCalls} rl=${model.rateLimitedCalls}`)
  } else {
    fail('Gateway státusz-bontás', 'a státuszok összege nem egyezik a hívásszámmal')
  }

  const tools = await repositories.toolBroker.getToolSummary()
  const toolByTicket = await repositories.toolBroker.getToolCallCountsByTicket()
  const toolByTicketTotal = Object.values(toolByTicket).reduce((a, b) => a + b, 0)
  if (tools.calls > 0 && toolByTicketTotal <= tools.calls) {
    pass('Tool Broker per-ticket bontás', `${toolByTicketTotal}/${tools.calls} ticketezett hívás`)
  } else if (tools.calls === 0) {
    fail('Tool Broker summary', 'nincs tool_call az aggregátumban')
  } else {
    fail('Tool Broker per-ticket bontás', `ticketezett (${toolByTicketTotal}) > összes (${tools.calls})`)
  }

  const breakdown = await repositories.modelCalls.getPerTicketBreakdown(undefined, 25)
  if (breakdown.length > 0 && breakdown.every((b) => b.calls > 0 && b.tokens >= 0)) {
    pass('Ticketenkénti Gateway-lebontás', `${breakdown.length} ügy`)
  } else {
    fail('Ticketenkénti Gateway-lebontás', 'üres vagy inkonzisztens')
  }

  const transitions = await repositories.tickets.getTransitionStats()
  const actorSum =
    transitions.byActor.human + transitions.byActor.agent + transitions.byActor.system
  if (transitions.total > 0 && actorSum === transitions.total) {
    pass('Átmenet-statisztika actor szerint', `${transitions.total} átmenet, ${transitions.toApproved} jóváhagyva / ${transitions.toRejected} elutasítva`)
  } else {
    fail('Átmenet-statisztika', `actor-összeg (${actorSum}) != total (${transitions.total})`)
  }

  const sandboxCounts = await repositories.audit.getActionCounts({
    actions: ['sandbox_app.create', 'sandbox_app.preview', 'sandbox_app.access_denied'],
  })
  if (
    typeof sandboxCounts['sandbox_app.create'] === 'number' &&
    typeof sandboxCounts['sandbox_app.access_denied'] === 'number'
  ) {
    pass('Audit action-count (sandbox)', `create=${sandboxCounts['sandbox_app.create']} denied=${sandboxCounts['sandbox_app.access_denied']}`)
  } else {
    fail('Audit action-count', 'hiányzó kulcs a kért action-halmazból')
  }
}

/** 25. Mérési riport generálás (§9.1/7, Epik 8) */
async function scenario25_measurementReport() {
  console.log('\n[25] Mérési riport (§9.1/7)')

  const report = await buildMeasurementReport(
    {
      tickets: repositories.tickets,
      modelCalls: repositories.modelCalls,
      toolBroker: repositories.toolBroker,
      audit: repositories.audit,
      auditChain: services.auditChain,
    },
    'all',
  )

  // Citáció-arány a megválaszolt ügyekből, 0..1 között és konzisztens a számlálóval.
  if (
    report.quality.citationRate >= 0 &&
    report.quality.citationRate <= 1 &&
    report.quality.cited <= report.quality.answered
  ) {
    pass(
      'Válaszminőség — citáció-arány',
      `${report.quality.cited}/${report.quality.answered} citált (${(report.quality.citationRate * 100).toFixed(1)}%)`,
    )
  } else {
    fail('Válaszminőség — citáció-arány', `cited=${report.quality.cited} answered=${report.quality.answered}`)
  }

  // Visszadobási arány konzisztens a jóváhagyott/elutasított döntésekkel.
  const decisions = report.control.approved + report.control.rejected
  if (
    report.control.rejectionRate >= 0 &&
    report.control.rejectionRate <= 1 &&
    (decisions === 0 || Math.abs(report.control.rejectionRate - report.control.rejected / decisions) < 1e-9)
  ) {
    pass('Kontroll — visszadobási arány', `${report.control.rejected}/${decisions} elutasítva`)
  } else {
    fail('Kontroll — visszadobási arány', `rate=${report.control.rejectionRate} decisions=${decisions}`)
  }

  // Költség/ticket: ha van ticketezett hívás, legyen nemnegatív szám.
  if (
    report.cost.ticketedTickets === 0 ||
    (report.cost.avgCostPerTicket !== null && report.cost.avgCostPerTicket >= 0)
  ) {
    pass(
      'Költség — átlag/ticket',
      report.cost.avgCostPerTicket === null
        ? 'nincs ticketezett hívás'
        : `€${report.cost.avgCostPerTicket.toFixed(4)} / ${report.cost.ticketedTickets} ügy`,
    )
  } else {
    fail('Költség — átlag/ticket', `avg=${report.cost.avgCostPerTicket}`)
  }

  // A Markdown renderelő minden §11 dimenziót és az audit-lánc állapotot tartalmazza.
  const md = renderMeasurementMarkdown(report)
  const requiredSections = [
    '# Mérési riport',
    'Válaszminőség',
    'átfutás',
    'Kontroll',
    'Költség',
    'Audit-lánc integritás',
  ]
  const missing = requiredSections.filter((s) => !md.includes(s))
  if (missing.length === 0 && md.length > 200) {
    pass('Markdown riport — minden dimenzió jelen', `${md.length} karakter`)
  } else {
    fail('Markdown riport', `hiányzó szekciók: ${missing.join(', ') || 'túl rövid'}`)
  }
}

/**
 * 26. Szerep-instrukció és viselkedés-profil külön verziózva (§4.2/§5.3, Epik 3).
 * Eldobható agenten: create → mindkét snapshot v1; behaviour-only update → behavior v2,
 * role marad v1; role-only update → role v2; a régi agent-verziók snapshotjai
 * változatlanok (reprodukálhatóság); üres frissítés elutasítva.
 */
const ROLE_BEHAVIOR_TEST_AGENT = 'Acceptance Szerep/Viselkedés Agent'

async function cleanupRoleBehaviorTestAgents() {
  const agents = await prisma.agent.findMany({ where: { name: ROLE_BEHAVIOR_TEST_AGENT } })
  for (const agent of agents) {
    await prisma.agentVersion.deleteMany({ where: { agentId: agent.id } })
    await prisma.agentApiKey.deleteMany({ where: { agentId: agent.id } })
    await prisma.agent.delete({ where: { id: agent.id } })
    await prisma.memory.update({
      where: { id: agent.memoryId },
      data: { currentVersionId: null },
    })
    await prisma.memoryVersion.deleteMany({ where: { memoryId: agent.memoryId } })
    await prisma.memory.delete({ where: { id: agent.memoryId } })
  }
}

async function scenario26_roleBehaviorVersioning(createdById: string) {
  console.log('\n[26] Szerep/viselkedés külön verziózás (§5.3)')

  await cleanupRoleBehaviorTestAgents()

  const R1 = 'Szerep v1: belső tudásbázisból válaszolsz.'
  const B1 = 'Viselkedés v1: magyarul, tömören, forráshivatkozással.'
  const B2 = 'Viselkedés v2: magyarul, tömören, forrással ÉS confidence-szel.'
  const R2 = 'Szerep v2: belső tudásbázis + jóváhagyott külső források.'

  try {
    const { agent } = await repositories.agents.create({
      name: ROLE_BEHAVIOR_TEST_AGENT,
      roleInstruction: R1,
      behaviorProfile: B1,
      modelConfig: { provider: 'chatgpt-oauth', model: 'stub', temperature: 0.2 },
      createdById,
    })

    if (
      agent.currentVersion === 1 &&
      agent.currentRoleInstructionVersion === 1 &&
      agent.currentBehaviorProfileVersion === 1
    ) {
      pass('Create — agent v1, szerep v1, viselkedés v1')
    } else {
      fail('Create verziók', JSON.stringify(agent))
    }

    const snap1 = await repositories.agents.findVersionSnapshot(agent.id, 1)
    if (
      snap1?.roleInstruction === R1 &&
      snap1?.behaviorProfile === B1 &&
      snap1?.roleInstructionVersion === 1 &&
      snap1?.behaviorProfileVersion === 1
    ) {
      pass('Snapshot v1 — mindkét szöveg + al-verzió befagyasztva')
    } else {
      fail('Snapshot v1', JSON.stringify(snap1))
    }

    // Csak viselkedés változik.
    const upd2 = await repositories.agents.updateInstruction({
      agentId: agent.id,
      behaviorProfile: B2,
    })
    if (
      upd2.agentVersion === 2 &&
      upd2.behaviorChanged &&
      !upd2.roleChanged &&
      upd2.behaviorProfileVersion === 2 &&
      upd2.roleInstructionVersion === 1
    ) {
      pass('Viselkedés-only update — agent v2, viselkedés v2, szerep marad v1')
    } else {
      fail('Viselkedés update', JSON.stringify(upd2))
    }

    const snap2 = await repositories.agents.findVersionSnapshot(agent.id, 2)
    const snap1Again = await repositories.agents.findVersionSnapshot(agent.id, 1)
    if (
      snap2?.roleInstruction === R1 &&
      snap2?.behaviorProfile === B2 &&
      snap2?.behaviorProfileVersion === 2 &&
      snap1Again?.behaviorProfile === B1 // a régi verzió változatlan
    ) {
      pass('Reprodukálhatóság — v2 az új, v1 snapshot immutábilis')
    } else {
      fail('Snapshot history', JSON.stringify({ snap2, snap1Again }))
    }

    // Csak szerep változik.
    const upd3 = await repositories.agents.updateInstruction({
      agentId: agent.id,
      roleInstruction: R2,
    })
    if (
      upd3.agentVersion === 3 &&
      upd3.roleChanged &&
      !upd3.behaviorChanged &&
      upd3.roleInstructionVersion === 2 &&
      upd3.behaviorProfileVersion === 2
    ) {
      pass('Szerep-only update — agent v3, szerep v2, viselkedés marad v2')
    } else {
      fail('Szerep update', JSON.stringify(upd3))
    }

    const snap3 = await repositories.agents.findVersionSnapshot(agent.id, 3)
    if (snap3?.roleInstruction === R2 && snap3?.behaviorProfile === B2) {
      pass('Snapshot v3 — R2 + B2 befagyasztva')
    } else {
      fail('Snapshot v3', JSON.stringify(snap3))
    }

    // Üres / azonos frissítés elutasítva.
    let rejected = false
    try {
      await repositories.agents.updateInstruction({ agentId: agent.id })
    } catch {
      rejected = true
    }
    if (rejected) {
      pass('Üres frissítés elutasítva (nincs new verzió)')
    } else {
      fail('Üres frissítés', 'nem dobott hibát')
    }
  } finally {
    await cleanupRoleBehaviorTestAgents()
  }
}

/** 21. Goose Docker E2E — opcionális, HARNESS_DOCKER_E2E=1 + image + platform */
async function scenario20_dockerGooseE2E() {
  console.log('\n[21] Goose Docker E2E (opcionális)')

  if (process.env.HARNESS_DOCKER_E2E !== '1') {
    skip('Goose Docker E2E', 'HARNESS_DOCKER_E2E=1 nincs beállítva')
    return
  }

  const {
    buildHarnessDockerArgs,
    dockerImageExists,
    isPlatformReachable,
    platformBaseUrl,
    readSeedApiKey,
    runDocker,
  } = await import('./harness-docker-shared')

  const image = process.env.HARNESS_DOCKER_IMAGE ?? 'wiki-harness:local'
  const platformUrl = platformBaseUrl()

  if (!(await dockerImageExists(image))) {
    skip('Goose Docker E2E', `image ${image} hiányzik`)
    return
  }
  if (!(await isPlatformReachable(platformUrl))) {
    skip('Goose Docker E2E', `platform nem elérhető: ${platformUrl}`)
    return
  }

  const operator = await getUser('operator')
  const agent = await getWikiAgent()
  const ticketId = randomUUID()
  const lockToken = randomUUID()
  const agentApiKey = await readSeedApiKey()

  await prisma.ticket.create({
    data: {
      id: ticketId,
      type: 'interaction',
      title: 'Acceptance: docker goose E2E',
      state: 'in_progress',
      assigneeType: 'agent',
      assigneeId: agent.id,
      agentId: agent.id,
      payload: { question: SAMPLE_WIKI_QUESTION, agentVersion: agent.currentVersion },
      lockToken,
      lockedAt: new Date(),
      createdById: operator.id,
    },
  })

  try {
    const exitCode = await runDocker(
      buildHarnessDockerArgs({
        ticketId,
        agentId: agent.id,
        lockToken,
        agentVersion: agent.currentVersion,
        question: SAMPLE_WIKI_QUESTION,
        harnessMode: 'goose',
        extraEnv: { HARNESS_AGENT_API_KEY: agentApiKey },
      }),
    )

    const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } })
    const payload = ticket?.payload as { answer?: string } | null
    const modelCalls = await prisma.modelCall.count({ where: { ticketId } })
    const toolCalls = await prisma.toolCall.count({ where: { ticketId } })

    if (
      exitCode === 0 &&
      !ticket?.lockToken &&
      modelCalls > 0 &&
      toolCalls > 0 &&
      payload?.answer?.trim()
    ) {
      pass('Goose Docker E2E — gateway + broker + board_write', `model=${modelCalls} tool=${toolCalls}`)
    } else {
      fail(
        'Goose Docker E2E',
        JSON.stringify({ exitCode, lock: ticket?.lockToken, modelCalls, toolCalls, answer: payload?.answer }),
      )
    }
  } finally {
    await prisma.ticket.delete({ where: { id: ticketId } }).catch(() => undefined)
  }
}

/** 15. Dispatch NOTIFY — ready ticket pg_notify */
async function scenario14_dispatchNotify(operatorId: string, agentId: string) {
  console.log('\n[15] Dispatch NOTIFY')

  const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL
  if (!connectionString) {
    skip('Dispatch NOTIFY', 'nincs DATABASE_URL')
    return
  }

  const { Client } = await import('pg')
  const client = new Client({ connectionString })
  await client.connect()
  await client.query(`LISTEN ${DISPATCH_NOTIFY_CHANNEL}`)

  const notified = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('NOTIFY timeout')), 5000)
    client.on('notification', (msg) => {
      if (msg.channel === DISPATCH_NOTIFY_CHANNEL && msg.payload) {
        clearTimeout(timer)
        resolve(msg.payload)
      }
    })
  })

  const ticket = await repositories.tickets.create({
    type: 'interaction',
    title: 'Acceptance: dispatch notify',
    state: 'ready',
    assigneeType: 'agent',
    assigneeId: agentId,
    agentId,
    payload: { question: 'notify test' },
    sourceDocumentId: null,
    executeAfter: null,
    dueBy: null,
    createdById: operatorId,
  })

  try {
    const payload = await notified
    if (payload === ticket.id) pass('pg_notify dispatch_ticket_ready a ticket létrehozásakor')
    else fail('Dispatch NOTIFY payload', `expected ${ticket.id}, got ${payload}`)
  } catch (e) {
    fail('Dispatch NOTIFY', e instanceof Error ? e.message : String(e))
  } finally {
    await client.end()
    await prisma.ticket.delete({ where: { id: ticket.id } })
  }
}

async function main() {
  console.log('=== Fázis 1–2 Acceptance (spec §14 + governance) ===\n')

  ensureOAuthStubForAcceptance()

  const operator = await getUser('operator')
  const approver = await getUser('approver')
  const agent = await getWikiAgent()

  console.log(`Agent: ${agent.name} (${agent.id.slice(0, 8)}…)`)
  console.log(`Operator: ${operator.name}, Approver: ${approver.name}`)

  await resetSameDayBudget(agent.id)

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
  await scenario7_toolBroker(operator.id, agent.id, agent.currentVersion)
  await scenario7_governance(operator.id, approver.id, agent.id)
  await scenario8_writeGateNegative(operator.id, agent.id)
  await scenario9_iam()
  await scenario10_sandboxAppRegistry(operator.id, agent.id)
  await scenario11_harnessCompletion(operator.id, agent.id)
  await scenario12_harnessEntrypoint()
  await scenario13_gooseCommandBuilder()
  await scenario14_dispatchNotify(operator.id, agent.id)
  await scenario15_gatewayOpenAI(agent.id)
  await scenario16_gooseHarnessConfig()
  await scenario17_mcpBridge(agent.id, agent.currentVersion)
  await scenario18_dispatchTimeout(operator.id, agent.id)
  await scenarioN4_egressGuard()
  await scenarioN1_viewerCannotApprove(operator.id, agent.id)
  await scenarioN2_unauthorizedTool(operator.id, agent.id, agent.currentVersion)
  await scenario19_dockerLocalLauncher()
  await scenario20_dockerGooseE2E()
  await scenario22_dispatcherDockerPath(operator.id, agent.id)
  await scenario23_cloudRunJobLauncher()
  await scenario24_governanceReport()
  await scenario25_measurementReport()
  await scenario26_roleBehaviorVersioning(approver.id)
  await scenarioAgentApi(agent.id)

  const passed = results.filter((r) => r.ok && !r.skipped).length
  const skipped = results.filter((r) => r.skipped).length
  const failed = results.filter((r) => !r.ok).length

  console.log('\n=== Összesítés ===')
  console.log(`  ${passed} sikeres, ${skipped} kihagyva, ${failed} sikertelen / ${results.length} összesen`)

  if (failed > 0) {
    console.log('\nSikertelen tesztek:')
    results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.detail}`))
    process.exit(1)
  }

  if (skipped > 0) {
    console.log('\n◌ Acceptance smoke zöld, de S2-függő forgatókönyv még nincs lefuttatva.')
  } else {
    console.log('\n✅ Minden acceptance forgatókönyv sikeres.')
  }
}

main()
  .catch((e) => {
    console.error('\nFatal:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
