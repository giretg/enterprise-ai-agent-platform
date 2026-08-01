import { requireTenantApiUser } from '@/lib/api-tenant-auth'
import { activeRunFromChatTurn, activeRunFromTicket } from '@/lib/active-runs-map'
import type { ActiveRunsResponse } from '@/lib/active-runs'
import { shouldExcludeHiddenAgents } from '@/lib/agent-operator-visibility'
import { agentDisplayName } from '@/lib/agent-persona'
import { repositories } from '@/repositories/postgres'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ACTIVE_TICKET_STATES = ['in_progress', 'awaiting_human', 'needs_info'] as const
const COMPLETED_TICKET_STATES = ['done', 'rejected'] as const

/**
 * Tenant-szintű futások: aktív + friss lefutott chat-fordulók és ticketek.
 */
export async function GET() {
  const auth = await requireTenantApiUser('operator')
  if (!auth.ok) return auth.response
  const { user } = auth

  const tenantId = user.activeTenantId

  const [activeTurns, terminalTurns, activeTicketPage, completedTicketPage] = await Promise.all([
    repositories.agentTurns.listActiveByTenant(tenantId, { limit: 50 }),
    repositories.agentTurns.listRecentTerminalByTenant(tenantId, { limit: 30 }),
    repositories.tickets.listPage({
      tenantId,
      state: [...ACTIVE_TICKET_STATES],
      excludeTest: true,
      limit: 50,
    }),
    repositories.tickets.listPage({
      tenantId,
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

  const agents =
    agentIds.length > 0
      ? await repositories.agents.findMany({
          tenantId,
          ids: agentIds,
          excludeHiddenFromOperators: shouldExcludeHiddenAgents(user.activeTenantRole),
          unbounded: true,
        })
      : []
  const agentNameById = new Map(
    agents.map((agent) => [agent.id, agentDisplayName(agent.name, agent)]),
  )
  const hidesRestrictedAgents = shouldExcludeHiddenAgents(user.activeTenantRole)
  const visibleAgentIds = new Set(agents.map((agent) => agent.id))
  const canShowRun = (agentId: string | null) =>
    !hidesRestrictedAgents || agentId == null || visibleAgentIds.has(agentId)

  const viewer = { userId: user.user.id }
  const chatRuns = [...activeTurns, ...terminalTurns]
    .filter((turn) => canShowRun(turn.agentId))
    .map((turn) => activeRunFromChatTurn(turn, viewer, agentNameById.get(turn.agentId) ?? null))
  const ticketRuns = [...activeTicketPage.items, ...completedTicketPage.items]
    .filter((ticket) => canShowRun(ticket.agentId))
    .map((ticket) => activeRunFromTicket(ticket))

  const runs = [...chatRuns, ...ticketRuns].sort(
    (a, b) =>
      new Date(b.finishedAt ?? b.startedAt).getTime() -
      new Date(a.finishedAt ?? a.startedAt).getTime(),
  )

  const body: ActiveRunsResponse = { runs }
  return Response.json(body)
}
