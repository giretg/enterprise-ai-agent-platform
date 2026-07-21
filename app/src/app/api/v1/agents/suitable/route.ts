import { requireTenantRole } from '@/auth/tenant-context'
import { repositories } from '@/repositories/postgres'
import { apiError, apiOk } from '@/lib/api-response'
import { suitableAgentsSchema } from '@/lib/validators/actions'
import { parsePlaybookSpecV2 } from '@/lib/playbook-v2/spec'
import { isAgentSuitable } from '@/domain/playbook/suitability'
import { shouldExcludeHiddenAgents } from '@/lib/agent-operator-visibility'

export async function GET(request: Request) {
  try {
    const user = await requireTenantRole('operator')
    const url = new URL(request.url)
    const parsed = suitableAgentsSchema.safeParse({
      playbookVersionId: url.searchParams.get('playbookVersionId') ?? undefined,
      roleKey: url.searchParams.get('roleKey') ?? undefined,
    })
    if (!parsed.success) return apiError(parsed.error.message, 400)

    const processTenantId = user.activeTenantId
    // NOTE: requireTenantRole NO_TENANT-ot dob, mielőtt idáig érne — tisztán platform-
    // szintű (tenant nélküli) superadmin ezt az endpointot többé nem éri el.
    const registryTenantId: string | null = user.activeTenantId
    const version = await repositories.playbooksV2.findVersion(processTenantId, parsed.data.playbookVersionId)
    if (!version) return apiError('A Playbook-verzió nem található.', 404)

    const role = parsePlaybookSpecV2(version.spec).roles.find((r) => r.key === parsed.data.roleKey)
    if (!role || role.type !== 'agent_role') return apiError('A megadott agent-szerep nem található.', 404)

    const agents = await repositories.agents.findMany({
      tenantId: registryTenantId,
      excludeHiddenFromOperators: shouldExcludeHiddenAgents(user.activeTenantRole),
    })
    const suitable = []
    for (const agent of agents) {
      const capabilities = await repositories.toolBroker.findCapabilitiesForAgent(agent.id)
      const result = isAgentSuitable(
        { status: agent.status, tenantId: agent.tenantId, capabilities },
        { requiredCapabilities: role.requiredCapabilities },
        registryTenantId,
      )
      if (result.ok) suitable.push({ id: agent.id, name: agent.name, status: agent.status, role: agent.role })
    }
    return apiOk(suitable)
  } catch (e) {
    return apiError(e instanceof Error ? e.message : 'Nem sikerült betölteni az alkalmas agenteket', 500)
  }
}
