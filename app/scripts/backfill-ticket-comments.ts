import { prisma } from '@/lib/db'
import { repositories } from '@/repositories/postgres'

function payloadRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

async function main() {
  const tickets = await prisma.ticket.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      agent: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
    },
  })

  let created = 0
  let skipped = 0

  for (const ticket of tickets) {
    const existing = await prisma.ticketComment.count({ where: { ticketId: ticket.id } })
    if (existing > 0) {
      skipped += 1
      continue
    }

    const payload = payloadRecord(ticket.payload)
    const followUpNotes = Array.isArray(payload.followUpNotes)
      ? payload.followUpNotes.filter((note): note is string => typeof note === 'string' && note.trim().length > 0)
      : []
    const answer = typeof payload.answer === 'string' && payload.answer.trim()
      ? payload.answer.trim()
      : null

    for (const note of followUpNotes) {
      await repositories.tickets.appendComment({
        ticketId: ticket.id,
        kind: 'human_comment',
        authorType: 'human',
        authorUserId: ticket.createdById,
        authorDisplayName: ticket.createdBy.name,
        body: note,
      })
      created += 1
    }

    if (answer) {
      await repositories.tickets.appendComment({
        ticketId: ticket.id,
        kind: 'agent_answer',
        authorType: 'agent',
        authorAgentId: ticket.agentId,
        authorDisplayName: ticket.agent?.name ?? 'Agent',
        agentVersion: typeof payload.agentVersion === 'number' ? payload.agentVersion : null,
        body: answer,
        structured: {
          sources: Array.isArray(payload.sources) ? payload.sources : [],
          rationale: typeof payload.rationale === 'string' ? payload.rationale : null,
          confidence: typeof payload.confidence === 'string' ? payload.confidence : null,
          model: typeof payload.model === 'string' ? payload.model : null,
        },
      })
      created += 1
    }
  }

  console.log(`Backfill complete: created=${created}, skippedTickets=${skipped}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
