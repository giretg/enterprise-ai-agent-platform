/**
 * Diagnosztika: lefagyott chat / cancel probléma
 * Futtatás: npx tsx scripts/inspect-frozen-chat.ts
 */
import { config } from 'dotenv'
import path from 'path'

config({ path: path.join(process.cwd(), '.env.local') })
config({ path: path.join(process.cwd(), '.env') })

async function main() {
  const { prisma } = await import('../src/lib/db')

  console.log('=== Legutóbbi beszélgetések ===')
  const convs = await prisma.conversation.findMany({
    orderBy: { lastMessageAt: 'desc' },
    take: 5,
    select: {
      id: true,
      title: true,
      agentId: true,
      status: true,
      lastMessageAt: true,
      createdAt: true,
      createdBy: true,
    },
  })
  for (const c of convs) {
    const agent = await prisma.agent.findUnique({
      where: { id: c.agentId },
      select: { name: true, role: true },
    })
    console.log(
      `  ${c.lastMessageAt.toISOString()}  status=${c.status}  agent=${agent?.name ?? '?'} (${c.agentId.slice(0, 8)})  title=${c.title ?? '(cím nélkül)'}  conv=${c.id}`,
    )
  }

  const latest = convs[0]
  if (!latest) {
    console.log('Nincs beszélgetés.')
    await prisma.$disconnect()
    return
  }

  const convId = latest.id
  console.log(`\n=== Üzenetek (conv=${convId}) ===`)
  const messages = await prisma.message.findMany({
    where: { conversationId: convId },
    orderBy: { seq: 'asc' },
    select: {
      id: true,
      seq: true,
      role: true,
      contentRef: true,
      model: true,
      ticketRef: true,
      createdAt: true,
    },
  })
  for (const m of messages) {
    const text = m.contentRef?.startsWith('inline:')
      ? m.contentRef.slice(7).slice(0, 120)
      : m.contentRef?.slice(0, 80)
    console.log(
      `  seq=${m.seq}  ${m.createdAt.toISOString()}  role=${m.role}  model=${m.model ?? '-'}  id=${m.id.slice(0, 8)}  text="${text}${(m.contentRef?.length ?? 0) > 120 ? '…' : ''}"`,
    )
  }

  // Agent részletek
  const agentId = latest.agentId
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { name: true, role: true, modelConfig: true, allowSensitiveExternalModel: true },
  })
  console.log(`\n=== Agent (${agentId}) ===`)
  console.log(JSON.stringify(agent, null, 2))
  const caps = await prisma.capability.findMany({
    where: { agentId, allowed: true },
    select: { toolName: true },
    orderBy: { toolName: 'asc' },
  })
  console.log('Capabilities:', caps.map((c) => c.toolName).join(', '))

  console.log(`\n=== Model hívások a Telex üzenet UTÁN (>=14:10:59) ===`)
  const afterTelex = await prisma.modelCall.findMany({
    where: { conversationId: convId, createdAt: { gte: new Date('2026-07-12T14:10:59Z') } },
    orderBy: { createdAt: 'asc' },
  })
  if (afterTelex.length === 0) console.log('  ❌ EGY SEM — a modellhívás el sem indult vagy még fut')
  for (const mc of afterTelex) {
    console.log(
      `  ${mc.createdAt.toISOString()}  ${mc.provider}/${mc.model}  status=${mc.status}  latency=${mc.latencyMs}ms`,
    )
  }

  const modelCalls = await prisma.modelCall.findMany({
    where: { conversationId: convId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      provider: true,
      model: true,
      status: true,
      promptTokens: true,
      completionTokens: true,
      latencyMs: true,
      createdAt: true,
    },
  })
  if (modelCalls.length === 0) console.log('  (nincs)')
  for (const mc of modelCalls) {
    console.log(
      `  ${mc.createdAt.toISOString()}  ${mc.provider}/${mc.model}  status=${mc.status}  tokens=${mc.promptTokens}+${mc.completionTokens}  latency=${mc.latencyMs}ms  id=${mc.id.slice(0, 8)}`,
    )
  }

  console.log(`\n=== Tool hívások (conv=${convId}) ===`)
  const toolCalls = await prisma.toolCall.findMany({
    where: { conversationId: convId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      toolName: true,
      status: true,
      latencyMs: true,
      createdAt: true,
      argsMeta: true,
      resultMeta: true,
    },
  })
  if (toolCalls.length === 0) console.log('  (nincs)')
  for (const tc of toolCalls) {
    const meta = tc.argsMeta ? JSON.stringify(tc.argsMeta).slice(0, 100) : '-'
    console.log(
      `  ${tc.createdAt.toISOString()}  ${tc.toolName}  status=${tc.status}  latency=${tc.latencyMs}ms  meta=${meta}`,
    )
  }

  console.log(`\n=== Audit log (conv=${convId}, utolsó 30) ===`)
  const audit = await prisma.auditLog.findMany({
    where: { conversationId: convId },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: {
      seq: true,
      action: true,
      actorType: true,
      policyDecision: true,
      createdAt: true,
      metadata: true,
      inputRef: true,
      outputRef: true,
    },
  })
  if (audit.length === 0) console.log('  (nincs)')
  for (const a of audit.reverse()) {
    const meta = a.metadata ? JSON.stringify(a.metadata).slice(0, 80) : '-'
    console.log(
      `  ${a.createdAt.toISOString()}  seq=${a.seq}  ${a.action}  actor=${a.actorType}  policy=${a.policyDecision ?? '-'}  meta=${meta}`,
    )
  }

  console.log(`\n=== Ticket-ek (conv=${convId}) ===`)
  const tickets = await prisma.ticket.findMany({
    where: { conversationId: convId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      state: true,
      payload: true,
      executeAfter: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  if (tickets.length === 0) console.log('  (nincs)')
  for (const t of tickets) {
    const payload = t.payload ? JSON.stringify(t.payload).slice(0, 100) : '-'
    console.log(
      `  ${t.createdAt.toISOString()}  state=${t.state}  id=${t.id.slice(0, 8)}  payload=${payload}`,
    )
  }

  // Telex-specifikus keresés
  console.log('\n=== Telex kérdés keresése (összes beszélgetésben) ===')
  const telexMsgs = await prisma.message.findMany({
    where: {
      contentRef: { contains: 'telex', mode: 'insensitive' },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      id: true,
      conversationId: true,
      role: true,
      contentRef: true,
      createdAt: true,
      seq: true,
    },
  })
  for (const m of telexMsgs) {
    const text = m.contentRef?.startsWith('inline:') ? m.contentRef.slice(7) : m.contentRef
    console.log(
      `  ${m.createdAt.toISOString()}  conv=${m.conversationId}  seq=${m.seq}  role=${m.role}  text="${text?.slice(0, 80)}"`,
    )
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('DIAG HIBA:', e instanceof Error ? e.message : e)
  process.exit(1)
})
