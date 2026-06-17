'use client'

type ChatSession = {
  id: string
  title: string
  preview: string | null
  lastMessageAt: string
  createdAt: string
}

function formatSessionTime(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  if (sameDay) {
    return date.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
  }

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()

  if (isYesterday) return 'Tegnap'

  return date.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })
}

export function AgentChatSessionSidebar({
  sessions,
  activeConversationId,
  loading,
  isBusy,
  onSelect,
  onNewChat,
  className = '',
}: {
  sessions: ChatSession[]
  activeConversationId: string | null
  loading: boolean
  isBusy: boolean
  onSelect: (conversationId: string) => void
  onNewChat: () => void
  className?: string
}) {
  const isNewActive = activeConversationId === null

  return (
    <aside
      className={`flex h-full w-full flex-col bg-night/30 ${className}`}
      aria-label="Korábbi beszélgetések"
    >
      <div className="border-b border-line px-3 py-3">
        <button
          type="button"
          onClick={onNewChat}
          disabled={isBusy}
          className={`w-full rounded-xl border px-3 py-2.5 text-left text-sm font-semibold transition-colors disabled:opacity-40 ${
            isNewActive
              ? 'border-coral/40 bg-coral/10 text-coral-deep'
              : 'border-line bg-card text-ink-soft hover:border-coral/30 hover:text-coral-deep'
          }`}
        >
          + Új beszélgetés
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading ? (
          <p className="px-2 py-3 text-xs text-ink-faint">Előzmények betöltése…</p>
        ) : sessions.length === 0 ? (
          <p className="px-2 py-3 text-xs leading-relaxed text-ink-faint">
            Még nincs korábbi beszélgetés ezzel az agenttel.
          </p>
        ) : (
          <ul className="space-y-1">
            {sessions.map((session) => {
              const active = session.id === activeConversationId
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onSelect(session.id)}
                    className={`w-full rounded-xl px-3 py-2.5 text-left transition-colors disabled:opacity-40 ${
                      active
                        ? 'bg-coral/12 ring-1 ring-coral/25'
                        : 'hover:bg-card/80'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span
                        className={`line-clamp-1 text-sm font-medium ${
                          active ? 'text-coral-deep' : 'text-ink'
                        }`}
                      >
                        {session.title}
                      </span>
                      <span className="shrink-0 text-[10px] text-ink-faint">
                        {formatSessionTime(session.lastMessageAt)}
                      </span>
                    </div>
                    {session.preview && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-ink-faint">{session.preview}</p>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}

export type { ChatSession }
