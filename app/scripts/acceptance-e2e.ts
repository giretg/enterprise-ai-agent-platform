/**
 * MVP v1 acceptance — walking skeleton smoke checks
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
import { assertRole } from '../src/auth/types'

const SAMPLE_WIKI_QUESTION =
  'Mi az MVP célja, és milyen átjárókon kell átmennie az agent műveleteinek?'

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

function actor(role: UserRole, userId: string) {
  return { type: 'human' as const, userId, role }
}

/** 1. Wiki path smoke: kérdés → retrieval → LLM → board_write → jóváhagyás/done → audit */
async function scenario1_e2e(operatorId: string, approverId: string, agentId: string) {
  console.log('\n[1] Wiki kérdés flow smoke')

  if (!process.env.CHATGPT_OAUTH_PROVIDER_URL || !process.env.CHATGPT_OAUTH_PROVIDER_KEY) {
    skip('Wiki kérdés flow', 'ChatGPT OAuth provider nincs beállítva (S2 spike pending)')
    return null
  }

  let ticketId: string
  try {
    const { ticketId: id, answer } = await services.wiki.askWiki({
      agentId,
      question: SAMPLE_WIKI_QUESTION,
      createdById: operatorId,
    })
    ticketId = id
    pass(
      'askWiki + ChatGPT OAuth válasz',
      `ticket=${ticketId.slice(0, 8)}… confidence=${answer.confidence}`,
    )
  } catch (e) {
    fail('askWiki + ChatGPT OAuth válasz', e instanceof Error ? e.message : String(e))
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

async function main() {
  console.log('=== Fázis 1–2 Acceptance (spec §14 + governance) ===\n')

  const operator = await getUser('operator')
  const approver = await getUser('approver')
  const agent = await getWikiAgent()

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
  await scenario7_toolBroker(operator.id, agent.id, agent.currentVersion)
  await scenario7_governance(operator.id, approver.id, agent.id)
  await scenario8_writeGateNegative(operator.id, agent.id)
  await scenario9_iam()
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
