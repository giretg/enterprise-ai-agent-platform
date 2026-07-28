import { personaFor } from '@/lib/agent-persona'

export type OrgAgentSummary = {
  agentId: string
  name: string
  nickname: string
  role: string
  trait: string
}

/**
 * A prompt-roster egy elemének MINIMÁLIS bemenete. Szándékosan nem a teljes `Agent`:
 * a rostert az agent-hozzáférési gráf szűrt listája adja (`listAccessibleAgents`), ami
 * a döntéshez szükséges szűk csomópont-adatokkal dolgozik.
 */
export type OrgRosterAgent = {
  id: string
  name: string
  role: string
  status: string
  personaNickname?: string | null
  personaGreeting?: string | null
  personaTrait?: string | null
}

export function summarizeAgent(agent: OrgRosterAgent): OrgAgentSummary {
  const persona = personaFor(agent.name, agent)
  return {
    agentId: agent.id,
    name: agent.name,
    nickname: persona.nickname,
    role: agent.role,
    trait: persona.trait,
  }
}

/**
 * A modell CSELEKVÉSI listája: azok a kollégák, akiket a hívó agent MEG IS SZÓLÍTHAT.
 *
 * FONTOS: a bemenetet az agent-hozzáférési gráf `listAccessibleAgents(..., 'address')`
 * hívása adja — szándékosan `address`, nem `view`. Ha a roster olyan kollégát kínálna,
 * akit a hívó agent nem szólíthat meg, a modell tiltott delegációval próbálkozna, és a
 * felhasználó egy értelmetlen „nem sikerült" választ kapna. A rosterben más tenant
 * agentjének neve, persona-traitje és ID-ja SOHA nem szerepelhet.
 */
export function formatOrgRoster(agents: OrgRosterAgent[]): string {
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
