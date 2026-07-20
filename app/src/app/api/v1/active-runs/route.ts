import { requireTenantApiUser } from '@/lib/api-tenant-auth'
import { activeRunFromChatTurn, activeRunFromTicket } from '@/lib/active-runs-map'
import type { ActiveRunsResponse } from '@/lib/active-runs'
import { repositories } from '@/repositories/postgres'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Tenant-szintű aktív futások: chat AgentTurn + in_progress ticket.
 */
export async function GET() {
  const auth = await requireTenantApiUser('operator')
  if (!auth.ok) return auth.response
  const { user } = auth

  const tenantId = user.activeTenantId

  const [turns, tickets] = await Promise.all([
    repositories.agentTurns.listActiveByTenant(tenantId, { limit: 50 }),
    repositories.tickets.findMany({
      tenantId,
      state: 'in_progress',
      excludeTest: true,
    }),
  ])

  const viewer = { userId: user.user.id }
  const chatRuns = turns.map((turn) => ({
    ...activeRunFromChatTurn(turn, viewer),
    title: turn.cancelRequested ? 'Leállítás folyamatban…' : 'Futó chat-válasz',
  }))

  const ticketRuns = tickets.slice(0, 50).map((ticket) => activeRunFromTicket(ticket))

  const runs = [...chatRuns, ...ticketRuns].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  )

  const body: ActiveRunsResponse = { runs }
  return Response.json(body)
}
