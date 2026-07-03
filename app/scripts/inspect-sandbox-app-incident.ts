/**
 * Egyszeri diagnosztika: miért Excel készült sandbox app helyett?
 * Futtatás: npx tsx scripts/inspect-sandbox-app-incident.ts
 */
import { config } from 'dotenv'
import path from 'path'

config({ path: path.join(process.cwd(), '.env.local') })
config({ path: path.join(process.cwd(), '.env') })

const SANDBOX_TOOLS = [
  'sandbox_app.create',
  'sandbox_app.update_artifact',
  'sandbox_app.preview',
  'sandbox_app.export',
]

async function main() {
  const { prisma } = await import('../src/lib/db')

  console.log('=== SandboxApp rekordok (összes) ===')
  const appCount = await prisma.sandboxApp.count()
  const apps = await prisma.sandboxApp.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, name: true, status: true, createdByType: true, createdAt: true },
  })
  console.log(`összes sandbox app: ${appCount}`)
  for (const a of apps) console.log(`  ${a.createdAt.toISOString()}  ${a.status}  ${a.createdByType}  ${a.name}`)

  console.log('\n=== Legutóbbi beszélgetés (posnavigator) ===')
  const convs = await prisma.conversation.findMany({
    orderBy: { lastMessageAt: 'desc' },
    take: 5,
    select: { id: true, title: true, agentId: true, lastMessageAt: true },
  })
  for (const c of convs) console.log(`  ${c.lastMessageAt.toISOString()}  agent=${c.agentId.slice(0, 8)}  ${c.title ?? '(cím nélkül)'}  conv=${c.id.slice(0, 8)}`)

  const agentIds = [...new Set(convs.map((c) => c.agentId))]
  console.log('\n=== Érintett agentek capability-jei (sandbox_app.* vs xlsx) ===')
  for (const agentId of agentIds) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { name: true, role: true } })
    const caps = await prisma.capability.findMany({
      where: { agentId, allowed: true },
      select: { toolName: true },
      orderBy: { toolName: 'asc' },
    })
    const names = caps.map((c) => c.toolName)
    const sandbox = names.filter((n) => SANDBOX_TOOLS.includes(n))
    const xlsx = names.filter((n) => n.startsWith('xlsx_'))
    console.log(`\n  ${agent?.name} (${agent?.role}) — ${agentId.slice(0, 8)}`)
    console.log(`    sandbox_app.* engedélyezett: ${sandbox.length ? sandbox.join(', ') : '❌ EGY SEM'}`)
    console.log(`    xlsx_* engedélyezett: ${xlsx.length ? xlsx.join(', ') : 'nincs'}`)
    console.log(`    összes engedélyezett tool: ${names.join(', ')}`)
  }

  console.log('\n=== Legutóbbi tool-hívás / sandbox audit események ===')
  const events = await prisma.auditLog.findMany({
    where: {
      OR: [
        { action: { startsWith: 'sandbox_app.' } },
        { action: { startsWith: 'tool.call' } },
        { action: 'capability.update' },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: { createdAt: true, action: true, actorType: true, inputRef: true, outputRef: true, policyDecision: true },
  })
  if (events.length === 0) console.log('  (nincs ilyen audit esemény)')
  for (const e of events) {
    console.log(`  ${e.createdAt.toISOString()}  ${e.action}  [${e.policyDecision ?? '-'}]  in=${e.inputRef ?? '-'}  out=${e.outputRef ?? '-'}`)
  }

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('DIAG HIBA:', e instanceof Error ? e.message : e)
  process.exit(1)
})
