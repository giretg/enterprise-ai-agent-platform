import { getAuthContext } from '@/auth/context'
import { listAgents } from '@/app/actions/platform'
import { prisma } from '@/lib/db'
import { agentWorkspacePath, defaultAgentWorkspaceTab } from '@/lib/agent-workspace-routes'

/**
 * A gyökér (`/control-plane`) mindig továbbredirectel ide vagy egy agenthez.
 * Önmagára esni villogó redirect-loop.
 */
export const DEFAULT_AGENT_WORKSPACE_FALLBACK = '/control-plane/board'

/**
 * Alapértelmezett munkaterület: az agent, akivel utoljára volt beszélgetés.
 * Ha nincs előzmény, az első elérhető munkatárs; végül a board.
 */
export async function resolveDefaultAgentWorkspacePath(): Promise<string> {
  const ctx = await getAuthContext()
  if (!ctx?.user?.id || !ctx.activeTenantId) return DEFAULT_AGENT_WORKSPACE_FALLBACK

  const latest = await prisma.conversation.findFirst({
    where: {
      tenantId: ctx.activeTenantId,
      createdById: ctx.user.id,
      agent: { status: { not: 'retired' } },
    },
    orderBy: { lastMessageAt: 'desc' },
    select: {
      agentId: true,
      agent: { select: { taskOnly: true } },
    },
  })

  if (latest?.agentId) {
    return agentWorkspacePath(latest.agentId, defaultAgentWorkspaceTab(latest.agent.taskOnly))
  }

  const agentsRes = await listAgents({ limit: 50 })
  if (agentsRes.success && agentsRes.data.length > 0) {
    const agent =
      agentsRes.data.find((row) => row.status !== 'retired') ?? agentsRes.data[0]
    return agentWorkspacePath(agent.id, defaultAgentWorkspaceTab(agent.taskOnly))
  }

  return DEFAULT_AGENT_WORKSPACE_FALLBACK
}
