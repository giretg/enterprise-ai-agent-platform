import { activeRunFromChatTurn, activeRunFromTicket } from '@/lib/active-runs-map'
import type { ActiveRun } from '@/lib/active-runs'
import { shouldExcludeHiddenAgents } from '@/lib/agent-operator-visibility'
import { agentDisplayName } from '@/lib/agent-persona'
import { repositories } from '@/repositories/postgres'
import type { UserRole } from '@prisma/client'

const ACTIVE_TICKET_STATES = ['in_progress', 'awaiting_human', 'needs_info'] as const
const COMPLETED_TICKET_STATES = ['done', 'rejected'] as const

export type ActiveRunsLoadContext = {
  tenantId: string
  userId: string
  activeTenantRole: UserRole | null
}

/**
 * Saját futások: a bejelentkezett user chat-fordulói, plusz az általa indított
 * vagy human assignee-ként rá szignált ticketek (ugyanaz, mint a header Futások panel).
 */
export async function loadActiveRuns(ctx: ActiveRunsLoadContext): Promise<ActiveRun[]> {
  const { tenantId, userId, activeTenantRole } = ctx

  const [activeTurns, terminalTurns, activeTicketPage, completedTicketPage] = await Promise.all([
    repositories.agentTurns.listActiveByTenant(tenantId, { createdById: userId, limit: 50 }),
    repositories.agentTurns.listRecentTerminalByTenant(tenantId, {
      createdById: userId,
      limit: 30,
    }),
    repositories.tickets.listPage({
      tenantId,
      belongingToUserId: userId,
      state: [...ACTIVE_TICKET_STATES],
      excludeTest: true,
      limit: 50,
    }),
    repositories.tickets.listPage({
      tenantId,
      belongingToUserId: userId,
      state: [...COMPLETED_TICKET_STATES],
      excludeTest: true,
      limit: 30,
    }),
  ])

  const agentIds = [
    ...new Set(
      [...activeTurns, ...terminalTurns, ...activeTicketPage.items, ...completedTicketPage.items]
        .map((row) => row.agentId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ]

  // Szerep nélkül fail-closed: a rejtett agentek futásai nem szivárognak ki.
  const hidesRestrictedAgents =
    activeTenantRole == null || shouldExcludeHiddenAgents(activeTenantRole)

  const agents =
    agentIds.length > 0
      ? await repositories.agents.findMany({
          tenantId,
          ids: agentIds,
          excludeHiddenFromOperators: hidesRestrictedAgents,
          unbounded: true,
        })
      : []
  const agentNameById = new Map(
    agents.map((agent) => [agent.id, agentDisplayName(agent.name, agent)]),
  )
  const visibleAgentIds = new Set(agents.map((agent) => agent.id))
  const canShowRun = (agentId: string | null) =>
    !hidesRestrictedAgents || agentId == null || visibleAgentIds.has(agentId)

  const viewer = { userId }
  const chatRuns = [...activeTurns, ...terminalTurns]
    .filter((turn) => canShowRun(turn.agentId))
    .map((turn) => activeRunFromChatTurn(turn, viewer, agentNameById.get(turn.agentId) ?? null))
  const ticketRuns = [...activeTicketPage.items, ...completedTicketPage.items]
    .filter((ticket) => canShowRun(ticket.agentId))
    .map((ticket) => activeRunFromTicket(ticket))

  return [...chatRuns, ...ticketRuns].sort(
    (a, b) =>
      new Date(b.finishedAt ?? b.startedAt).getTime() -
      new Date(a.finishedAt ?? a.startedAt).getTime(),
  )
}
