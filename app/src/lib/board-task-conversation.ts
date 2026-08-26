/**
 * Munkaterület Feladatok-fül: a kiosztás akkor kap saját beszélgetést,
 * ha beszélgetős agent a felelős. Globális tábla, ember és korlátozott
 * (task-only) agent nem — ott a ticket-szál a beszélgetés.
 */
export function shouldLinkBoardTaskConversation(input: {
  linkConversation?: boolean
  assigneeType: 'human' | 'agent'
  taskOnly: boolean
}): boolean {
  return input.linkConversation === true && input.assigneeType === 'agent' && !input.taskOnly
}
