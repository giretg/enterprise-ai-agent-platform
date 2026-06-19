/**
 * Régi közös „Excellence Pay belső tudásbázis” connector dokumentumainak
 * áthelyezése agent-saját kb:{agentId} connectorokba (jóváhagyási ticket agentId alapján).
 *
 * Futtatás: npx tsx scripts/migrate-kb-to-owned-connectors.ts
 * Opcionális: --remove-legacy-links (leválasztja az agenteket a régi connectorról)
 */
import { config } from 'dotenv'
import path from 'path'

config({ path: path.join(process.cwd(), '.env.local') })
config({ path: path.join(process.cwd(), '.env') })

const LEGACY_KB_NAME = 'Excellence Pay belső tudásbázis'
const removeLegacyLinks = process.argv.includes('--remove-legacy-links')

async function main() {
  const { prisma } = await import('../src/lib/db')
  const { ensureAgentKnowledgeBase, knowledgeBaseConnectorName } = await import(
    '../src/lib/agent-knowledge-base'
  )

  const legacy = await prisma.connector.findFirst({
    where: { type: 'knowledge_base', name: LEGACY_KB_NAME },
  })
  if (!legacy) {
    console.log('Nincs legacy KB connector — nincs mit migrálni.')
    return
  }

  const docs = await prisma.document.findMany({ where: { connectorId: legacy.id } })
  console.log(`Legacy connector: ${docs.length} dokumentum`)

  let moved = 0
  let skipped = 0

  for (const doc of docs) {
    const ticket = await prisma.ticket.findFirst({
      where: { sourceDocumentId: doc.id, type: 'training' },
      select: { agentId: true },
    })
    if (!ticket?.agentId) {
      console.log(`  skip (nincs ticket agentId): ${doc.filename}`)
      skipped++
      continue
    }

    const agent = await prisma.agent.findUnique({
      where: { id: ticket.agentId },
      select: { id: true, name: true, role: true },
    })
    if (!agent || agent.role === 'orchestrator') {
      console.log(`  skip (érvénytelen agent): ${doc.filename}`)
      skipped++
      continue
    }

    const owned = await ensureAgentKnowledgeBase(agent)
    if (!owned) {
      console.log(`  skip (nincs owned KB): ${doc.filename}`)
      skipped++
      continue
    }

    await prisma.document.update({
      where: { id: doc.id },
      data: { connectorId: owned.id },
    })
    console.log(`  moved: ${doc.filename} → ${knowledgeBaseConnectorName(agent.id)} (${agent.name})`)
    moved++
  }

  if (removeLegacyLinks) {
    const deleted = await prisma.agentConnector.deleteMany({ where: { connectorId: legacy.id } })
    console.log(`Legacy agentConnector linkek törölve: ${deleted.count}`)
  }

  console.log(`Kész. Áthelyezve: ${moved}, kihagyva: ${skipped}`)
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
