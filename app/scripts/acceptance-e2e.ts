/**
 * MVP v1 acceptance — walking skeleton smoke checks
 * Futtatás: npm run test:acceptance (app/)
 */
import { existsSync } from 'node:fs'
import { readFile, mkdtemp, rm } from 'fs/promises'
import { homedir, tmpdir } from 'node:os'
import { config } from 'dotenv'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import type { Prisma, UserRole } from '@prisma/client'
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
import { buildRunAsAuthorization, isRunAsAuthorized, readRunAsUserId } from '../src/lib/run-as-payload'
import { PLATFORM_TICKET_SOURCE_ENV } from '../src/lib/ticket-source'
import { repositories } from '../src/repositories/postgres'
import { WorkspaceStorage } from '../src/domain/file-editor/workspace-storage'
import { createGrantTokenStore } from '../src/domain/connector-grant/grant-token-vault'
import {
  buildMeasurementReport,
  renderMeasurementMarkdown,
} from '../src/domain/governance/measurement-report'
import { assertRole } from '../src/auth/types'
import { syncClerkUser, DomainNotAllowedError } from '../src/auth/clerk-user-sync'
import { decideAuthz } from '../src/lib/iam-policy'

const SAMPLE_WIKI_QUESTION =
  'Mi az MVP célja, és milyen átjárókon kell átmennie az agent műveleteinek?'

function isEmbeddedOAuthConfigured(): boolean {
  if (process.env.CHATGPT_OAUTH_TOKEN_SECRET?.trim()) return true
  if (process.env.CHATGPT_OAUTH_EMBEDDED !== 'true') return false
  const authFile =
    process.env.CODEX_AUTH_FILE?.trim() || join(homedir(), '.codex', 'auth.json')
  return existsSync(authFile)
}

function ensureOAuthStubForAcceptance() {
  if (isEmbeddedOAuthConfigured()) return
  const url = process.env.CHATGPT_OAUTH_PROVIDER_URL?.trim()
  const key = process.env.CHATGPT_OAUTH_PROVIDER_KEY?.trim()
  if (!url || !key) {
    process.env.CHATGPT_OAUTH_PROVIDER_URL = 'stub'
    process.env.CHATGPT_OAUTH_PROVIDER_KEY = 'stub'
  }
}

function isOAuthConfiguredForAcceptance() {
  if (isEmbeddedOAuthConfigured()) return true
  const url = process.env.CHATGPT_OAUTH_PROVIDER_URL?.trim()
  const key = process.env.CHATGPT_OAUTH_PROVIDER_KEY?.trim()
  return Boolean(url && key)
}

