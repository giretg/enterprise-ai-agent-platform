import type { Agent } from '@prisma/client'
import { AGENT_SCAFFOLD_AGENT_NAME, AGENT_SCAFFOLD_DESCRIPTION, AGENT_SCAFFOLD_ROLE_INSTRUCTION } from '@/lib/agent-scaffold'
import { AgentDefinitionService } from '@/domain/agent-definition'
import type {
  AgentDefinitionRepository,
  AgentRepository,
  SkillRepository,
} from '@/repositories/interfaces'

export type AgentScaffoldMaterializationDeps = {
  agents: Pick<
    AgentRepository,
    | 'findMany'
    | 'findById'
    | 'create'
    | 'updateProfile'
    | 'setCurrentDefinitionVersionId'
    | 'activate'
    | 'findCapabilitiesForAgent'
    | 'findConnectorsForAgent'
  >
  versions: Pick<
    AgentDefinitionRepository,
    'create' | 'findById' | 'findByAgentAndVersion' | 'findMaxVersion'
  >
  skills: Pick<SkillRepository, 'listEnabledForAgent'>
}

export async function findTenantAgentScaffold(
  deps: Pick<AgentScaffoldMaterializationDeps['agents'], 'findMany'>,
  tenantId: string,
): Promise<Agent | null> {
  const rows = await deps.findMany({ tenantId, unbounded: true })
  return rows.find((row) => row.name === AGENT_SCAFFOLD_AGENT_NAME) ?? null
}

export async function ensureTenantAgentScaffold(
  deps: AgentScaffoldMaterializationDeps,
  input: { tenantId: string; publishedById: string },
): Promise<Agent> {
  const existing = await findTenantAgentScaffold(deps.agents, input.tenantId)
  if (existing?.currentDefinitionVersionId && existing.status === 'active') {
    return existing
  }

  const created =
    existing ??
    (await deps.agents.create({
      tenantId: input.tenantId,
      name: AGENT_SCAFFOLD_AGENT_NAME,
      roleInstruction: AGENT_SCAFFOLD_ROLE_INSTRUCTION,
      description: AGENT_SCAFFOLD_DESCRIPTION,
      status: 'draft',
    }))
  const agent = created.description?.trim()
    ? created
    : await deps.agents.updateProfile({
        agentId: created.id,
        description: AGENT_SCAFFOLD_DESCRIPTION,
      })

  const definitionService = new AgentDefinitionService({
    agents: deps.agents,
    versions: deps.versions,
    skills: deps.skills,
  })

  if (!agent.currentDefinitionVersionId) {
    await definitionService.publishAgentDefinition({
      agentId: agent.id,
      tenantId: input.tenantId,
      publishedById: input.publishedById,
    })
  }
  if (agent.status !== 'active') {
    return definitionService.activateAgent({
      agentId: agent.id,
      tenantId: input.tenantId,
      actorId: input.publishedById,
    })
  }
  return agent
}
