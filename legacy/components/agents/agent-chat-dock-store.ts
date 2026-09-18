export type AgentChatDockEntry = {
  id: string
  agentName: string
  agentStatus?: string
  avatarUrl?: string | null
  personaNickname?: string | null
  displayName: string
  isTyping: boolean
  onRestore: () => void
  onClose: () => void
}

let entries: AgentChatDockEntry[] = []
const EMPTY_SERVER_SNAPSHOT: AgentChatDockEntry[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function upsertAgentChatDockEntry(entry: AgentChatDockEntry) {
  const index = entries.findIndex((item) => item.id === entry.id)
  if (index >= 0) {
    entries = [...entries.slice(0, index), entry, ...entries.slice(index + 1)]
  } else {
    entries = [...entries, entry]
  }
  emit()
}

export function removeAgentChatDockEntry(id: string) {
  const next = entries.filter((item) => item.id !== id)
  if (next.length === entries.length) return
  entries = next
  emit()
}

/** Teszt / reset: üríti a tálcát. */
export function clearAgentChatDockEntries() {
  if (entries.length === 0) return
  entries = []
  emit()
}

export function subscribeAgentChatDock(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getAgentChatDockEntries() {
  return entries
}

export function getAgentChatDockServerSnapshot(): AgentChatDockEntry[] {
  return EMPTY_SERVER_SNAPSHOT
}
