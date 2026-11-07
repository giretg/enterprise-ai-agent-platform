/**
 * Csak olvas: megméri, a régi munkafájlok hány százalékánál becsülhető az író az audit-sorokból (#1113 WP-1).
 * Fájlnevet és tartalmat nem ír ki, és semmit sem módosít.
 * Futtatás: npx tsx scripts/work-file-writer-estimate.ts
 */
import { prisma } from '../src/lib/db'
import { estimateWorkFileWriter, type WriterEvent } from '../src/lib/work-file-writer-estimate'

const AGENT_WRITE_TOOLS = ['platform.work_file.write', 'platform.work_file.append', 'sandbox_run']
const HUMAN_WRITE_ACTION = 'project.work_file.write'

async function main() {
  const files = await prisma.workFile.findMany({
    where: { lastWriterAgentId: null, createdByAgentId: null },
    select: { tenantId: true, path: true, updatedAt: true, lastWriterUserId: true },
  })
  const totals = { agent: 0, human: 0, ambiguous: 0, none: 0 }
  for (const tenantId of new Set(files.map((file) => file.tenantId))) {
    const rows = await prisma.auditLog.findMany({
      where: {
        tenantId,
        OR: [
          { action: 'enterprise.tool.ok', inputRef: { in: AGENT_WRITE_TOOLS } },
          { action: HUMAN_WRITE_ACTION },
        ],
      },
      select: { action: true, createdAt: true, actorId: true, inputRef: true, metadata: true },
    })
    const events: WriterEvent[] = []
    for (const row of rows) {
      if (!row.actorId) continue
      if (row.action === HUMAN_WRITE_ACTION) {
        if (row.inputRef) events.push({ kind: 'human', at: row.createdAt, actorId: row.actorId, path: row.inputRef })
        continue
      }
      const agentId = (row.metadata as { agentId?: unknown } | null)?.agentId
      if (typeof agentId === 'string') events.push({ kind: 'agent', at: row.createdAt, actorId: row.actorId, agentId })
    }
    for (const file of files.filter((candidate) => candidate.tenantId === tenantId)) {
      totals[estimateWorkFileWriter(file, events).kind] += 1
    }
  }
  const percent = (count: number) => (files.length ? `${Math.round((count / files.length) * 100)}%` : '0%')
  console.log(`Író nélküli munkafájl: ${files.length}`)
  console.log(`Egy agentre becsülhető: ${totals.agent} (${percent(totals.agent)})`)
  console.log(`Emberi mentés: ${totals.human} (${percent(totals.human)})`)
  console.log(`Több jelölt: ${totals.ambiguous} (${percent(totals.ambiguous)})`)
  console.log(`Nincs találat: ${totals.none} (${percent(totals.none)})`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
