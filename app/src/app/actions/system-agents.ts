'use server'

import { revalidatePath } from 'next/cache'
import { requirePlatformRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { applyAgentModelConfigUpdate } from '@/app/actions/agent-model-config-update'
import type { AgentModelConfigInput } from '@/app/actions/agent-model-config-update'
import { fail, ok } from '@/lib/result'
import { isPanelWizardAgentName } from '@/lib/platform-agent-registry'
import { updateAgentModelConfigSchema } from '@/lib/validators/actions'
import { repositories } from '@/repositories/postgres'

/**
 * Platform-szintű, dedikált panel-varázslók modellkonfigurációja.
 *
 * Ezeket kizárólag platform-szerep kezelheti: egy tenant adminja nem állíthatja
 * át a többi tenant automatizmusait. A módosítás mégis ugyanúgy új, auditálható
 * agent-verziót hoz létre, mint a tenant-agenteknél.
 */
export async function getSystemAgentsPageData() {
  try {
    await requirePlatformRole('platform_auditor')
    const [agents, modelPolicy] = await Promise.all([
      repositories.agents.findMany(),
      services.platformSettings.getModelPolicy(),
    ])
    return ok({ agents: agents.filter((agent) => isPanelWizardAgentName(agent.name)), modelPolicy })
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Failed to list system agents')
  }
}

export async function updateSystemAgentModelConfig(input: {
  agentId: string
  modelConfig: AgentModelConfigInput
}) {
  try {
    const ctx = await requirePlatformRole('superadmin')
    const parsed = updateAgentModelConfigSchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId)
    if (!agent || !isPanelWizardAgentName(agent.name)) return fail('System agent not found')

    const result = await applyAgentModelConfigUpdate({
      ...parsed,
      actorId: ctx.user.id,
      scope: 'system_agent',
    })
    revalidatePath('/control-plane/platform/settings')
    return ok(result)
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Failed to update system agent model config')
  }
}
