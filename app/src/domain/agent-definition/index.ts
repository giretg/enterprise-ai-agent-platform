/**
 * Immutable Agent Definition.
 *
 * TODO(phase-B): snapshot builder from Agent/Skill/connector grants.
 * Phase 0 only establishes the module boundary.
 */
export type AgentDefinition = {
  agentId: string
  version: number
  name: string
  roleInstruction: string
  skillIds: string[]
}

export function loadAgentDefinition(_agentId: string): Promise<AgentDefinition> {
  return Promise.reject(new Error('TODO(phase-B): Agent Definition is not implemented'))
}
