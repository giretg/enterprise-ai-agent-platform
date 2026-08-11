import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'

export type AgentModelConfigInput = {
  provider: string
  model: string
  modelType?: 'luna' | 'terra' | 'sol'
  temperature?: number
  maxTokens?: number
  fallbackModels?: Array<{ provider: string; model: string }>
}

/**
 * A tenant- és rendszeragentek közös, auditált modellkonfiguráció-frissítése.
 * Az egyes actionök felelőssége marad a saját auth- és agent-scope kapujuk.
 */
export async function applyAgentModelConfigUpdate(input: {
  agentId: string
  modelConfig: AgentModelConfigInput
  actorId: string
  scope: 'tenant_agent' | 'system_agent'
}) {
  await services.platformSettings.assertModelAllowed(input.modelConfig.provider, input.modelConfig.model)
  for (const fallback of input.modelConfig.fallbackModels ?? []) {
    await services.platformSettings.assertModelAllowed(fallback.provider, fallback.model)
  }

  const result = await repositories.agents.updateModelConfig({
    agentId: input.agentId,
    modelConfig: input.modelConfig,
  })
  await repositories.audit.append({
    actorType: 'human',
    actorId: input.actorId,
    agentVersion: result.agentVersion,
    action: 'agent.version',
    targetType: 'agent',
    targetId: input.agentId,
    modelUsed: input.modelConfig.model,
    inputRef: null,
    outputRef: `v${result.agentVersion}`,
    policyDecision: 'allowed',
    metadata: {
      ...(input.scope === 'system_agent' ? { scope: input.scope } : {}),
      changed: ['modelConfig'],
      modelConfig: input.modelConfig,
    },
  })
  return result
}
