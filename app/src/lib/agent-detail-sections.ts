/** Agent adatlap bal sáv — URL: `?section=` (diagnosztika fix linkekhez is). */
export const AGENT_DETAIL_SECTION_IDS = [
  'elesites',
  'profil',
  'munkakor',
  'kapcsolatok',
  'tudasbazis',
  'eszkozok',
  'skillek',
  'hozzaferes',
] as const

export type AgentDetailSectionId = (typeof AGENT_DETAIL_SECTION_IDS)[number]

export function isAgentDetailSectionId(value: string | undefined): value is AgentDetailSectionId {
  return AGENT_DETAIL_SECTION_IDS.includes(value as AgentDetailSectionId)
}

export const AGENT_DETAIL_SECTION_LABELS: Record<AgentDetailSectionId, string> = {
  elesites: 'Élesítés',
  profil: 'Név és bemutatkozás',
  munkakor: 'Munkakör',
  kapcsolatok: 'Konnektorok',
  tudasbazis: 'Tudásbázis',
  eszkozok: 'Eszközök',
  skillek: 'Skillek',
  hozzaferes: 'Hozzáférés',
}
