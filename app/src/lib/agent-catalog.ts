import type { AgentRepository } from '@/repositories/interfaces'

export type AgentCatalogEntry = {
  agentId: string
  name: string
  status: string
  roleInstruction: string
  currentDefinitionId: string | null
  capabilities: Array<{ toolName: string; allowed: boolean }>
  connectors: Array<{ type: string; name: string; accessMode: string }>
}

export async function buildAgentCatalogEntry(
  agentId: string,
  agents: AgentRepository,
): Promise<AgentCatalogEntry> {
  const agent = await agents.findById(agentId)
  if (!agent) throw new Error('Agent not found')
  const [capabilities, connectorRows] = await Promise.all([
    agents.findCapabilitiesForAgent(agentId),
    agents.findConnectorsForAgent(agentId),
  ])
  return {
    agentId: agent.id,
    name: agent.name,
    status: agent.status,
    roleInstruction: agent.roleInstruction,
    currentDefinitionId: agent.currentDefinitionVersionId,
    capabilities,
    connectors: connectorRows.map((row) => ({
      type: row.connector.type,
      name: row.connector.name,
      accessMode: row.accessMode,
    })),
  }
}
