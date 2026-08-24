/**
 * A „Beszélgetés” gomb a legutóbbi aktív szálat nyitja, nem üres újat.
 * Új beszélgetés: explicit „Új beszélgetés”, vagy Elemezd/prefill (új téma).
 */

export function conversationIdToResume(input: {
  open: boolean
  initialConversationId?: string | null
  currentConversationId: string | null
  userStartedNew: boolean
  sessionsLoading: boolean
  sessionsFilter: 'active' | 'archived' | 'all'
  sessions: Array<{ id: string }>
  /** RA-08 Elemezd: előre kitöltött kérés — mindig új szál, nem az előző téma. */
  initialPrefill?: string | null
}): string | null {
  if (!input.open) return null
  if (input.initialConversationId) return null
  if (input.currentConversationId) return null
  if (input.userStartedNew) return null
  if (input.initialPrefill?.trim()) return null
  if (input.sessionsLoading) return null
  if (input.sessionsFilter !== 'active') return null
  return input.sessions[0]?.id ?? null
}
