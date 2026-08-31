/**
 * A „Beszélgetés” gomb a legutóbbi aktív szálat nyitja, nem üres újat.
 * Új beszélgetés: explicit „Új beszélgetés”, vagy Elemezd/prefill (új téma).
 *
 * A session-lista (előzmények sáv) NEM kell a resume-hoz: a legutóbbi aktív
 * szál azonosítója külön, olcsó lekérdezés. `undefined` = még nem ismert.
 */

export function conversationIdToResume(input: {
  open: boolean
  initialConversationId?: string | null
  currentConversationId: string | null
  userStartedNew: boolean
  /** `undefined`: a legutóbbi szál id-ja még tölt. `null`: nincs aktív előzmény. */
  latestConversationId: string | null | undefined
  /** RA-08 Elemezd: előre kitöltött kérés — mindig új szál, nem az előző téma. */
  initialPrefill?: string | null
}): string | null {
  if (!input.open) return null
  if (input.initialConversationId) return null
  if (input.currentConversationId) return null
  if (input.userStartedNew) return null
  if (input.initialPrefill?.trim()) return null
  if (input.latestConversationId === undefined) return null
  return input.latestConversationId
}

/**
 * Strict Mode / effect-újrafutás / gyors kattintás: ugyanazt a szálat ne
 * töltsük második párhuzamos kéréssel. A már nyitott szálat sem.
 */
export function shouldSkipDuplicateSessionSelect(input: {
  requestedId: string
  currentConversationId: string | null
  inFlightId: string | null
}): boolean {
  if (input.inFlightId === input.requestedId) return true
  if (input.requestedId === input.currentConversationId) return true
  return false
}

export type ConversationHistoryLoadState = 'idle' | 'loading' | 'ready'

/**
 * A fő chatfelület „Előző beszélgetés betöltése” spinnere.
 * Egy folyamatos várakozás: legutóbbi szál feloldása + üzenetek — ne villogjon üres
 * üdvözlőre a kettő között, és üres szál ready állapotában ne pörögjön örökké.
 */
export function previousConversationLoaderVisible(input: {
  messageCount: number
  ticketHistoryCount: number
  isAgentTyping: boolean
  userStartedNew: boolean
  statusMessage: string | null
  conversationId: string | null
  historyLoadState: ConversationHistoryLoadState
  latestConversationId: string | null | undefined
  initialConversationId?: string | null
  initialPrefill?: string | null
}): boolean {
  if (input.messageCount > 0 || input.ticketHistoryCount > 0 || input.isAgentTyping) return false
  if (input.userStartedNew || input.statusMessage) return false
  if (input.historyLoadState === 'ready') return false
  if (input.historyLoadState === 'loading') return true
  if (input.conversationId) return true
  if (input.initialConversationId) return true
  if (input.latestConversationId === undefined) return true
  if (input.latestConversationId) return true
  return false
}
