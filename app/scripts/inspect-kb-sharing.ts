/**
 * KB connector / megosztás állapot — egyszeri diagnosztika.
 * Futtatás: npx tsx scripts/inspect-kb-sharing.ts
 */
import { config } from 'dotenv'
import path from 'path'

config({ path: path.join(process.cwd(), '.env.local') })
config({ path: path.join(process.cwd(), '.env') })

async function main() {
  const { prisma } = await import('../src/lib/db')

  const agents = await prisma.agent.findMany({
    select: { id: true, name: true, role: true },
    orderBy: { name: 'asc' },
  })

  console.log('=== Agents + KB links ===')
  for (const a of agents) {
    const links = await prisma.agentConnector.findMany({
      where: { agentId: a.id, connector: { type: 'knowledge_base' } },
      include: { connector: { select: { id: true, name: true } } },
      orderBy: { connector: { name: 'asc' } },
    })
    const ownedName = `kb:${a.id}`
    const owned = links.find((l) => l.connector.name === ownedName)
    const findFirst = links[0] ?? null

    console.log(`\n${a.name} (${a.id.slice(0, 8)}…)`)
    for (const l of links) {
      const docCount = await prisma.document.count({
        where: { connectorId: l.connector.id, status: 'processed' },
      })
      const users = await prisma.agentConnector.findMany({
        where: { connectorId: l.connector.id },
        include: { agent: { select: { name: true } } },
      })
      const tag = l.connector.name === ownedName ? '[OWN]' : '[SHARED IN]'
      console.log(
        `  - ${l.connector.name} ${tag} docs=${docCount} agents=${users.map((u) => u.agent.name).join(', ')}`,
      )
    }
    if (findFirst && owned && findFirst.connector.id !== owned.connector.id) {
      console.log('  !!! findConnectorForAgent → SHARED connector (UI bug forrása)')
    }
  }

  console.log('\n=== All KB connectors ===')
  const allKb = await prisma.connector.findMany({
    where: { type: 'knowledge_base' },
    orderBy: { name: 'asc' },
  })
  for (const c of allKb) {
    const users = await prisma.agentConnector.findMany({
      where: { connectorId: c.id },
      include: { agent: { select: { name: true } } },
    })
    const docs = await prisma.document.findMany({
      where: { connectorId: c.id },
      select: { filename: true, status: true },
    })
    console.log(
      `${c.name} | agents: ${users.map((u) => u.agent.name).join(', ')} | docs: ${docs.map((d) => `${d.filename}(${d.status})`).join('; ') || '(none)'}`,
    )
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    const { prisma } = await import('../src/lib/db')
    await prisma.$disconnect()
  })
