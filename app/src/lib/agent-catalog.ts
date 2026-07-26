import type { AgentRepository, ToolBrokerRepository } from '@/repositories/interfaces'
import { personaFor } from '@/lib/agent-persona'

export type AgentCatalogEntry = {
  agentId: string
  name: string
  nickname: string
  status: string
  role: string
  roleInstruction: string
  behaviorProfile: string
  personaTrait: string
  currentVersion: number
  memoryVersion: number | null
  model: { provider: string; model: string }
  recipe: { name: string; ticketType: string; version: number } | null
  resources: Array<{ name: string; type: string; accessMode: string }>
  capabilities: Array<{ toolName: string; allowed: boolean }>
  connectors: Array<{ type: string; name: string; accessMode: string }>
}

export async function buildAgentCatalogEntry(
  agentId: string,
  agents: AgentRepository,
  toolBroker: ToolBrokerRepository,
): Promise<AgentCatalogEntry> {
  const detail = await agents.findByIdForDisplay(agentId)
  if (!detail) throw new Error('Agent not found')

  const persona = personaFor(detail.agent.name, detail.agent)
  const [capabilities, connectorRows] = await Promise.all([
    toolBroker.findCapabilitiesForAgent(agentId),
    toolBroker.findConnectorsForAgent(agentId),
  ])

  const modelConfig = detail.agent.modelConfig as { provider?: string; model?: string }

  return {
    agentId: detail.agent.id,
    name: detail.agent.name,
    nickname: persona.nickname,
    status: detail.agent.status,
    role: detail.agent.role,
    roleInstruction: detail.agent.roleInstruction,
    behaviorProfile: detail.agent.behaviorProfile,
    personaTrait: persona.trait,
    currentVersion: detail.agent.currentVersion,
    memoryVersion: detail.memoryVersion,
    model: {
      provider: modelConfig.provider ?? 'unknown',
      model: modelConfig.model ?? 'unknown',
    },
    recipe: detail.recipe
      ? {
          name: detail.recipe.name,
          ticketType: detail.recipe.ticketType,
          version: detail.recipe.version,
        }
      : null,
    resources: detail.resources.map((r) => ({
      name: r.name,
      type: r.type,
      accessMode: r.accessMode,
    })),
    capabilities: capabilities.map((c) => ({ toolName: c.toolName, allowed: c.allowed })),
    connectors: connectorRows.map((row) => ({
      type: row.connector.type,
      name: row.connector.name,
      accessMode: row.accessMode,
    })),
  }
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
}

export function scoreAgentForCatalogQuery(
  agent: {
    name: string
    roleInstruction: string
    status: string
    personaNickname?: string | null
    personaGreeting?: string | null
    personaTrait?: string | null
  },
  query: string,
): number {
  const persona = personaFor(agent.name, agent)
  const q = normalizeText(query.trim())
  if (!q) return 1

  const nicknameNorm = normalizeText(persona.nickname)
  const nameNorm = normalizeText(agent.name)
  const searchable = normalizeText(
    `${persona.nickname} ${agent.name} ${agent.roleInstruction} ${persona.trait}`,
  )
  const terms = q.split(/\s+/).filter((t) => t.length >= 2)

  let score = 0
  if (nicknameNorm.includes(q) || q.includes(nicknameNorm)) score += 12
  if (nameNorm.includes(q)) score += 8
  for (const term of terms) {
    if (nicknameNorm === term) score += 10
    if (nameNorm.includes(term)) score += 5
    if (searchable.includes(term)) score += 2
  }
  return score
}