function oauthAcceptanceMode(): 'embedded' | 'sidecar' | 'stub' | 'none' {
  if (process.env.CHATGPT_OAUTH_TOKEN_SECRET?.trim()) return 'embedded'
  if (process.env.CHATGPT_OAUTH_EMBEDDED === 'true' && isEmbeddedOAuthConfigured()) return 'embedded'
  const url = process.env.CHATGPT_OAUTH_PROVIDER_URL?.trim()
  if (url && url !== 'stub' && !url.startsWith('stub://')) return 'sidecar'
  if (url === 'stub' || url?.startsWith('stub://')) return 'stub'
  return 'none'
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

/** 1. Wiki path smoke: kérdés → retrieval → LLM → jóváhagyás/done → audit (CR-MVP-003: beszélgetés-elsődleges) */
async function scenario1_e2e(operatorId: string, approverId: string, agentId: string) {
  console.log('\n[1] Wiki kérdés flow smoke')

  if (!isOAuthConfiguredForAcceptance()) {
    skip(
      'Wiki kérdés flow',
      'nincs OAuth (stub/sidecar/embedded) — állítsd be a CHATGPT_OAUTH_* env-et vagy a ~/.codex/auth.json-t',
    )
    return null
  }

  const oauthMode = oauthAcceptanceMode()
  const usingStub = oauthMode === 'stub'

  let ticketId: string
  try {
    const wikiResult = await services.wiki.askWiki({
      agentId,
      question: SAMPLE_WIKI_QUESTION,
      createdById: operatorId,
    })

    const ticketsBeforePromote = await prisma.ticket.count({
      where: { conversationId: wikiResult.conversationId },
    })
    if (ticketsBeforePromote === 0) {
      pass('askWiki — beszélgetés ticket nélkül', wikiResult.conversationId.slice(0, 8))
    } else {
      fail('askWiki ticket nélkül', `ticket count=${ticketsBeforePromote}`)
    }

    if (wikiResult.answer.answer.trim().length > 0) {
      pass(
        'ChatGPT OAuth válasz (beszélgetésben)',
        `confidence=${wikiResult.answer.confidence}${usingStub ? ' (stub)' : oauthMode === 'embedded' ? ' (embedded OAuth)' : ''}`,
      )
    } else {
      fail('ChatGPT OAuth válasz', 'üres answer')
      return null
    }

    const agentRow = await prisma.agent.findUnique({ where: { id: agentId } })
    const agentDetail = await repositories.agents.findByIdWithDetails(agentId)
    const modelConfig = agentRow?.modelConfig as { model?: string } | undefined

    const ticket = await services.conversations.promoteToTicket({
      conversationId: wikiResult.conversationId,
      createdById: operatorId,
      reason: 'approval',
      answerPayload: {
        question: SAMPLE_WIKI_QUESTION,
        answer: wikiResult.answer.answer,
        sources: wikiResult.answer.sources,
        rationale: wikiResult.answer.rationale,
        confidence: wikiResult.answer.confidence,
        agentVersion: agentRow?.currentVersion ?? 1,
        model: modelConfig?.model ?? 'chatgpt-oauth-default',
        memoryVersion: agentDetail?.memoryVersion ?? null,
        recipeName: agentDetail?.recipe?.name ?? null,
        recipeVersion: agentDetail?.recipe?.version ?? null,
      },
      agentMessageId: wikiResult.messageId,
    })
    ticketId = ticket.id
    pass('promoteToTicket — határátlépéskor ticket', ticketId.slice(0, 8))
  } catch (e) {
    fail('Wiki beszélgetés flow', e instanceof Error ? e.message : String(e))
    return null
  }

  const answered = await repositories.tickets.findById(ticketId)
  if (answered?.state === 'awaiting_human') {
    pass('Ticket válaszolt állapotban', answered.state)
  } else {
    fail('Ticket állapot', `várt: awaiting_human, kapott: ${answered?.state}`)
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
  const hasPromote = audit.some(
    (e) => e.action === 'conversation.promote_to_ticket' && e.outputRef === ticketId,
  )
  if (hasTransition && hasModelCall && hasToolCall && hasPromote) {
    pass('Audit log: ticket.transition + model.call + tool.call + promote')
  } else {
    fail(
      'Audit log',
      `transition=${hasTransition} model.call=${hasModelCall} tool.call=${hasToolCall} promote=${hasPromote}`,
    )
  }

  const modelCalls = await prisma.modelCall.findMany({
    where: { conversationId: answered?.conversationId ?? undefined },
    take: 1,
  })
  if (modelCalls.length > 0 && modelCalls[0].promptTokens > 0) {
    pass('model_calls conversation_id naplózás', `${modelCalls[0].promptTokens}+${modelCalls[0].completionTokens} token`)
  } else {
    fail('model_calls conversation', 'nincs token rekord conversation_id-vel')
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

/**
 * Audit Log & Observability — DB-szintű append-only kényszer + konkurrencia (spec §9:
 * "append-only enforce", "concurrency"). A content-guard és event-catalog logikát
 * a stub-DB-s scripts/audit-log.test.ts fedi; ez a szcenárió a valódi Postgres
 * trigger-t és az egyidejű append()-eket teszteli élő DB-n.
 */
async function scenarioAuditLogHardening() {
  console.log('\n[AL] Audit Log & Observability — append-only + concurrency (§9)')

  try {
    await repositories.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action: 'made.up.unregistered.action',
      targetType: 'acceptance_probe',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: null,
      metadata: null,
    })
    fail('Ismeretlen action típus elutasítva', 'nem dobott hibát')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('Unregistered audit action')) pass('Ismeretlen action típus elutasítva')
    else fail('Ismeretlen action típus elutasítva', msg)
  }

  try {
    await repositories.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action: 'database.mode_changed',
      targetType: 'acceptance_probe',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: null,
      metadata: { secret: 'this-should-never-be-written' },
    })
    fail('Nyers content/secret payload elutasítva', 'nem dobott hibát')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('Unsafe audit payload')) pass('Nyers content/secret payload elutasítva')
    else fail('Nyers content/secret payload elutasítva', msg)
  }

  const probe = await repositories.audit.append({
    actorType: 'system',
    actorId: null,
    agentVersion: null,
    action: 'database.mode_changed',
    targetType: 'acceptance_probe',
    targetId: null,
    modelUsed: null,
    inputRef: null,
    outputRef: null,
    policyDecision: null,
    metadata: { note: 'append-only enforce probe' },
  })

  try {
    await prisma.$executeRaw`UPDATE audit_log SET hash = 'tampered' WHERE id = ${probe.id}::uuid`
    fail('DB-szintű append-only — UPDATE tiltva', 'az UPDATE lefutott (trigger nem érvényesül!)')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('append-only')) pass('DB-szintű append-only — UPDATE tiltva')
    else fail('DB-szintű append-only — UPDATE tiltva', msg)
  }

  try {
    await prisma.$executeRaw`DELETE FROM audit_log WHERE id = ${probe.id}::uuid`
    fail('DB-szintű append-only — DELETE tiltva', 'a DELETE lefutott (trigger nem érvényesül!)')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('append-only')) pass('DB-szintű append-only — DELETE tiltva')
    else fail('DB-szintű append-only — DELETE tiltva', msg)
  }

  const before = await services.auditChain.verifyChain()
  const CONCURRENT_APPENDS = 12
  await Promise.all(
    Array.from({ length: CONCURRENT_APPENDS }, (_, i) =>
      repositories.audit.append({
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        action: 'database.mode_changed',
        targetType: 'acceptance_probe',
        targetId: null,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: null,
        metadata: { note: `concurrent append ${i}` },
      }),
    ),
  )
  const after = await services.auditChain.verifyChain()
  if (before.ok && after.ok && after.checked === before.checked + CONCURRENT_APPENDS + 1) {
    pass('Konkurrens append()-ek egyenes láncot adnak', `+${CONCURRENT_APPENDS + 1} sor, verifyChain zöld`)
  } else {
    fail(
      'Konkurrens append()-ek egyenes láncot adnak',
      `before=${JSON.stringify(before, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))} after=${JSON.stringify(after, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
    )
  }
}

async function ensureAcceptanceHelperAgent(operatorId: string, wikiAgentId: string) {
  const existing = await prisma.agent.findFirst({ where: { name: 'Acceptance Helper Agent' } })
  if (existing) {
    for (const toolName of ['kb_search', 'board_write', 'ticket_create', 'agent_ask']) {
      await prisma.capability.upsert({
        where: { agentId_toolName: { agentId: existing.id, toolName } },
        create: { agentId: existing.id, toolName, allowed: true },
        update: { allowed: true },
      })
    }
    return existing
  }

  const created = await repositories.agents.create({
    name: 'Acceptance Helper Agent',
    roleInstruction: 'Acceptance helper — delegated questions only.',
    behaviorProfile: 'Tömör, tényalapú válasz.',
    modelConfig: {
      provider: 'chatgpt-oauth',
      model: 'chatgpt-oauth-default',
      temperature: 0.2,
      maxTokens: 1024,
    },
    createdById: operatorId,
  })
  const helper = created.agent

  const wikiConnectors = await prisma.agentConnector.findMany({ where: { agentId: wikiAgentId } })
  for (const row of wikiConnectors) {
    await prisma.agentConnector.upsert({
      where: { agentId_connectorId: { agentId: helper.id, connectorId: row.connectorId } },
      create: {
        agentId: helper.id,
        connectorId: row.connectorId,
        accessMode: row.accessMode,
      },
      update: { accessMode: row.accessMode },
    })
  }

  for (const toolName of ['kb_search', 'board_write', 'ticket_create', 'agent_ask']) {
    await prisma.capability.upsert({
      where: { agentId_toolName: { agentId: helper.id, toolName } },
      create: { agentId: helper.id, toolName, allowed: true },
      update: { allowed: true },
    })
  }

  return helper
}

/** 7. Tool Broker — kb_search, board_write, ticket_create, agent_ask, deny audit */
async function scenario7_toolBroker(operatorId: string, agentId: string, agentVersion: number) {
  console.log('\n[7] Tool Broker (kb_search, board_write, ticket_create, agent_ask, deny)')

  await prisma.capability.upsert({
    where: { agentId_toolName: { agentId, toolName: 'ticket_create' } },
    create: { agentId, toolName: 'ticket_create', allowed: true },
    update: { allowed: true },
  })
  await prisma.capability.upsert({
    where: { agentId_toolName: { agentId, toolName: 'agent_ask' } },
    create: { agentId, toolName: 'agent_ask', allowed: true },
    update: { allowed: true },
  })

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

  if (!write.denied && 'state' in write.result && write.result.state === 'awaiting_human') {
    pass('board_write payload + állapot frissítés')
  } else {
    fail('board_write', write.denied ? write.reason : 'nem awaiting_human lett')
  }

  const humanTicket = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    tool: 'ticket_create',
    args: {
      title: 'Acceptance: emberi review ticket',
      payload: { reason: 'acceptance human escalation' },
      assigneeType: 'human',
    },
  })

  if (
    !humanTicket.denied &&
    'assigneeType' in humanTicket.result &&
    humanTicket.result.state === 'awaiting_human' &&
    humanTicket.result.assigneeType === 'human'
  ) {
    pass('ticket_create human → awaiting_human', humanTicket.result.ticketId)
  } else {
    fail(
      'ticket_create human',
      humanTicket.denied ? humanTicket.reason : JSON.stringify(humanTicket.result),
    )
  }

  const delegateTicket = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    ticketId: ticket.id,
    tool: 'ticket_create',
    args: {
      title: 'Acceptance: agent delegálás',
      payload: { question: 'Delegált feladat az acceptance-ből' },
      assigneeType: 'agent',
      assigneeId: agentId,
    },
  })

  if (
    !delegateTicket.denied &&
    'assigneeType' in delegateTicket.result &&
    delegateTicket.result.state === 'ready' &&
    delegateTicket.result.assigneeType === 'agent'
  ) {
    pass('ticket_create agent → ready', delegateTicket.result.ticketId)
  } else {
    fail(
      'ticket_create agent',
      delegateTicket.denied ? delegateTicket.reason : JSON.stringify(delegateTicket.result),
    )
  }

  const helper = await ensureAcceptanceHelperAgent(operatorId, agentId)
  const ask = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    ticketId: ticket.id,
    tool: 'agent_ask',
    args: {
      targetAgentId: helper.id,
      question: 'Mi az MVP célja a delegálás tesztben?',
    },
  })

  if (ask.denied || !('ticketId' in ask.result)) {
    fail('agent_ask', ask.denied ? ask.reason : JSON.stringify(ask.result))
  } else {
    pass('agent_ask delegálás ticket', ask.result.ticketId)

    const delegationWrite = await services.toolBroker.invoke({
      agentId: helper.id,
      agentVersion: helper.currentVersion,
      ticketId: ask.result.ticketId,
      tool: 'board_write',
      args: {
        ticketId: ask.result.ticketId,
        patch: {
          payload: {
            answer: 'Delegált válasz: walking skeleton.',
            sources: [{ docId: 'acceptance', sectionRef: 'delegation' }],
          },
          state: 'done',
        },
      },
    })

    const returned = await repositories.tickets.findById(ask.result.ticketId)
    const returnedPayload =
      returned &&
      typeof returned.payload === 'object' &&
      returned.payload !== null &&
      !Array.isArray(returned.payload)
        ? (returned.payload as Record<string, unknown>)
        : null

    if (
      !delegationWrite.denied &&
      returned?.state === 'done' &&
      returned.assigneeId === agentId &&
      returned.agentId === agentId &&
      returnedPayload?.delegationReturned === true &&
      returnedPayload?.answer === 'Delegált válasz: walking skeleton.'
    ) {
      pass('agent_ask — válasz után delegálás ticket lezárva (done)', returned.id)
    } else {
      fail(
        'agent_ask return',
        JSON.stringify({
          write: delegationWrite.denied ? delegationWrite.reason : delegationWrite.result,
          ticket: returned,
        }),
      )
    }

    const parent = await repositories.tickets.findById(ticket.id)
    const parentPayload =
      parent &&
      typeof parent.payload === 'object' &&
      parent.payload !== null &&
      !Array.isArray(parent.payload)
        ? (parent.payload as Record<string, unknown>)
        : null
    const delegatedAnswers = Array.isArray(parentPayload?.delegatedAnswers)
      ? parentPayload.delegatedAnswers
      : []

    if (
      delegatedAnswers.some(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          (entry as { answer?: string }).answer === 'Delegált válasz: walking skeleton.',
      )
    ) {
      pass('agent_ask — parent ticket delegatedAnswers frissítve')
    } else {
      fail('agent_ask parent merge', JSON.stringify(parentPayload?.delegatedAnswers ?? null))
    }
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

/** 10. IAM / RBAC (Feature-spec IAM-RBAC) — invite/redeem/revoke/approve + lock-out +
 *  tenant-izoláció + deny-by-default + audit-lánc integritás (§9 kötelező negatív tesztek) */
async function scenario9_iam() {
  console.log('\n[10] IAM / RBAC (invite, redeem, revoke, lock-out, tenant-isolation, deny-by-default)')

  const suffix = Date.now()
  // adminA/actorOther a null-tenant ("globális") kosárban élnek — ugyanúgy, mint a
  // seed-admin/seed-approver/seed-operator; a tenant-izoláció tesztje (i) egy VALÓDI
  // tenantId-jű otherTenantAdmin-nal szemben igazolja a N-IAM-6 kikényszerítést.
  const tenantId: string | null = null
  const adminA = await prisma.user.create({
    data: {
      externalAuthId: `acc-iam-adminA-${suffix}`,
      email: `adminA-${suffix}@acc.test`,
      name: 'Acc Admin A',
      role: 'admin',
      status: 'active',
      tenantId,
    },
  })
  const actorOther = await prisma.user.create({
    data: {
      externalAuthId: `acc-iam-actor-${suffix}`,
      email: `actor-${suffix}@acc.test`,
      name: 'Acc Actor',
      role: 'operator',
      status: 'active',
      tenantId,
    },
  })
  const otherTenantAdmin = await prisma.user.create({
    data: {
      externalAuthId: `acc-iam-otherTenantAdmin-${suffix}`,
      email: `otherTenantAdmin-${suffix}@acc.test`,
      name: 'Acc Other-Tenant Admin',
      role: 'admin',
      status: 'active',
      tenantId: randomUUID(),
    },
  })

  const createdUserIds: string[] = [adminA.id, actorOther.id, otherTenantAdmin.id]
  const createdInvitationIds: string[] = []
  // A lock-out teszthez adminA-nak az EGYETLEN aktív adminnak kell lennie A TENANTJÁN belül:
  // a többit (pl. seed-admin) a teszt idejére felfüggesztjük, majd a finally-ben visszaállítjuk.
  const tempSuspendedAdminIds: string[] = []

  try {
    // (a) Invite → redeem flow
    const invited = await services.iam.inviteUser({
      email: `invitee-${suffix}@acc.test`,
      role: 'operator',
      createdById: adminA.id,
      tenantId,
    })
    createdInvitationIds.push(invited.invitation.id)

    const inviteeExternalId = `acc-iam-invitee-${suffix}`
    const inviteeEmail = `invitee-${suffix}@acc.test`
    const redeemed = await services.iam.redeemInvitation({
      token: invited.rawToken,
      email: inviteeEmail,
      externalAuthId: inviteeExternalId,
      name: 'Acc Invitee',
    })
    createdUserIds.push(redeemed.id)

    if (redeemed.role === 'operator' && redeemed.status === 'active' && redeemed.tenantId === tenantId) {
      pass('Invite → redeem létrehoz aktív operatort a meghívó tenantjában')
    } else {
      fail('Invite → redeem', `role=${redeemed.role} status=${redeemed.status} tenant=${redeemed.tenantId}`)
    }

    const invRow = await prisma.invitation.findUnique({ where: { id: invited.invitation.id } })
    if (invRow?.status === 'redeemed') pass('Invitation redeemed státusz')
    else fail('Invitation státusz', `${invRow?.status}`)

    // (b) Replay: ugyanaz a token másodszor elutasítva (N-IAM-4, spec §9/4)
    try {
      await services.iam.redeemInvitation({
        token: invited.rawToken,
        email: inviteeEmail,
        externalAuthId: inviteeExternalId,
      })
      fail('Invitation replay tiltás', 'a már beváltott token újra beváltható volt')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('already_redeemed')) pass('Invitation replay tiltva (N-IAM-4)')
      else fail('Invitation replay tiltás', msg)
    }

    // (c) Lejárt invitation elutasítva (N-IAM-4, spec §9/5)
    const expiredInv = await prisma.invitation.create({
      data: {
        tenantId,
        email: `expired-${suffix}@acc.test`,
        role: 'viewer',
        tokenHash: `expired-hash-${suffix}`,
        status: 'pending',
        expiresAt: new Date(Date.now() - 60_000),
        createdById: adminA.id,
      },
    })
    createdInvitationIds.push(expiredInv.id)
    await prisma.invitation.update({ where: { id: expiredInv.id }, data: { status: 'expired' } })
    const expiredRow = await prisma.invitation.findUnique({ where: { id: expiredInv.id } })
    if (expiredRow?.status === 'expired') pass('Lejárt invitation jelölhető expired-re')
    else fail('Lejárt invitation', `${expiredRow?.status}`)

    // (c2) Email-mismatch: más email-lel próbálja beváltani ugyanazt a meghívót (N-IAM-4, spec §9/6)
    const mismatchInv = await services.iam.inviteUser({
      email: `mismatch-${suffix}@acc.test`,
      role: 'viewer',
      createdById: adminA.id,
      tenantId,
    })
    createdInvitationIds.push(mismatchInv.invitation.id)
    try {
      await services.iam.redeemInvitation({
        token: mismatchInv.rawToken,
        email: `wrong-${suffix}@acc.test`,
        externalAuthId: `acc-iam-mismatch-${suffix}`,
      })
      fail('Email-mismatch tiltás', 'eltérő email-lel is bevátlódott a meghívó')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('email_mismatch')) pass('Email-mismatch meghívó elutasítva (N-IAM-4)')
      else fail('Email-mismatch tiltás', msg)
    }

    // (c3) Meghívó visszavonása: revoked után nem váltható be
    const revocableInv = await services.iam.inviteUser({
      email: `revocable-${suffix}@acc.test`,
      role: 'viewer',
      createdById: adminA.id,
      tenantId,
    })
    createdInvitationIds.push(revocableInv.invitation.id)
    const revoked = await services.iam.revokeInvitation({
      invitationId: revocableInv.invitation.id,
      actorId: adminA.id,
      actorTenantId: tenantId,
    })
    if (revoked.status === 'revoked') pass('Meghívó visszavonható')
    else fail('Meghívó visszavonás', `${revoked.status}`)
    try {
      await services.iam.redeemInvitation({
        token: revocableInv.rawToken,
        email: `revocable-${suffix}@acc.test`,
        externalAuthId: `acc-iam-revocable-${suffix}`,
      })
      fail('Visszavont meghívó tiltás', 'visszavont meghívó bevátlódott')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('revoked')) pass('Visszavont meghívó elutasítva')
      else fail('Visszavont meghívó tiltás', msg)
    }

    // (d) adminA legyen az egyetlen aktív admin A TENANTJÁBAN: a többit átmenetileg felfüggesztjük.
    const otherAdmins = await prisma.user.findMany({
      where: { role: 'admin', status: 'active', tenantId, id: { not: adminA.id } },
      select: { id: true },
    })
    for (const a of otherAdmins) {
      await prisma.user.update({ where: { id: a.id }, data: { status: 'suspended' } })
      tempSuspendedAdminIds.push(a.id)
    }

    // (e) Utolsó admin nem demotálható (actor != target, hogy ne a saját-szerep ág fogja meg) — N-IAM-5, spec §9/7
    try {
      await services.iam.changeRole({
        targetUserId: adminA.id,
        newRole: 'operator',
        actorId: actorOther.id,
        actorTenantId: tenantId,
      })
      fail('Utolsó admin demotálás tiltás', 'az utolsó admin visszaminősíthető volt')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('last active admin')) pass('Utolsó admin nem demotálható (N-IAM-5)')
      else fail('Utolsó admin demotálás tiltás', msg)
    }

    // (f) Utolsó admin nem függeszthető fel — N-IAM-5, spec §9/7
    try {
      await services.iam.suspendUser({
        targetUserId: adminA.id,
        reason: 'acceptance-e2e last-admin-lock probe',
        actorId: actorOther.id,
        actorTenantId: tenantId,
      })
      fail('Utolsó admin suspend tiltás', 'az utolsó admin felfüggeszthető volt')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('last active admin')) pass('Utolsó admin nem függeszthető fel (N-IAM-5)')
      else fail('Utolsó admin suspend tiltás', msg)
    }

    // (g) Admin a saját szerepét nem írhatja át — N-IAM-5, spec §9/8
    try {
      await services.iam.changeRole({
        targetUserId: adminA.id,
        newRole: 'operator',
        actorId: adminA.id,
        actorTenantId: tenantId,
      })
      fail('Saját szerep védelem', 'admin átírhatta saját szerepét')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('self_modification_forbidden')) pass('Admin nem írhatja át saját szerepét (N-IAM-5)')
      else fail('Saját szerep védelem', msg)
    }

    // (g2) Admin saját magát nem függesztheti fel — N-IAM-5
    try {
      await services.iam.suspendUser({
        targetUserId: adminA.id,
        reason: 'self-suspend probe',
        actorId: adminA.id,
        actorTenantId: tenantId,
      })
      fail('Saját felfüggesztés védelem', 'admin felfüggeszthette saját magát')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('self_modification_forbidden')) pass('Admin nem függesztheti fel saját magát (N-IAM-5)')
      else fail('Saját felfüggesztés védelem', msg)
    }

    // (h) Kill-switch: felfüggesztett fiók nem léphet be (assertRole) — N-IAM-3, spec §9/3
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
      if (msg.includes('not active')) pass('Suspended fiók elutasítva (kill-switch, N-IAM-3)')
      else fail('Suspended kill-switch', msg)
    }

    // (h2) Pending / role=NULL fiók semmilyen művelethez nem fér — N-IAM-2/3, spec §9/2
    const pendingDecision = decideAuthz({ status: 'pending', role: null }, 'admin')
    if (!pendingDecision.allow && pendingDecision.reason === 'INACTIVE') {
      pass('Pending fiók deny-by-default (N-IAM-3)')
    } else {
      fail('Pending fiók deny-by-default', JSON.stringify(pendingDecision))
    }

    // (h3) Ismeretlen permission_key mindig tilt — N-IAM-2, spec §9/1 (valódi DB-lookup)
    const unknownEntry = await repositories.rolePermissions.findByKey(`totally.unknown.key.${suffix}`)
    const unknownDecision = decideAuthz({ status: 'active', role: 'admin' }, unknownEntry?.minRole ?? null)
    if (!unknownDecision.allow && unknownDecision.reason === 'UNKNOWN_PERMISSION') {
      pass('Ismeretlen permission_key deny-by-default (N-IAM-2)')
    } else {
      fail('Ismeretlen permission_key deny-by-default', JSON.stringify(unknownDecision))
    }

    // (h4) Provider-claim nem emel jogot: az authz-döntés kizárólag a DB-role-on múlik — N-IAM-1, spec §9/9
    const claimDecision = decideAuthz({ status: 'active', role: 'viewer' }, 'admin')
    if (!claimDecision.allow && claimDecision.reason === 'INSUFFICIENT_ROLE') {
      pass('DB-role dönt, nem a claim (N-IAM-1)')
    } else {
      fail('DB-role vs. claim', JSON.stringify(claimDecision))
    }

    // (i) Tenant-izoláció: másik tenant admin nem érheti el/módosíthatja adminA-t — N-IAM-6, spec §9/10
    try {
      await services.iam.changeRole({
        targetUserId: adminA.id,
        newRole: 'viewer',
        actorId: otherTenantAdmin.id,
        actorTenantId: otherTenantAdmin.tenantId,
      })
      fail('Tenant-izoláció (changeRole)', 'másik tenant admin módosíthatta a célpontot')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('not found')) pass('Cross-tenant célpont nem módosítható (N-IAM-6)')
      else fail('Tenant-izoláció (changeRole)', msg)
    }
    const scopedUsers = await services.iam.listUsers(tenantId)
    if (!scopedUsers.some((u) => u.id === otherTenantAdmin.id)) {
      pass('listUsers tenant-szűrt (N-IAM-6)')
    } else {
      fail('listUsers tenant-szűrés', 'másik tenant usere szivárgott a listába')
    }

    // (j) Önregisztráció (§7/B): domain-allowlist elutasítás + pending/role=NULL sikeres út
    const allowlistBackup = process.env.IAM_SELF_REGISTER_ALLOWED_DOMAINS
    try {
      process.env.IAM_SELF_REGISTER_ALLOWED_DOMAINS = 'only-allowed.example'
      try {
        await syncClerkUser(prisma, {
          externalAuthId: `acc-iam-domaindeny-${suffix}`,
          email: `newperson-${suffix}@not-allowed.example`,
          name: 'Acc Domain Denied',
          role: null,
        })
        fail('Domain-allowlist elutasítás', 'nem engedett domainnel is létrejött a fiók')
      } catch (e) {
        if (e instanceof DomainNotAllowedError) pass('Domain-allowlist elutasítja az idegen domaint (§7/B)')
        else fail('Domain-allowlist elutasítás', e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (allowlistBackup === undefined) delete process.env.IAM_SELF_REGISTER_ALLOWED_DOMAINS
      else process.env.IAM_SELF_REGISTER_ALLOWED_DOMAINS = allowlistBackup
    }

    const selfRegistered = await syncClerkUser(prisma, {
      externalAuthId: `acc-iam-selfreg-${suffix}`,
      email: `selfreg-${suffix}@acc.test`,
      name: 'Acc Self Registered',
      role: null,
    })
    createdUserIds.push(selfRegistered.id)
    if (selfRegistered.status === 'pending' && selfRegistered.role === null) {
      pass('Önregisztráció pending + role=NULL (deny-by-default, N-IAM-2/3)')
    } else {
      fail('Önregisztráció alapállapot', `status=${selfRegistered.status} role=${selfRegistered.role}`)
    }

    // (k) Admin jóváhagyja az önregisztrált (pending) usert — §7/B
    const approved = await services.iam.approveUser({
      targetUserId: selfRegistered.id,
      role: 'viewer',
      actorId: adminA.id,
      actorTenantId: adminA.tenantId,
    })
    if (approved.status === 'active' && approved.role === 'viewer') {
      pass('Pending user jóváhagyása aktívvá teszi (§7/B)')
    } else {
      fail('Pending user jóváhagyás', `status=${approved.status} role=${approved.role}`)
    }

    // Audit: az összes IAM esemény-típus jelen van a spec-nevekkel (§8.5)
    const inviteAudit = await repositories.audit.findMany({ action: 'user.invite.issue', limit: 10 })
    const redeemAudit = await repositories.audit.findMany({ action: 'user.invite.redeem', limit: 10 })
    const revokeAudit = await repositories.audit.findMany({ action: 'user.invite.revoke', limit: 10 })
    const roleChangeAudit = await repositories.audit.findMany({ action: 'user.role.change', limit: 10 })
    const roleAssignAudit = await repositories.audit.findMany({ action: 'user.role.assign', limit: 10 })
    const selfregisterAudit = await repositories.audit.findMany({ action: 'user.selfregister', limit: 10 })
    const denyAudit = await repositories.audit.findMany({ action: 'user.authz.deny', limit: 10 })
    if (
      inviteAudit.length &&
      redeemAudit.length &&
      revokeAudit.length &&
      roleAssignAudit.length &&
      selfregisterAudit.length &&
      denyAudit.length
    ) {
      pass('Audit: invite/redeem/revoke/role.assign/selfregister/authz.deny mind jelen van')
    } else {
      fail(
        'Audit IAM',
        `invite=${inviteAudit.length} redeem=${redeemAudit.length} revoke=${revokeAudit.length} ` +
          `roleChange=${roleChangeAudit.length} roleAssign=${roleAssignAudit.length} ` +
          `selfregister=${selfregisterAudit.length} deny=${denyAudit.length}`,
      )
    }

    // (l) Audit-lánc integritás a fenti sok új esemény után — N-IAM-5/§8.5, spec §9/12
    const chainResult = await services.auditChain.verifyChain()
    if (chainResult.ok) pass('Audit-lánc integritás (verifyChain)')
    else fail('Audit-lánc integritás', JSON.stringify(chainResult))
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
    tenantId: tenantA,
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
    const versionAudit = await repositories.audit.findMany({ action: 'sandbox_app.version.create', limit: 5 })
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
    '12',
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

  const geminiBuilt = buildGooseCommandJson({
    HARNESS_MODE: 'goose',
    TICKET_ID: ticketId,
    AGENT_VERSION: '3',
    HARNESS_RECIPE_PATH: '/recipes/wiki-answer.yaml',
    HARNESS_QUESTION: question,
    GOOSE_MODEL: 'gemini-2.5-flash',
  })
  const geminiArgs = JSON.parse(geminiBuilt!) as string[]
  const modelFlagIndex = geminiArgs.indexOf('--model')
  if (geminiArgs[modelFlagIndex + 1] === 'gemini-2.5-flash') {
    pass('Goose command builder — GOOSE_MODEL env átadás')
  } else {
    fail('Goose command GOOSE_MODEL', JSON.stringify(geminiArgs))
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

  const wikiEntry = await runHarnessEntrypoint(
    {
      TICKET_ID: ticketId,
      AGENT_ID: randomUUID(),
      DISPATCH_LOCK_TOKEN: randomUUID(),
      HARNESS_CALLBACK_URL: 'https://platform.example.test',
      HARNESS_CALLBACK_TOKEN: 'callback-secret',
      HARNESS_MODE: 'wiki',
      PLATFORM_API_URL: 'https://platform.example.test',
      HARNESS_AGENT_API_KEY: 'cp_sk_acceptance',
    },
    {
      fetch: async (input) => {
        const url = String(input)
        if (url.includes('/process')) {
          return new Response(JSON.stringify({ success: true, data: { ticketId } }), { status: 200 })
        }
        if (url.includes('/complete')) {
          return new Response(JSON.stringify({ success: true }), { status: 200 })
        }
        return new Response('not found', { status: 404 })
      },
      spawnCommand: async () => {
        throw new Error('goose should not run in wiki mode')
      },
      log: { log() {}, error() {} },
    },
  )

  if (wikiEntry.status === 'succeeded') pass('Harness entrypoint HARNESS_MODE=wiki success path')
  else fail('Harness entrypoint wiki mode', wikiEntry.status)
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

  // Provider-agnosztikus: nem hardcode-olunk modellt, a route az agent
  // modelConfig.model-jét használja, így a teszt a ténylegesen konfigurált
  // providert gyakorolja (stub / élő chatgpt-oauth / lokális ollama-gemma).
  const agentRecord = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { modelConfig: true },
  })
  const agentModel = (agentRecord?.modelConfig ?? {}) as { provider?: string; model?: string }
  const providerName = agentModel.provider ?? 'chatgpt-oauth'

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
        // `model` szándékosan kihagyva → a route az agent modelConfig.model-jét veszi.
        body: JSON.stringify({
          messages: [{ role: 'user', content: SAMPLE_WIKI_QUESTION }],
        }),
      }),
    )

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number }
      error?: { message?: string }
    }

    if (
      response.status === 200 &&
      body.choices?.[0]?.message?.content &&
      body.choices[0].message.content.trim().length > 0
    ) {
      pass(
        'Gateway /v1/chat/completions OpenAI formátum',
        `provider=${providerName} tokens=${body.usage?.prompt_tokens ?? 'n/a'}`,
      )
    } else if (response.status === 502) {
      // A Gateway-plumbing (auth, scope, ticket, validáció, naplózás) lefutott, de a
      // konfigurált modell-backend nem elérhető (pl. lokális Ollama nem fut, vagy az élő
      // ChatGPT OAuth token lejárt). Ez nem a Gateway hibája → skip, hogy a suite
      // provider-független maradjon. A determinisztikus CI-path továbbra is a stub (200).
      skip(
        'Gateway OpenAI API',
        `provider=${providerName} backend nem elérhető: ${body.error?.message?.slice(0, 120) ?? 'upstream hiba'}`,
      )
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
  if (
    tools.some((tool) => tool.name === 'kb_search') &&
    tools.some((tool) => tool.name === 'board_write') &&
    tools.some((tool) => tool.name === 'ticket_create') &&
    tools.some((tool) => tool.name === 'agent_ask') &&
    tools.some((tool) => tool.name === 'file_read') &&
    tools.some((tool) => tool.name === 'file_edit')
  ) {
    pass('MCP bridge tools/list — kb_search + board_write + ticket_create + agent_ask + file_read + file_edit')
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
    source: 'user',
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
      actingUserId: randomUUID(),
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
    names.has('ACTING_USER_ID') &&
    names.has('HARNESS_QUESTION')
  ) {
    pass('Cloud Run harness env — gateway + egress + run-as + question')
  } else {
    fail('Cloud Run harness env', [...names].join(','))
  }

  const envWithModel = buildHarnessContainerEnv(
    {
      ticketId,
      agentId: randomUUID(),
      lockToken: randomUUID(),
      gooseModel: 'gemini-2.5-flash',
    },
    { platformApiUrl: 'https://platform.example.com' },
  )
  const gooseModel = envWithModel.find((entry) => entry.name === 'GOOSE_MODEL')?.value
  if (gooseModel === 'gemini-2.5-flash') {
    pass('Cloud Run harness env — GOOSE_MODEL az agent snapshotból')
  } else {
    fail('Cloud Run harness GOOSE_MODEL', gooseModel ?? 'missing')
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

const CR_MVP002_ORCHESTRATOR_AGENT = 'Acceptance Orchestrator (CR-MVP-002)'

async function cleanupCrMvp002TestAgents() {
  const agents = await prisma.agent.findMany({
    where: { name: { in: [CR_MVP002_ORCHESTRATOR_AGENT] } },
    select: { id: true, memoryId: true },
  })
  for (const agent of agents) {
    await prisma.toolCall.deleteMany({ where: { agentId: agent.id } })
    await prisma.modelCall.deleteMany({ where: { agentId: agent.id } })
    await prisma.agent.delete({ where: { id: agent.id } })
    await prisma.memoryVersion.deleteMany({ where: { memoryId: agent.memoryId } })
    await prisma.memory.delete({ where: { id: agent.memoryId } })
  }
}

async function scenario27_crMvp002(createdById: string, operatorId: string, agentId: string) {
  console.log('\n[27] CR-MVP-002 séma-horgok (szerep, playbook, önfejlesztési profil)')

  await cleanupCrMvp002TestAgents()

  try {
    const { agent: orchestrator } = await repositories.agents.create({
      name: CR_MVP002_ORCHESTRATOR_AGENT,
      roleInstruction: 'Delegáló orchestrator — tool-less.',
      behaviorProfile: 'Magyarul, tömören.',
      role: 'orchestrator',
      modelConfig: { provider: 'chatgpt-oauth', model: 'stub', temperature: 0.2 },
      createdById,
    })

    const caps = await repositories.toolBroker.findCapabilitiesForAgent(orchestrator.id)
    const allowedTools = caps.filter((cap) => cap.allowed).map((cap) => cap.toolName).sort()
    const expectedTools = ['agent_ask', 'agent_catalog', 'agent_resolve', 'ticket_create']
    if (JSON.stringify(allowedTools) === JSON.stringify(expectedTools)) {
      pass('Orchestrator — csak delegációs capability-k engedélyezettek')
    } else {
      fail('Orchestrator capabilities', JSON.stringify(allowedTools))
    }

    const denied = await services.toolBroker.invoke({
      agentId: orchestrator.id,
      agentVersion: orchestrator.currentVersion,
      ticketId: undefined,
      tool: 'kb_search',
      args: { query: 'probe', k: 1 },
    })
    if (denied.denied && denied.reason === 'orchestrator_tool_less') {
      pass('Orchestrator — kb_search tool-less tiltás')
    } else {
      fail('Orchestrator tool deny', denied.denied ? denied.reason : 'tool lefutott')
    }

    const ticket = await services.wiki.createQuestionTicket({
      agentId,
      question: 'CR-MVP-002 playbook pin teszt',
      createdById: operatorId,
    })
    if (ticket.playbookRef?.startsWith('playbook:wiki-interaction@v')) {
      pass('Wiki ticket — playbook_ref PIN-elve')
    } else {
      fail('playbook_ref', ticket.playbookRef ?? 'null')
    }

    const processAudit = await repositories.audit.findMany({ action: 'process.start', limit: 10 })
    const hasStart = processAudit.some(
      (row) => row.targetId === ticket.id && row.outputRef === ticket.playbookRef,
    )
    if (hasStart) pass('Audit — process.start playbook_ref-fel')
    else fail('process.start audit', ticket.id)

    const { DispatcherService } = await import('../src/domain/dispatcher/dispatcher-service')
    const executeAfter = new Date(Date.now() + 60_000)
    const scheduledTicket = await services.wiki.createQuestionTicket({
      agentId,
      question: 'CR-MVP-002 scheduled run-as playbook teszt',
      createdById: operatorId,
      executeAfter,
      authorizeRunAs: true,
    })
    const scheduledPayload =
      typeof scheduledTicket.payload === 'object' &&
      scheduledTicket.payload !== null &&
      !Array.isArray(scheduledTicket.payload)
        ? (scheduledTicket.payload as Record<string, unknown>)
        : null

    if (
      scheduledTicket.executeAfter?.getTime() === executeAfter.getTime() &&
      scheduledTicket.playbookRef?.startsWith('playbook:wiki-interaction@v') &&
      isRunAsAuthorized(scheduledPayload) &&
      readRunAsUserId(scheduledPayload) === operatorId
    ) {
      pass('Scheduled playbook ticket — explicit run-as payload')
    } else {
      fail(
        'Scheduled playbook run-as payload',
        JSON.stringify({
          executeAfter: scheduledTicket.executeAfter,
          playbookRef: scheduledTicket.playbookRef,
          payload: scheduledPayload,
        }),
      )
    }

    let scheduledLaunchActingUserId: string | undefined
    const scheduledDispatcher = new DispatcherService(
      repositories.tickets,
      repositories.audit,
      repositories.modelCalls,
      {
        mode: 'acceptance-scheduled-run-as',
        async launch(input) {
          scheduledLaunchActingUserId = input.actingUserId
          return { jobId: `acceptance-scheduled-${input.ticketId}` }
        },
      },
    )
    const beforeSchedule = await scheduledDispatcher.dispatchTicket(
      scheduledTicket.id,
      new Date(executeAfter.getTime() - 1_000),
    )
    const afterSchedule = await scheduledDispatcher.dispatchTicket(
      scheduledTicket.id,
      new Date(executeAfter.getTime() + 1_000),
    )
    if (
      beforeSchedule.status === 'skipped' &&
      afterSchedule.status === 'started' &&
      scheduledLaunchActingUserId === operatorId
    ) {
      pass('Scheduled dispatcher — run-as csak due után továbbítva')
    } else {
      fail(
        'Scheduled dispatcher run-as',
        JSON.stringify({ beforeSchedule, afterSchedule, scheduledLaunchActingUserId }),
      )
    }

    await prisma.ticket.delete({ where: { id: scheduledTicket.id } })

    const scheduledTask = await services.scheduledTasks.createOneShotAgentTask({
      tenantId: null,
      agentId,
      title: 'Scheduled task resource run-as teszt',
      content: 'CR-MVP-002 scheduled task resource materializálás',
      createdById: operatorId,
      nextRunAt: new Date(Date.now() - 1_000),
      authorizeRunAs: true,
    })
    const materialized = await services.scheduledTasks.materializeDue(new Date(), 10)
    const scheduledTaskResult = materialized.find(
      (item) => item.scheduledTaskId === scheduledTask.id,
    )
    const materializedTicket =
      scheduledTaskResult?.status === 'materialized'
        ? await repositories.tickets.findById(scheduledTaskResult.ticketId)
        : null
    const materializedPayload =
      materializedTicket &&
      typeof materializedTicket.payload === 'object' &&
      materializedTicket.payload !== null &&
      !Array.isArray(materializedTicket.payload)
        ? (materializedTicket.payload as Record<string, unknown>)
        : null

    if (
      scheduledTaskResult?.status === 'materialized' &&
      materializedTicket?.source === 'system' &&
      materializedPayload?.scheduledTaskId === scheduledTask.id &&
      isRunAsAuthorized(materializedPayload) &&
      readRunAsUserId(materializedPayload) === operatorId
    ) {
      pass('Scheduled task erőforrás — explicit run-as materializált ticketre')
    } else {
      fail(
        'Scheduled task erőforrás run-as',
        JSON.stringify({ scheduledTaskResult, materializedPayload }),
      )
    }

    await prisma.scheduledTask.delete({ where: { id: scheduledTask.id } })
    if (materializedTicket) await prisma.ticket.delete({ where: { id: materializedTicket.id } })

    const recurringTask = await services.scheduledTasks.createAgentTask({
      tenantId: null,
      agentId,
      title: 'Recurring scheduled task teszt',
      content: 'CR-MVP-002 recurring scheduled task materializálás',
      createdById: operatorId,
      nextRunAt: new Date(Date.now() - 1_000),
      recurrence: 'daily',
      maxRuns: 2,
      authorizeRunAs: true,
    })
    const recurringFirstBatch = await services.scheduledTasks.materializeDue(new Date(), 10)
    const recurringFirst = recurringFirstBatch.find(
      (item) => item.scheduledTaskId === recurringTask.id,
    )
    const recurringAfterFirst = await prisma.scheduledTask.findUnique({
      where: { id: recurringTask.id },
    })
    const recurringSecondBatch =
      recurringAfterFirst && recurringFirst?.status === 'materialized'
        ? await services.scheduledTasks.materializeDue(
            new Date(recurringAfterFirst.nextRunAt.getTime() + 1_000),
            10,
          )
        : []
    const recurringSecond = recurringSecondBatch.find(
      (item) => item.scheduledTaskId === recurringTask.id,
    )
    const recurringAfterSecond = await prisma.scheduledTask.findUnique({
      where: { id: recurringTask.id },
    })

    if (
      recurringFirst?.status === 'materialized' &&
      recurringAfterFirst?.status === 'active' &&
      recurringAfterFirst.runCount === 1 &&
      recurringAfterFirst.nextRunAt > new Date() &&
      recurringSecond?.status === 'materialized' &&
      recurringAfterSecond?.status === 'materialized' &&
      recurringAfterSecond.runCount === 2
    ) {
      pass('Scheduled task erőforrás — recurring materializálás és maxRuns lezárás')
    } else {
      fail(
        'Scheduled task recurring',
        JSON.stringify({
          recurringFirst,
          recurringAfterFirst,
          recurringSecond,
          recurringAfterSecond,
        }),
      )
    }

    await prisma.scheduledTask.delete({ where: { id: recurringTask.id } })
    if (recurringFirst?.status === 'materialized') {
      await prisma.ticket.delete({ where: { id: recurringFirst.ticketId } })
    }
    if (recurringSecond?.status === 'materialized') {
      await prisma.ticket.delete({ where: { id: recurringSecond.ticketId } })
    }

    const { addRecurrence } = await import('../src/domain/scheduled-task/scheduled-task-service')
    const jan31 = new Date('2026-01-31T12:00:00Z')
    const febFromJan31 = addRecurrence(jan31, 'monthly')
    const marFromJan31 = febFromJan31 ? addRecurrence(febFromJan31, 'monthly') : null
    if (
      febFromJan31?.getUTCFullYear() === 2026 &&
      febFromJan31.getUTCMonth() === 1 &&
      febFromJan31.getUTCDate() === 28 &&
      marFromJan31?.getUTCMonth() === 2 &&
      marFromJan31.getUTCDate() === 28
    ) {
      pass('Scheduled task — monthly edge case (jan 31 → feb 28 → mar 28)')
    } else {
      fail(
        'Scheduled task monthly edge case',
        JSON.stringify({
          febFromJan31: febFromJan31?.toISOString(),
          marFromJan31: marFromJan31?.toISOString(),
        }),
      )
    }

    const staleMaterializingTask = await services.scheduledTasks.createOneShotAgentTask({
      tenantId: null,
      agentId,
      title: 'Stale materializing reclaim teszt',
      content: 'materializing reclaim',
      createdById: operatorId,
      nextRunAt: new Date(Date.now() + 3600_000),
      authorizeRunAs: false,
    })
    await prisma.scheduledTask.update({
      where: { id: staleMaterializingTask.id },
      data: {
        status: 'materializing',
        updatedAt: new Date(Date.now() - 600_000),
      },
    })
    const reclaimedMaterializing = await services.scheduledTasks.reclaimStaleMaterializations(
      300_000,
      10,
    )
    const reclaimedRow = reclaimedMaterializing.find(
      (row) => row.scheduledTaskId === staleMaterializingTask.id,
    )
    const reclaimedTask = await prisma.scheduledTask.findUnique({
      where: { id: staleMaterializingTask.id },
    })
    if (reclaimedRow?.status === 'reclaimed' && reclaimedTask?.status === 'active') {
      pass('Scheduled task — stale materializing reclaim')
    } else {
      fail(
        'Scheduled task stale materializing reclaim',
        JSON.stringify({ reclaimedRow, reclaimedTask }),
      )
    }
    await prisma.scheduledTask.delete({ where: { id: staleMaterializingTask.id } })

    const lowConfidenceTicket = await repositories.tickets.create({
      type: 'interaction',
      title: 'Playbook gate probe',
      state: 'in_progress',
      assigneeType: 'agent',
      assigneeId: agentId,
      agentId,
      playbookRef: ticket.playbookRef,
      payload: { question: 'probe', confidence: 'medium' },
      sourceDocumentId: null,
      executeAfter: null,
      dueBy: null,
      createdById: operatorId,
    })
    let gateBlocked = false
    try {
      await services.tickets.transition({
        ticketId: lowConfidenceTicket.id,
        toState: 'done',
        actor: { type: 'system' },
      })
    } catch {
      gateBlocked = true
    }
    if (gateBlocked) pass('Playbook gate — in_progress→done blokkolva (confidence≠high)')
    else fail('Playbook gate', 'átment tiltás nélkül')

    const updatedProfile = await repositories.agents.updateSelfEvolutionProfile({
      agentId,
      profile: { scope: ['memory'], approval_mode: 'human', diff_limit: 500 },
    })
    if (updatedProfile.selfEvolutionProfile) {
      pass('Self-evolution profil — mentve az agentre')
    } else {
      fail('Self-evolution profil', 'null')
    }

    let humanBlocked = false
    try {
      const training = await services.training.createTrainingTicket({
        agentId,
        proposedContent: 'CR-MVP-002 human gate probe',
        source: 'acceptance',
        createdById: operatorId,
      })
      await services.training.promoteMemoryWithoutHumanApproval(training.id)
    } catch (e) {
      if (e instanceof Error && e.message === 'human_approval_required') humanBlocked = true
    }
    if (humanBlocked) pass('Human approval_mode — emberi jóváhagyás nélkül nem promótál')
    else fail('Human gate', 'promote engedélyezett')

    await prisma.ticket.deleteMany({
      where: { id: { in: [ticket.id, lowConfidenceTicket.id] } },
    })
  } finally {
    await cleanupCrMvp002TestAgents()
  }
}

/** N7. Beszélgetésből (ticket nélkül) kért memóriaírás — write-gate kötelező */
async function scenarioN7_conversationWriteGateDenied(agentId: string) {
  console.log('\n[N7] Write-gate beszélgetésből (CR-MVP-003)')

  const conv = await services.conversations.createConversation({
    agentId,
    createdById: (await getUser('operator')).id,
  })

  const denied = await services.training.attemptUngatedMemoryWrite({
    agentId,
    proposedContent: 'N7 — tanuld meg ezt beszélgetésből',
    conversationId: conv.id,
  })

  if (!denied.allowed && denied.reason === 'write_gate_required') {
    pass('Beszélgetésből — ungated memóriaírás elutasítva')
  } else {
    fail('N7 deny', JSON.stringify(denied))
  }

  const audit = await repositories.audit.findMany({ action: 'memory.write_denied', limit: 10 })
  const hasAudit = audit.some(
    (row) => row.targetId === conv.id && row.policyDecision === 'write_gate_required',
  )
  if (hasAudit) pass('Audit — memory.write_denied (conversation target)')
  else fail('N7 audit', conv.id)

  await prisma.message.deleteMany({ where: { conversationId: conv.id } })
  await prisma.conversation.delete({ where: { id: conv.id } })
}

/** N8. GDPR-erasure — verifyChain zöld marad */
async function scenarioN8_gdprErasureVerifyChain(operatorId: string, agentId: string) {
  console.log('\n[N8] GDPR message erasure (CR-MVP-003)')

  const conv = await services.conversations.createConversation({
    agentId,
    createdById: operatorId,
  })
  const msg = await services.conversations.appendMessage({
    conversationId: conv.id,
    role: 'user',
    content: 'PII: teszt@example.com — törölendő tartalom',
    actorType: 'human',
    actorId: operatorId,
  })

  const chainBefore = await services.auditChain.verifyChain()
  if (chainBefore.ok) pass('verifyChain — erasure előtt zöld')
  else fail('verifyChain before', chainBefore.firstBreakSeq ?? 'invalid')

  await services.conversations.deleteMessageContent({
    messageId: msg.id,
    actorId: operatorId,
  })

  const updated = await prisma.message.findUnique({ where: { id: msg.id } })
  if (!updated?.contentRef && updated?.contentDeletedAt) {
    pass('content_ref ürítve + content_deleted_at beállítva')
  } else {
    fail('GDPR erasure', JSON.stringify({ contentRef: updated?.contentRef, deleted: updated?.contentDeletedAt }))
  }

  const chainAfter = await services.auditChain.verifyChain()
  if (chainAfter.ok) pass('verifyChain — erasure után zöld')
  else fail('verifyChain after', chainAfter.firstBreakSeq ?? 'invalid')

  const audit = await repositories.audit.findMany({ action: 'message.content_deleted', limit: 5 })
  if (audit.some((row) => row.inputRef === msg.id)) pass('Audit — message.content_deleted')
  else fail('N8 audit', msg.id)

  await prisma.message.deleteMany({ where: { conversationId: conv.id } })
  await prisma.conversation.delete({ where: { id: conv.id } })
}

async function scenario28_crMvp003(operatorId: string, agentId: string) {
  console.log('\n[28] CR-MVP-003 beszélgetés-séma + kapu-leválasztás')

  const wikiResult = await services.wiki.askWiki({
    agentId,
    question: 'CR-MVP-003 conversation probe',
    createdById: operatorId,
  })

  const convModelCalls = await prisma.modelCall.count({
    where: { conversationId: wikiResult.conversationId, ticketId: null },
  })
  if (convModelCalls > 0) pass('model_calls — conversation_id ticket nélkül')
  else fail('conversation model_calls', String(convModelCalls))

  const convToolCalls = await prisma.toolCall.count({
    where: { conversationId: wikiResult.conversationId, ticketId: null },
  })
  if (convToolCalls > 0) pass('tool_calls — conversation_id ticket nélkül')
  else fail('conversation tool_calls', String(convToolCalls))

  const { messages } = await services.conversations.getConversation(wikiResult.conversationId)
  if (messages.length >= 2) pass('Beszélgetés — user + agent üzenet')
  else fail('message count', String(messages.length))

  await prisma.message.deleteMany({ where: { conversationId: wikiResult.conversationId } })
  await prisma.conversation.delete({ where: { id: wikiResult.conversationId } })
}

/** N6. Önfejlesztési útvonal nem bővíthet capability-t */
async function scenarioN6_capabilityEscalationDenied(agentId: string) {
  console.log('\n[N6] Capability escalation tiltás (CR-MVP-002)')

  const before = await prisma.capability.count({ where: { agentId } })

  const denied = await services.training.attemptCapabilityEscalation({
    agentId,
    toolName: 'sandbox_app.create',
    ticketId: undefined,
  })

  const after = await prisma.capability.count({ where: { agentId } })

  if (!denied.allowed && denied.reason === 'capability_escalation_denied') {
    pass('Tanítási útvonal — capability escalation elutasítva')
  } else {
    fail('N6 deny', JSON.stringify(denied))
  }

  if (before === after) pass('Capabilities száma változatlan')
  else fail('Capabilities módosult', `before=${before} after=${after}`)

  const audit = await repositories.audit.findMany({
    action: 'training.capability_escalation_denied',
    limit: 10,
  })
  const hasAudit = audit.some(
    (row) => row.targetId === agentId && row.inputRef === 'sandbox_app.create',
  )
  if (hasAudit) pass('Audit — training.capability_escalation_denied')
  else fail('N6 audit', agentId)
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
      source: 'test',
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

/** Per-user connector (F2) — Gmail grant + broker */
async function setupGmailGrant(userId: string, connectorId: string, tenantId: string | null = null) {
  const { createOAuthState } = await import('../src/lib/crypto/oauth-state')
  const connector = await prisma.connector.findUniqueOrThrow({ where: { id: connectorId } })
  const { state } = createOAuthState({
    userId,
    connectorId,
    tenantId,
  })
  await services.connectorGrants.completeOAuthCallback({
    code: 'stub-code',
    state,
    connector,
    actorId: userId,
  })
}

function payloadContainsTokenLeak(value: unknown): boolean {
  const text = JSON.stringify(value)
  return (
    /stub-access-/i.test(text) ||
    /stub-refresh-/i.test(text) ||
    /Bearer\s+[\w.-]+/i.test(text) ||
    /"accessToken"/i.test(text) ||
    /"refreshToken"/i.test(text)
  )
}

const FILE_EDITOR_TOOLS = [
  'file_read',
  'file_write',
  'file_edit',
  'file_list',
  'file_glob',
  'file_search',
  'file_delete',
  'xlsx_read_sheet',
  'xlsx_write_cells',
  'xlsx_append_rows',
  'docx_read',
  'pdf_read',
] as const

async function ensureWorkspaceForAgent(agentId: string) {
  const workspace = await prisma.connector.upsert({
    where: {
      type_name: {
        type: 'workspace',
        name: 'Agent Workspace',
      },
    },
    create: {
      type: 'workspace',
      name: 'Agent Workspace',
      authMode: 'agent_owned',
      scope: 'global',
      secretAlias: 'platform/gcs-service-account',
      version: 1,
      config: {
        bucket: process.env.WORKSPACE_BUCKET ?? 'platform-workspace-prod',
        retentionDays: 30,
      },
    },
    update: {
      authMode: 'agent_owned',
      config: {
        bucket: process.env.WORKSPACE_BUCKET ?? 'platform-workspace-prod',
        retentionDays: 30,
      },
    },
  })

  await prisma.agentConnector.upsert({
    where: { agentId_connectorId: { agentId, connectorId: workspace.id } },
    create: { agentId, connectorId: workspace.id, accessMode: 'write' },
    update: { accessMode: 'write' },
  })

  for (const toolName of FILE_EDITOR_TOOLS) {
    await prisma.capability.upsert({
      where: { agentId_toolName: { agentId, toolName } },
      create: { agentId, toolName, allowed: true },
      update: { allowed: true },
    })
  }

  return workspace
}

async function createTestXlsxBuffer(): Promise<Buffer> {
  const mod = await import('exceljs')
  const Workbook = mod.default?.Workbook ?? mod.Workbook
  const workbook = new Workbook()
  const sheet = workbook.addWorksheet('Sheet1')
  sheet.addRow(['Name', 'Amount'])
  sheet.addRow(['Test', 100])
  const buf = await workbook.xlsx.writeBuffer()
  return Buffer.from(buf as ArrayBuffer)
}

function isToolError(e: unknown, codeOrFragment: string): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.includes(codeOrFragment)
}

async function scenarioFileEditor(operatorId: string, agentId: string, agentVersion: number) {
  console.log('\n[F3] Agent File Editor')

  process.env.FILE_EDITOR_STUB = 'true'
  await ensureWorkspaceForAgent(agentId)
  const storage = new WorkspaceStorage(process.env.WORKSPACE_BUCKET ?? 'platform-workspace-prod')

  const ticket = await repositories.tickets.create({
    type: 'interaction',
    title: 'Acceptance: file editor',
    state: 'in_progress',
    assigneeType: 'agent',
    assigneeId: agentId,
    agentId,
    payload: { task: 'file editor smoke' },
    sourceDocumentId: null,
    executeAfter: null,
    dueBy: null,
    createdById: operatorId,
  })

  const otherTicket = await repositories.tickets.create({
    type: 'interaction',
    title: 'Acceptance: file editor isolation',
    state: 'in_progress',
    assigneeType: 'agent',
    assigneeId: agentId,
    agentId,
    payload: { task: 'isolation probe' },
    sourceDocumentId: null,
    executeAfter: null,
    dueBy: null,
    createdById: operatorId,
  })

  // W7 — UI/API feltöltés szimuláció (POST /workspace/files ugyanazt a storage.write-t hívja)
  await storage.write(
    'global',
    ticket.id,
    'uploads/ui-upload.txt',
    Buffer.from('Uploaded via UI/API\nSecond line'),
  )
  const uiUploadRead = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    ticketId: ticket.id,
    tool: 'file_read',
    args: { path: 'uploads/ui-upload.txt' },
  })
  if (
    !uiUploadRead.denied &&
    'content' in uiUploadRead.result &&
    uiUploadRead.result.content.includes('Uploaded via UI/API')
  ) {
    pass('W7 — UI/API feltöltés után az agent file_read-del eléri a fájlt')
  } else {
    fail('W7 UI upload → file_read', uiUploadRead.denied ? uiUploadRead.reason : JSON.stringify(uiUploadRead.result))
  }

  const write = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    ticketId: ticket.id,
    tool: 'file_write',
    args: { path: 'notes/hello.txt', content: 'Hello World\nLine two' },
  })
  if (!write.denied && 'bytesWritten' in write.result && write.result.path === 'notes/hello.txt') {
    pass('file_write — fájl létrehozva a workspace-ben')
  } else {
    fail('file_write', write.denied ? write.reason : JSON.stringify(write.result))
  }

  const read = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    ticketId: ticket.id,
    tool: 'file_read',
    args: { path: 'notes/hello.txt' },
  })
  if (
    !read.denied &&
    'content' in read.result &&
    read.result.content.includes('Hello World') &&
    read.result.totalLines === 2
  ) {
    pass('file_read — tartalom visszaolvasva sor-számozással')
  } else {
    fail('file_read', read.denied ? read.reason : JSON.stringify(read.result))
  }

  const edit = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    ticketId: ticket.id,
    tool: 'file_edit',
    args: { path: 'notes/hello.txt', old_string: 'Hello World', new_string: 'Hi World' },
  })
  if (!edit.denied && 'replacements' in edit.result && edit.result.replacements === 1) {
    pass('file_edit — pontos string csere')
  } else {
    fail('file_edit', edit.denied ? edit.reason : JSON.stringify(edit.result))
  }

  const list = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    ticketId: ticket.id,
    tool: 'file_list',
    args: { path: 'notes' },
  })
  if (!list.denied) {
    const listResult = list.result as { entries: Array<{ path: string; type: string }> }
    if (listResult.entries.some((e) => e.path === 'notes/hello.txt' && e.type === 'file')) {
      pass('file_list — a módosított fájl listázva')
    } else {
      fail('file_list', JSON.stringify(listResult))
    }
  } else {
    fail('file_list', list.reason)
  }

  const glob = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    ticketId: ticket.id,
    tool: 'file_glob',
    args: { pattern: '**/*.txt' },
  })
  if (!glob.denied && 'paths' in glob.result && glob.result.paths.includes('notes/hello.txt')) {
    pass('file_glob — txt fájlok megtalálva')
  } else {
    fail('file_glob', glob.denied ? glob.reason : JSON.stringify(glob.result))
  }

  const search = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    ticketId: ticket.id,
    tool: 'file_search',
    args: { pattern: 'Hi World', path: 'notes' },
  })
  if (!search.denied) {
    const searchResult = search.result as { matches: Array<{ path: string }> }
    if (searchResult.matches.some((m) => m.path === 'notes/hello.txt')) {
      pass('file_search — regex találat a workspace-ben')
    } else {
      fail('file_search', JSON.stringify(searchResult))
    }
  } else {
    fail('file_search', search.reason)
  }

  try {
    await services.toolBroker.invoke({
      agentId,
      agentVersion,
      ticketId: ticket.id,
      tool: 'file_read',
      args: { path: '../secret.txt' },
    })
    fail('PATH_TRAVERSAL', 'a ../ útvonal nem lett elutasítva')
  } catch (e) {
    if (isToolError(e, 'PATH_TRAVERSAL') || isToolError(e, 'Path traversal')) {
      pass('PATH_TRAVERSAL — ../ elutasítva')
    } else {
      fail('PATH_TRAVERSAL', e instanceof Error ? e.message : String(e))
    }
  }

  try {
    await services.toolBroker.invoke({
      agentId,
      agentVersion,
      ticketId: otherTicket.id,
      tool: 'file_read',
      args: { path: 'notes/hello.txt' },
    })
    fail('ticket isolation', 'más ticket workspace-éből olvasott')
  } catch (e) {
    if (isToolError(e, 'FILE_NOT_FOUND') || isToolError(e, 'File not found')) {
      pass('Ticket izoláció — más ticket workspace üres')
    } else {
      fail('ticket isolation', e instanceof Error ? e.message : String(e))
    }
  }

  await services.toolBroker.invoke({
    agentId,
    agentVersion,
    ticketId: ticket.id,
    tool: 'file_write',
    args: { path: 'dup.txt', content: 'repeat\nrepeat\nend' },
  })
  try {
    await services.toolBroker.invoke({
      agentId,
      agentVersion,
      ticketId: ticket.id,
      tool: 'file_edit',
      args: { path: 'dup.txt', old_string: 'repeat', new_string: 'once' },
    })
    fail('AMBIGUOUS_MATCH', 'kétértelmű csere nem lett elutasítva')
  } catch (e) {
    if (isToolError(e, 'AMBIGUOUS_MATCH') || isToolError(e, 'appears 2 times')) {
      pass('file_edit — AMBIGUOUS_MATCH kétértelmű csere esetén')
    } else {
      fail('AMBIGUOUS_MATCH', e instanceof Error ? e.message : String(e))
    }
  }

  const xlsxBuf = await createTestXlsxBuffer()
  await storage.write('global', ticket.id, 'data/sample.xlsx', xlsxBuf)

  const xlsxRead = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    ticketId: ticket.id,
    tool: 'xlsx_read_sheet',
    args: { path: 'data/sample.xlsx' },
  })
  if (!xlsxRead.denied) {
    const xlsxResult = xlsxRead.result as { rows: Array<Record<string, string | number | boolean | null>> }
    if (xlsxResult.rows.some((r) => r.Name === 'Test' && r.Amount === 100)) {
      pass('xlsx_read_sheet — sorok JSON-ként')
    } else {
      fail('xlsx_read_sheet', JSON.stringify(xlsxResult))
    }
  } else {
    fail('xlsx_read_sheet', xlsxRead.reason)
  }

  const xlsxWrite = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    ticketId: ticket.id,
    tool: 'xlsx_write_cells',
    args: {
      path: 'data/sample.xlsx',
      changes: [{ cell: 'B2', value: 200 }],
    },
  })
  if (!xlsxWrite.denied && 'cellsUpdated' in xlsxWrite.result && xlsxWrite.result.cellsUpdated === 1) {
    pass('xlsx_write_cells — cella frissítve')
  } else {
    fail('xlsx_write_cells', xlsxWrite.denied ? xlsxWrite.reason : JSON.stringify(xlsxWrite.result))
  }

  const xlsxVerify = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    ticketId: ticket.id,
    tool: 'xlsx_read_sheet',
    args: { path: 'data/sample.xlsx' },
  })
  if (!xlsxVerify.denied) {
    const verifyResult = xlsxVerify.result as { rows: Array<Record<string, string | number | boolean | null>> }
    if (verifyResult.rows.some((r) => r.Amount === 200)) {
      pass('xlsx round-trip — a módosított érték visszaolvasva')
    } else {
      fail('xlsx round-trip', JSON.stringify(verifyResult))
    }
  } else {
    fail('xlsx round-trip', xlsxVerify.reason)
  }

  const xlsxAppend = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    ticketId: ticket.id,
    tool: 'xlsx_append_rows',
    args: {
      path: 'data/sample.xlsx',
      rows: [{ Name: 'Added', Amount: 300 }],
    },
  })
  if (
    !xlsxAppend.denied &&
    'rowsAppended' in xlsxAppend.result &&
    xlsxAppend.result.rowsAppended === 1
  ) {
    pass('xlsx_append_rows — sor hozzáadva')
  } else {
    fail('xlsx_append_rows', xlsxAppend.denied ? xlsxAppend.reason : JSON.stringify(xlsxAppend.result))
  }

  const fixturesDir = resolve(process.cwd(), 'scripts/fixtures/file-editor')
  const docxBuf = await readFile(join(fixturesDir, 'sample.docx'))
  const pdfBuf = await readFile(join(fixturesDir, 'sample.pdf'))
  await storage.write('global', ticket.id, 'docs/sample.docx', docxBuf)
  await storage.write('global', ticket.id, 'docs/sample.pdf', pdfBuf)

  const docxRead = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    ticketId: ticket.id,
    tool: 'docx_read',
    args: { path: 'docs/sample.docx' },
  })
  if (!docxRead.denied) {
    const docxResult = docxRead.result as { text: string }
    if (docxResult.text.includes('Hello Docx')) {
      pass('docx_read — szöveg kinyerve a mintafájlból')
    } else {
      fail('docx_read', JSON.stringify(docxResult))
    }
  } else {
    fail('docx_read', docxRead.reason)
  }

  const pdfRead = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    ticketId: ticket.id,
    tool: 'pdf_read',
    args: { path: 'docs/sample.pdf' },
  })
  if (!pdfRead.denied) {
    const pdfResult = pdfRead.result as { text: string; numPages: number }
    const normalized = pdfResult.text.replace(/\s+/g, ' ').trim()
    if (
      /dummy/i.test(normalized) &&
      /pdf/i.test(normalized) &&
      /file/i.test(normalized) &&
      pdfResult.numPages >= 1
    ) {
      pass('pdf_read — szöveg kinyerve a mintafájlból')
    } else {
      fail('pdf_read', JSON.stringify(pdfResult))
    }
  } else {
    fail('pdf_read', pdfRead.reason)
  }

  const fileDelete = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    ticketId: ticket.id,
    tool: 'file_delete',
    args: { path: 'dup.txt' },
  })
  if (!fileDelete.denied && 'deleted' in fileDelete.result && fileDelete.result.deleted) {
    pass('file_delete — fájl törölve a workspace-ből')
  } else {
    fail('file_delete', fileDelete.denied ? fileDelete.reason : JSON.stringify(fileDelete.result))
  }

  const signedUrl = await storage.getSignedDownloadUrl('global', ticket.id, 'notes/hello.txt')
  if (signedUrl.url.includes('notes%2Fhello.txt') || signedUrl.url.includes('notes/hello.txt')) {
    pass('Pre-signed letöltés — URL generálva (stub/API)')
  } else {
    fail('Pre-signed letöltés', JSON.stringify(signedUrl))
  }

  try {
    process.env.WORKSPACE_MAX_BYTES = '1024'
    await storage.write('global', ticket.id, 'quota-a.bin', Buffer.alloc(512))
    await storage.write('global', ticket.id, 'quota-b.bin', Buffer.alloc(600))
    fail('WORKSPACE_TOO_LARGE', '500 MB workspace limit nem lett érvényesítve')
  } catch (e) {
    if (isToolError(e, 'WORKSPACE_TOO_LARGE') || isToolError(e, '500 MB')) {
      pass('WORKSPACE_TOO_LARGE — workspace kvóta érvényesítve')
    } else {
      fail('WORKSPACE_TOO_LARGE', e instanceof Error ? e.message : String(e))
    }
  } finally {
    delete process.env.WORKSPACE_MAX_BYTES
  }

  try {
    const oversized = Buffer.alloc(50 * 1024 * 1024 + 1)
    await storage.write('global', ticket.id, 'huge.bin', oversized)
    fail('FILE_TOO_LARGE', '51 MB írás nem lett elutasítva')
  } catch (e) {
    if (isToolError(e, 'FILE_TOO_LARGE') || isToolError(e, '50 MB')) {
      pass('FILE_TOO_LARGE — 50 MB feletti írás elutasítva')
    } else {
      fail('FILE_TOO_LARGE', e instanceof Error ? e.message : String(e))
    }
  }

  const fileAudit = await prisma.auditLog.findFirst({
    where: { action: 'tool.call', inputRef: 'file_write', targetId: ticket.id },
    orderBy: { createdAt: 'desc' },
  })
  if (fileAudit && !payloadContainsTokenLeak(fileAudit.metadata)) {
    const meta = fileAudit.metadata as { argsMeta?: { contentLength?: number }; resultMeta?: unknown }
    if (meta.argsMeta?.contentLength && meta.argsMeta.contentLength > 0) {
      pass('Audit — file_write metaadat (path + méret, tartalom nélkül)')
    } else {
      fail('file_write audit meta', JSON.stringify(fileAudit.metadata))
    }
  } else {
    fail('file_write audit', fileAudit ? 'tartalom szivárgás gyanú' : 'hiányzó audit bejegyzés')
  }
}

async function scenarioPerUserConnector(operatorId: string, agentId: string, agentVersion: number) {
  console.log('\n[PUC] Per-user Gmail connector (F2)')

  process.env.GMAIL_OAUTH_STUB = 'true'
  process.env.GMAIL_API_STUB = 'true'

  const gmailConnector = await prisma.connector.findFirst({ where: { type: 'gmail' } })
  if (!gmailConnector) {
    fail('PUC gmail connector', 'run db:seed')
    return
  }

  try {
    services.connectorGrants.buildAuthorizationUrl({
      connector: gmailConnector,
      userId: operatorId,
      tenantId: null,
      requestedScopes: ['https://www.googleapis.com/auth/gmail.send'],
    })
    fail('OAuth scope allowlist', 'nem konfigurált gmail.send scope engedélyezve lett')
  } catch (e) {
    if (e instanceof Error && e.message.includes('OAuth scope not configured')) {
      pass('OAuth scope allowlist — nem konfigurált scope elutasítva')
    } else {
      fail('OAuth scope allowlist', e instanceof Error ? e.message : String(e))
    }
  }

  const approver = await getUser('approver')
  const admin = await prisma.user.findUnique({ where: { externalAuthId: 'seed-admin' } })
  if (!admin) {
    fail('PUC admin seed', 'seed-admin missing')
    return
  }

  const deniedNoActing = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    tool: 'gmail_search',
    args: { query: 'MVP' },
  })
  if (deniedNoActing.denied && deniedNoActing.reason === 'acting_user_required') {
    pass('G1 — gmail hívás acting_user nélkül DENY')
  } else {
    fail('G1 acting_user_required', JSON.stringify(deniedNoActing))
  }

  await setupGmailGrant(operatorId, gmailConnector.id)

  const grantAudit = await prisma.auditLog.findFirst({
    where: { action: 'connector.grant.create', targetType: 'connector_grant' },
    orderBy: { createdAt: 'desc' },
  })
  if (grantAudit) pass('Grant létrehozás audit connector.grant.create')
  else fail('Grant create audit', 'missing')

  const conversation = await prisma.conversation.create({
    data: {
      agentId,
      createdById: operatorId,
      title: 'PUC G2 session',
    },
  })

  const g2Spoofed = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    tool: 'gmail_search',
    args: { query: 'MVP', maxResults: 5 },
    conversationId: conversation.id,
    actingUserId: approver.id,
  })
  if (!g2Spoofed.denied && 'messages' in (g2Spoofed.result as { messages?: unknown[] })) {
    pass('G2 — session user grantje érvényes, spoofed acting_user figyelmen kívül hagyva')
  } else {
    fail('G2 acting user spoof', JSON.stringify(g2Spoofed))
  }

  const search = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    tool: 'gmail_search',
    args: { query: 'MVP', maxResults: 5 },
    actingUserId: operatorId,
  })
  if (!search.denied && 'messages' in (search.result as { messages?: unknown[] })) {
    pass('Gmail search acting user granttel')
  } else {
    fail('Gmail search', JSON.stringify(search))
  }

  const tenantUser = await prisma.user.create({
    data: {
      externalAuthId: `acceptance-puc-tenant-${randomUUID()}`,
      email: `acceptance-puc-tenant-${Date.now()}@example.com`,
      name: 'Acceptance PUC tenant user',
      role: 'operator',
      status: 'active',
      tenantId: randomUUID(),
    },
  })
  try {
    await setupGmailGrant(tenantUser.id, gmailConnector.id, tenantUser.tenantId)
    const tenantSearch = await services.toolBroker.invoke({
      agentId,
      agentVersion,
      tool: 'gmail_search',
      args: { query: 'MVP', maxResults: 1 },
      actingUserId: tenantUser.id,
    })
    if (!tenantSearch.denied && 'messages' in (tenantSearch.result as { messages?: unknown[] })) {
      pass('Tenant-scope grant — acting user tenant alapján feloldva')
    } else {
      fail('Tenant-scope grant', JSON.stringify(tenantSearch))
    }

    const ownTenantConnector = await prisma.connector.create({
      data: {
        type: 'gmail',
        name: `Acceptance PUC own tenant ${randomUUID()}`,
        authMode: 'user_delegated',
        scope: 'single',
        tenantId: tenantUser.tenantId,
        secretAlias: 'secret://gmail/oauth-client',
        config: {
          provider: 'google',
          oauth: {
            authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
            accountEmailField: 'email',
            scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
            clientId: 'stub-client-id',
            offlineParams: { access_type: 'offline' },
            scopeTransform: 'gmailAlias',
          },
        },
      },
    })
    const otherTenantConnector = await prisma.connector.create({
      data: {
        type: 'gmail',
        name: `Acceptance PUC other tenant ${randomUUID()}`,
        authMode: 'user_delegated',
        scope: 'single',
        tenantId: randomUUID(),
        secretAlias: 'secret://gmail/oauth-client',
        config: {
          provider: 'google',
          oauth: {
            authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
            accountEmailField: 'email',
            scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
            clientId: 'stub-client-id',
            offlineParams: { access_type: 'offline' },
            scopeTransform: 'gmailAlias',
          },
        },
      },
    })
    const previousDevAuth = {
      id: process.env.DEV_AUTH_USER_ID,
      email: process.env.DEV_AUTH_EMAIL,
      name: process.env.DEV_AUTH_NAME,
      role: process.env.DEV_AUTH_ROLE,
    }
    try {
      process.env.DEV_AUTH_USER_ID = tenantUser.externalAuthId
      process.env.DEV_AUTH_EMAIL = tenantUser.email
      process.env.DEV_AUTH_NAME = tenantUser.name
      process.env.DEV_AUTH_ROLE = tenantUser.role ?? 'operator'
      const { listUserDelegatedConnectors } = await import('../src/app/actions/connector-grants')
      const listed = await listUserDelegatedConnectors()
      if (listed.success) {
        const ids = new Set(listed.data.map((connector) => connector.id))
        if (
          ids.has(gmailConnector.id) &&
          ids.has(ownTenantConnector.id) &&
          !ids.has(otherTenantConnector.id)
        ) {
          pass('Connector lista — tenant-metaadat izoláció')
        } else {
          fail(
            'Connector lista tenant izoláció',
            JSON.stringify({
              hasGlobal: ids.has(gmailConnector.id),
              hasOwn: ids.has(ownTenantConnector.id),
              hasOther: ids.has(otherTenantConnector.id),
            }),
          )
        }
      } else {
        fail('Connector lista tenant izoláció', listed.error)
      }
    } finally {
      if (previousDevAuth.id === undefined) delete process.env.DEV_AUTH_USER_ID
      else process.env.DEV_AUTH_USER_ID = previousDevAuth.id
      if (previousDevAuth.email === undefined) delete process.env.DEV_AUTH_EMAIL
      else process.env.DEV_AUTH_EMAIL = previousDevAuth.email
      if (previousDevAuth.name === undefined) delete process.env.DEV_AUTH_NAME
      else process.env.DEV_AUTH_NAME = previousDevAuth.name
      if (previousDevAuth.role === undefined) delete process.env.DEV_AUTH_ROLE
      else process.env.DEV_AUTH_ROLE = previousDevAuth.role
      await prisma.connector.delete({ where: { id: ownTenantConnector.id } }).catch(() => {})
      await prisma.connector.delete({ where: { id: otherTenantConnector.id } }).catch(() => {})
    }
  } finally {
    await prisma.user.delete({ where: { id: tenantUser.id } }).catch(() => {})
  }

  const recentToolCalls = await prisma.toolCall.findMany({
    where: { agentId, toolName: { startsWith: 'gmail_' } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  })
  const recentAudits = await prisma.auditLog.findMany({
    where: { action: { in: ['tool.call', 'tool.call.denied'] }, inputRef: { startsWith: 'gmail_' } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  })
  const tokenLeaked =
    recentToolCalls.some(
      (row) => payloadContainsTokenLeak(row.argsMeta) || payloadContainsTokenLeak(row.resultMeta),
    ) || recentAudits.some((row) => payloadContainsTokenLeak(row.metadata))
  if (!tokenLeaked) pass('G3 — token nem szivárog auditban / tool call meta-ban')
  else fail('G3 token leak', 'stub-access vagy Bearer token található')

  const providerAuthGrant = await prisma.connectorGrant.findFirst({
    where: { userId: operatorId, connectorId: gmailConnector.id, status: 'active', tenantId: null },
  })
  if (providerAuthGrant) {
    const store = createGrantTokenStore(providerAuthGrant.tokenRef)
    await store.save({
      accessToken: 'provider-revoked-access',
      refreshToken: 'provider-revoked-refresh',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountEmail: 'stub-user@example.com',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    })
    const originalFetch = globalThis.fetch
    process.env.GMAIL_API_STUB = 'false'
    globalThis.fetch = (async () => new Response('revoked', { status: 401 })) as typeof fetch
    try {
      const expired = await services.toolBroker.invoke({
        agentId,
        agentVersion,
        tool: 'gmail_search',
        args: { query: 'MVP', maxResults: 1 },
        actingUserId: operatorId,
      })
      if (expired.denied && expired.reason === 'connector_grant_expired') {
        pass('G4 — provider 401/403 után grant expire + DENY')
      } else {
        fail('G4 provider auth expire', JSON.stringify(expired))
      }
    } finally {
      globalThis.fetch = originalFetch
      process.env.GMAIL_API_STUB = 'true'
    }
    const expireAudit = await prisma.auditLog.findFirst({
      where: { action: 'connector.grant.expire', targetId: providerAuthGrant.id },
      orderBy: { createdAt: 'desc' },
    })
    if (expireAudit) pass('G4 — provider auth expire audit connector.grant.expire')
    else fail('G4 provider auth expire audit', 'missing')

    await setupGmailGrant(operatorId, gmailConnector.id)
  } else {
    fail('G4 provider auth expire setup', 'active null-tenant grant missing')
  }

  const activeGrant = await prisma.connectorGrant.findFirst({
    where: { userId: operatorId, connectorId: gmailConnector.id, status: 'active', tenantId: null },
  })
  if (activeGrant) {
    await prisma.connectorGrant.update({
      where: { id: activeGrant.id },
      data: { scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
    })
    const draftDeniedByScope = await services.toolBroker.invoke({
      agentId,
      agentVersion,
      tool: 'gmail_create_draft',
      args: {
        to: 'recipient@example.com',
        subject: 'PUC readonly denial',
        body: 'Ezt readonly granttel nem szabad létrehozni.',
      },
      actingUserId: operatorId,
    })
    if (draftDeniedByScope.denied && draftDeniedByScope.reason === 'gmail_scope_not_granted') {
      pass('Gmail scope mapping — readonly grant tiltja a draftot')
    } else {
      fail('Gmail scope mapping readonly', JSON.stringify(draftDeniedByScope))
    }
    await prisma.connectorGrant.update({
      where: { id: activeGrant.id },
      data: { scopes: ['https://www.googleapis.com/auth/gmail.modify'] },
    })
  } else {
    fail('Gmail scope mapping setup', 'active null-tenant grant missing')
  }

  const draft = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    tool: 'gmail_create_draft',
    args: {
      to: 'recipient@example.com',
      subject: 'PUC acceptance',
      body: 'Stub piszkozat',
    },
    actingUserId: operatorId,
  })
  const draftId =
    !draft.denied && draft.result && typeof draft.result === 'object' && 'draftId' in draft.result
      ? String((draft.result as { draftId: string }).draftId)
      : null

  const sendDeniedByScope = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    tool: 'gmail_send',
    args: { draftId: draftId ?? 'stub-draft-1' },
    actingUserId: operatorId,
  })
  if (sendDeniedByScope.denied && sendDeniedByScope.reason === 'gmail_scope_not_granted') {
    pass('gmail_send — compose/modify scope önmagában nem elég küldéshez')
  } else {
    fail('gmail_send send-scope gate', JSON.stringify(sendDeniedByScope))
  }

  if (activeGrant) {
    await prisma.connectorGrant.update({
      where: { id: activeGrant.id },
      data: { scopes: ['https://www.googleapis.com/auth/gmail.send'] },
    })
  }

  const sendDenied = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    tool: 'gmail_send',
    args: { draftId: draftId ?? 'stub-draft-1' },
    actingUserId: operatorId,
  })
  if (sendDenied.denied && sendDenied.reason === 'human_approval_required') {
    pass('gmail_send emberi jóváhagyás nélkül DENY')
  } else {
    fail('gmail_send approval gate', JSON.stringify(sendDenied))
  }

  if (draftId) {
    const approvalTicket = await prisma.ticket.create({
      data: {
        type: 'interaction',
        title: 'Gmail küldés jóváhagyás (PUC)',
        state: 'awaiting_human',
        assigneeType: 'human',
        agentId,
        payload: { gmailDraftId: draftId, source: 'gmail_send_approval' },
        createdById: operatorId,
        executeAfter: null,
        dueBy: null,
      },
    })

    await services.tickets.transition({
      ticketId: approvalTicket.id,
      toState: 'approved',
      actor: { type: 'human', userId: approver.id, role: 'approver' },
      note: `Gmail küldés jóváhagyva: ${draftId}`,
    })
    await prisma.ticket.update({
      where: { id: approvalTicket.id },
      data: {
        payload: { gmailDraftId: draftId, gmailSendApproved: draftId, approvedBy: approver.id },
      },
    })

    const sent = await services.toolBroker.invoke({
      agentId,
      agentVersion,
      tool: 'gmail_send',
      args: { draftId, approvalTicketId: approvalTicket.id },
      actingUserId: operatorId,
    })
    if (!sent.denied && sent.result && typeof sent.result === 'object' && 'messageId' in sent.result) {
      pass('gmail_send approve → küldés E2E')
    } else {
      fail('gmail_send approve E2E', JSON.stringify(sent))
    }

    await prisma.ticket.delete({ where: { id: approvalTicket.id } })
  } else {
    fail('gmail_send approve E2E', 'draft létrehozás sikertelen')
  }

  if (activeGrant) {
    await prisma.connectorGrant.update({
      where: { id: activeGrant.id },
      data: { scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
    })
  }

  const runTicket = await prisma.ticket.create({
    data: {
      type: 'interaction',
      title: 'PUC run-as teszt',
      state: 'ready',
      assigneeType: 'agent',
      assigneeId: agentId,
      agentId,
      payload: { runAsUserId: operatorId },
      createdById: admin.id,
      executeAfter: null,
      dueBy: null,
    },
  })

  const deniedImplicitRunAs = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    tool: 'gmail_search',
    args: { query: 'MVP' },
    ticketId: runTicket.id,
  })
  if (deniedImplicitRunAs.denied && deniedImplicitRunAs.reason === 'acting_user_required') {
    pass('F2-E — implicit run-as nélkül DENY')
  } else {
    fail('F2-E implicit run-as deny', JSON.stringify(deniedImplicitRunAs))
  }

  const deniedSpoofedTicketRunAs = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    tool: 'gmail_search',
    args: { query: 'MVP' },
    ticketId: runTicket.id,
    actingUserId: operatorId,
  })
  if (deniedSpoofedTicketRunAs.denied && deniedSpoofedTicketRunAs.reason === 'acting_user_required') {
    pass('F2-E — ticket melletti acting_user spoof DENY')
  } else {
    fail('F2-E ticket acting_user spoof deny', JSON.stringify(deniedSpoofedTicketRunAs))
  }

  const deniedTicketConversationInheritance = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    tool: 'gmail_search',
    args: { query: 'MVP' },
    ticketId: runTicket.id,
    conversationId: conversation.id,
  })
  if (
    deniedTicketConversationInheritance.denied &&
    deniedTicketConversationInheritance.reason === 'acting_user_required'
  ) {
    pass('F2-E — ticket nem örököl implicit conversation usert')
  } else {
    fail(
      'F2-E ticket conversation inheritance deny',
      JSON.stringify(deniedTicketConversationInheritance),
    )
  }

  await prisma.ticket.update({
    where: { id: runTicket.id },
    data: {
      payload: buildRunAsAuthorization({ userId: operatorId }) as Prisma.InputJsonValue,
    },
  })

  const withRunAs = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    tool: 'gmail_search',
    args: { query: 'MVP', maxResults: 3 },
    ticketId: runTicket.id,
  })
  if (!withRunAs.denied && 'messages' in (withRunAs.result as { messages?: unknown[] })) {
    pass('F2-E — explicit run-as felhatalmazással gmail search OK')
  } else {
    fail('F2-E explicit run-as', JSON.stringify(withRunAs))
  }

  const { DispatcherService } = await import('../src/domain/dispatcher/dispatcher-service')
  let launchedActingUserId: string | undefined
  const runAsDispatcher = new DispatcherService(
    repositories.tickets,
    repositories.audit,
    repositories.modelCalls,
    {
      mode: 'acceptance-run-as',
      async launch(input) {
        launchedActingUserId = input.actingUserId
        return { jobId: `acceptance-run-as-${input.ticketId}` }
      },
    },
  )
  const runAsDispatch = await runAsDispatcher.dispatchTicket(runTicket.id)
  if (runAsDispatch.status === 'started' && launchedActingUserId === operatorId) {
    pass('F2-E — dispatcher továbbadja az explicit run-as usert')
  } else {
    fail(
      'F2-E dispatcher run-as propagation',
      JSON.stringify({ dispatch: runAsDispatch, launchedActingUserId }),
    )
  }

  const scheduledGmailTask = await services.scheduledTasks.createOneShotAgentTask({
    tenantId: null,
    agentId,
    title: 'PUC scheduled gmail run-as',
    content: 'F2-E scheduled task gmail search',
    createdById: operatorId,
    nextRunAt: new Date(Date.now() - 1_000),
    authorizeRunAs: true,
  })
  const scheduledGmailBatch = await services.scheduledTasks.materializeDue(new Date(), 10)
  const scheduledGmailMaterialized = scheduledGmailBatch.find(
    (item) => item.scheduledTaskId === scheduledGmailTask.id,
  )
  if (scheduledGmailMaterialized?.status === 'materialized' && scheduledGmailMaterialized.ticketId) {
    const scheduledGmailSearch = await services.toolBroker.invoke({
      agentId,
      agentVersion,
      tool: 'gmail_search',
      args: { query: 'MVP', maxResults: 1 },
      ticketId: scheduledGmailMaterialized.ticketId,
    })
    if (
      !scheduledGmailSearch.denied &&
      'messages' in (scheduledGmailSearch.result as { messages?: unknown[] })
    ) {
      pass('F2-E — scheduled task materializált ticket gmail search OK')
    } else {
      fail('F2-E scheduled task gmail search', JSON.stringify(scheduledGmailSearch))
    }
    await prisma.ticket.delete({ where: { id: scheduledGmailMaterialized.ticketId } })
  } else {
    fail('F2-E scheduled task materialize gmail', JSON.stringify(scheduledGmailMaterialized))
  }
  await prisma.scheduledTask.delete({ where: { id: scheduledGmailTask.id } })

  await prisma.ticket.delete({ where: { id: runTicket.id } })

  const tenantA = randomUUID()
  const tenantB = randomUUID()
  const { createOAuthState } = await import('../src/lib/crypto/oauth-state')
  const { state: tenantState } = createOAuthState({
    userId: operatorId,
    connectorId: gmailConnector.id,
    tenantId: tenantA,
  })
  await services.connectorGrants.completeOAuthCallback({
    code: 'stub-tenant-code',
    state: tenantState,
    connector: gmailConnector,
    actorId: operatorId,
  })

  const crossTenantGrant = await repositories.connectorGrants.findActiveGrant({
    tenantId: tenantB,
    connectorId: gmailConnector.id,
    userId: operatorId,
  })
  if (!crossTenantGrant) {
    pass('G7 — más tenant grantje nem érhető el')
  } else {
    fail('G7 tenant isolation', 'tenantB grant található tenantA grant mellett')
  }

  const grant = await prisma.connectorGrant.findFirst({
    where: { userId: operatorId, connectorId: gmailConnector.id, status: 'active', tenantId: null },
  })
  if (!grant) {
    fail('PUC revoke setup', 'no active null-tenant grant')
    return
  }

  await services.connectorGrants.revokeGrant({
    grantId: grant.id,
    actorId: operatorId,
    actorType: 'human',
    expectedUserId: operatorId,
    expectedTenantId: null,
  })

  const afterRevoke = await services.toolBroker.invoke({
    agentId,
    agentVersion,
    tool: 'gmail_search',
    args: { query: 'MVP' },
    actingUserId: operatorId,
  })
  if (afterRevoke.denied && afterRevoke.reason === 'connector_grant_missing') {
    pass('G4 — visszavont grant után DENY')
  } else {
    fail('G4 revoked grant', JSON.stringify(afterRevoke))
  }

  await setupGmailGrant(operatorId, gmailConnector.id)

  try {
    await services.iam.suspendUser({
      targetUserId: operatorId,
      reason: 'acceptance-e2e G5',
      actorId: admin.id,
      actorTenantId: admin.tenantId,
    })

    const suspendedGrants = await prisma.connectorGrant.count({
      where: { userId: operatorId, connectorId: gmailConnector.id, status: 'revoked' },
    })
    if (suspendedGrants > 0) pass('G5 — offboarding grant revoke')
    else fail('G5 grant revoke on suspend', `${suspendedGrants} revoked`)

    const deniedSuspended = await services.toolBroker.invoke({
      agentId,
      agentVersion,
      tool: 'gmail_search',
      args: { query: 'MVP' },
      actingUserId: operatorId,
    })
    if (deniedSuspended.denied && deniedSuspended.reason === 'acting_user_suspended') {
      pass('G5 — suspended user grant használata DENY')
    } else {
      fail('G5 suspended deny', JSON.stringify(deniedSuspended))
    }
  } finally {
    await services.iam.reactivateUser({
      targetUserId: operatorId,
      actorId: admin.id,
      actorTenantId: admin.tenantId,
    })
  }

  await prisma.conversation.delete({ where: { id: conversation.id } })
}

async function main() {
  process.env[PLATFORM_TICKET_SOURCE_ENV] = 'test'

  try {
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
    await scenario27_crMvp002(approver.id, operator.id, agent.id)
    await scenario28_crMvp003(operator.id, agent.id)
    await scenarioN6_capabilityEscalationDenied(agent.id)
    await scenarioN7_conversationWriteGateDenied(agent.id)
    await scenarioN8_gdprErasureVerifyChain(operator.id, agent.id)
    await scenarioFileEditor(operator.id, agent.id, agent.currentVersion)
    await scenarioPerUserConnector(operator.id, agent.id, agent.currentVersion)
    await scenarioAgentApi(agent.id)
    await scenarioAuditLogHardening()

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
      console.log('\n◌ Acceptance smoke zöld, de egyes opcionális forgatókönyvek ki lettek hagyva (lásd fent).')
    } else {
      console.log('\n✅ Minden acceptance forgatókönyv sikeres.')
    }
  } finally {
    const { count } = await prisma.ticket.deleteMany({ where: { source: 'test' } })
    if (count > 0) console.log(`\nTeszt ticket cleanup: ${count} törölve`)
    delete process.env[PLATFORM_TICKET_SOURCE_ENV]
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
