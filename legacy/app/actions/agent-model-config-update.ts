import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import { mergeRunAnalystLoopGuardModelConfig } from '@/domain/agents/run-analyst-role'
import { RUN_ANALYST_SYSTEM_ROLE } from '@/lib/platform-agent-registry'

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

  const agent = await repositories.agents.findById(input.agentId)
  const modelConfig =
    agent?.systemRole === RUN_ANALYST_SYSTEM_ROLE
      ? mergeRunAnalystLoopGuardModelConfig(input.modelConfig)
      : input.modelConfig

  const result = await repositories.agents.updateModelConfig({
    agentId: input.agentId,
    modelConfig,
  })
  await repositories.audit.append({
    actorType: 'human',
    actorId: input.actorId,
    agentVersion: result.agentVersion,
    action: 'agent.version',
    targetType: 'agent',
    targetId: input.agentId,
    modelUsed: modelConfig.model,
    inputRef: null,
    outputRef: `v${result.agentVersion}`,
    policyDecision: 'allowed',
    metadata: {
      ...(input.scope === 'system_agent' ? { scope: input.scope } : {}),
      changed: ['modelConfig'],
      modelConfig,
    },
  })
  return result
}
