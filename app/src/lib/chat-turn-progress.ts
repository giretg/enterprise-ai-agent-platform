/**
 * Élő chat-forduló progresszének beolvasztása a kliens üzenetlistájába.
 *
 * A POST SSE tool-körök alatt gyakran csak `activity` eseményeket küld (a
 * végső szöveg tokenjei a loop végén jönnek). Ha a proxy / runtime buffereli
 * a streamet, a UI üres buborék + gépelés-indikátoron ragad, miközben a DB-ben
 * már ott vannak az aktivitások. A periodikus active-turn poll ezt a rést
 * zárja — a szerver `activities` / `partialText` az igazság forrása, az
 * upsert id-alapú, így az élő SSE-vel nem verseng rombolóan.
 */

export type ChatTurnActivity = {
  id: string
  kind: 'reasoning' | 'tool'
  title: string
  detail?: string
  status: 'running' | 'done' | 'error' | 'skipped'
  archivePath?: string
}

export type ChatTurnProgressMessage = {
  id: string
  role: string
  text: string
  activities?: ChatTurnActivity[]
}

export function upsertChatTurnActivity(
  activities: ChatTurnActivity[] | undefined,
  next: ChatTurnActivity,
): ChatTurnActivity[] {
  const current = activities ?? []
  const index = current.findIndex((activity) => activity.id === next.id)
  if (index < 0) return [...current, next]
  return current.map((activity, i) => (i === index ? { ...activity, ...next } : activity))
}

export function mergeChatTurnActivities(
  local: ChatTurnActivity[] | undefined,
  remote: ChatTurnActivity[],
): ChatTurnActivity[] {
  let merged = local ?? []
  for (const activity of remote) {
    merged = upsertChatTurnActivity(merged, activity)
  }
  return merged
}

/**
 * A futó forduló DB-pillanatképét beírja az agent-buborékba.
 * Ha a turn-id szerinti buborék még nincs (rename race), az utolsó üres
 * agent-buborékot veszi át. Ha az sincs sem, változatlanul visszaadja a
 * listát — a panel küldéskor mindig létrehoz optimista buborékot; hiányos
 * üzenetet nem gyártunk (a következő poll / SSE pótolja).
 */
export function mergeTurnProgressIntoMessages<T extends ChatTurnProgressMessage>(
  messages: T[],
  input: {
    agentMessageId: string
    activities: ChatTurnActivity[]
    partialText?: string
  },
): T[] {
  const { agentMessageId, activities, partialText = '' } = input
  if (activities.length === 0 && !partialText) return messages

  const byId = messages.findIndex((m) => m.id === agentMessageId)
  let target = byId
  if (target < 0) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]
      if (m.role !== 'agent') continue
      if (m.text.trim()) continue
      target = i
      break
    }
  }

  if (target < 0) {
    // A panel mindig létrehoz optimista agent-buborékot küldéskor; ha mégis
    // hiányzik, ne gyártunk hiányos üzenetet — a következő poll / SSE pótolja.
    return messages
  }

  return messages.map((message, index) => {
    if (index !== target) return message
    const nextText =
      partialText.length > message.text.length ? partialText : message.text
    return {
      ...message,
      id: agentMessageId,
      text: nextText,
      activities: mergeChatTurnActivities(message.activities, activities),
    }
  })
}

/** Van-e megjeleníthető aktivitás — a typing-indikátor ellenpárja. */
export function chatMessageShowsAgentActivity(
  message: ChatTurnProgressMessage | undefined,
): boolean {
  return Boolean(message?.activities && message.activities.length > 0)
}
