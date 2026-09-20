import type { AgentDefinition } from '@/domain/agent-definition'

export type DefinitionPinDeps = {
  findCurrentDefinitionId: (input: {
    tenantId: string
    agentId: string
  }) => Promise<string | null>
}

export type DefinitionPinCheck =
  | { current: true }
  | { current: false; currentDefinitionId: string | null }

export async function checkDefinitionPin(
  deps: DefinitionPinDeps,
  input: { tenantId: string; definition: AgentDefinition },
): Promise<DefinitionPinCheck> {
  const currentDefinitionId = await deps.findCurrentDefinitionId({
    tenantId: input.tenantId,
    agentId: input.definition.agentId,
  })
  if (currentDefinitionId && currentDefinitionId === input.definition.definitionId) {
    return { current: true }
  }
  return { current: false, currentDefinitionId }
}
