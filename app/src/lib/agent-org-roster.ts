import type { Agent } from '@prisma/client'
import { personaFor } from '@/lib/agent-persona'

export type OrgAgentSummary = {
  agentId: string
  name: string
  nickname: string
  role: string
  trait: string
}

export function summarizeAgent(agent: Agent): OrgAgentSummary {
  const persona = personaFor(agent.name)
  return {
    agentId: agent.id,
    name: agent.name,
    nickname: persona.nickname,
    role: agent.role,
    trait: persona.trait,
  }
}

export function formatOrgRoster(agents: Agent[]): string {
  const active = agents.filter((a) => a.status === 'active')
  if (active.length === 0) return 'Szervezeti agentek: (nincs aktív agent)'

  const lines = active.map((agent) => {
    const s = summarizeAgent(agent)
    return `- ${s.nickname} — hivatalos név: „${s.name}”, agentId: ${s.agentId}, szerep: ${s.role}. ${s.trait}`
  })

  return [
    'Szervezeti AI agentek (nicknév → hivatalos név → agentId):',
  ...lines,
  'Ha a felhasználó nicknévre hivatkozik (pl. Bori), az agent_catalog vagy agent_resolve eszközzel azonosítsd a cél agentet.',
  ].join('\n')
}
