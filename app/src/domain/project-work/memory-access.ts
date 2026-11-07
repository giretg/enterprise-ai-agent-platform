import { canReadPublishedAgent } from '@/domain/agent-definition'

export type MemoryAccessDeps<TAgent> = {
  findAgent(agentId: string, tenantId: string): Promise<TAgent | null>
  findAgentGrant(input: { tenantId: string; userId: string; agentId: string }): Promise<{ accessLevel: string } | null>
}

/**
 * Egy agent memóriáját a webes felületen csak az olvashatja, aki az agentet is látja.
 * Jogosultság nélkül ugyanazt a választ adja, mint a nem létező agentre, így a
 * másik agent létezése sem derül ki.
 */
export async function findMemoryReadableAgent<TAgent>(
  deps: MemoryAccessDeps<TAgent>,
  input: { tenantId: string; userId: string; role: string; agentId: string },
): Promise<TAgent | null> {
  const agent = await deps.findAgent(input.agentId, input.tenantId)
  if (!agent) return null
  const grant = await deps.findAgentGrant({
    tenantId: input.tenantId,
    userId: input.userId,
    agentId: input.agentId,
  })
  return canReadPublishedAgent({ role: input.role, grant }) ? agent : null
}
