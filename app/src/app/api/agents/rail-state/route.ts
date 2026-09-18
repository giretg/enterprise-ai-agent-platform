import { listAgents } from '@/app/actions/platform'
import { requireTenantApiUser } from '@/lib/api-tenant-auth'
import type { AgentRailStateResponse } from '@/lib/agent-rail-types'
import { personaFor } from '@/lib/agent-persona'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const auth = await requireTenantApiUser('viewer')
  if (!auth.ok) return auth.response
  const agentsRes = await listAgents({ limit: 100 })
  if (!agentsRes.success) {
    return Response.json({ error: agentsRes.error }, { status: 500 })
  }

  const body: AgentRailStateResponse = {
    agents: agentsRes.data.map((agent) => {
      const persona = personaFor(agent.name, agent)
      return {
        id: agent.id,
        name: agent.name,
        personaNickname: persona.nickname,
        personaGreeting: persona.greeting,
        avatarUrl: agent.avatarUrl,
        status: agent.status,
        taskOnly: agent.taskOnly,
        roleLabel: agent.name,
        roleDescription: agent.roleInstruction ?? '',
        liveStatus: 'idle',
        activityText: '',
        elapsed: null,
        progress: null,
        badges: [],
        attentionHref: null,
        sortRank: 2,
      }
    }),
    asOf: new Date().toISOString(),
  }
  return Response.json(body)
}
