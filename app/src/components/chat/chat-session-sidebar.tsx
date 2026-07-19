'use client'

type ChatSession = {
  id: string
  title: string
  preview: string | null
  lastMessageAt: string
  createdAt: string
  status?: 'active' | 'archived'
}

type ChatSessionStatusFilter = 'active' | 'archived'

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
  runningConversationIds = [],
  statusFilter = 'active',
  loading,
  loadingMore = false,
  hasMore = false,
  isBusy,
  onSelect,
  onNewChat,
  onLoadMore,
  onStatusFilterChange,
  className = '',
}: {
  sessions: ChatSession[]
  activeConversationId: string | null
  /** Beszélgetések, ahol háttérben fut agent-forduló. */
  runningConversationIds?: string[]
  statusFilter?: ChatSessionStatusFilter
  loading: boolean
  loadingMore?: boolean
  hasMore?: boolean
  isBusy: boolean
  onSelect: (conversationId: string) => void
  onNewChat: () => void
  onLoadMore?: () => void
  onStatusFilterChange?: (status: ChatSessionStatusFilter) => void
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
        <div className="mt-2 grid grid-cols-2 rounded-lg border border-line bg-night-2 p-0.5">
          {(['active', 'archived'] as const).map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => onStatusFilterChange?.(status)}
              disabled={loading}
              className={`rounded-md px-2 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                statusFilter === status
                  ? 'bg-card text-ink shadow-sm'
                  : 'text-ink-faint hover:text-ink-soft'
              }`}
              aria-pressed={statusFilter === status}
            >
              {status === 'active' ? 'Aktív' : 'Archivált'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading ? (
          <p className="px-2 py-3 text-xs text-ink-faint">Előzmények betöltése…</p>
        ) : sessions.length === 0 ? (
          <p className="px-2 py-3 text-xs leading-relaxed text-ink-faint">
            Még nincs korábbi beszélgetés ezzel az agenttel.
          </p>
        ) : (
          <div className="space-y-2">
            <ul className="space-y-1">
              {sessions.map((session) => {
                const active = session.id === activeConversationId
                const archived = session.status === 'archived'
                const running = runningConversationIds.includes(session.id)
                return (
                  <li key={session.id}>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => onSelect(session.id)}
                      className={`w-full rounded-xl px-3 py-2.5 text-left transition-colors disabled:opacity-40 ${
                        active
                          ? 'bg-coral/12 ring-1 ring-coral/25'
                          : archived
                            ? 'hover:bg-night-2'
                            : 'hover:bg-card/80'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span
                          className={`line-clamp-1 text-sm font-medium ${
                            active ? 'text-coral-deep' : archived ? 'text-ink-soft' : 'text-ink'
                          }`}
                        >
                          {session.title}
                        </span>
                        <span className="flex shrink-0 items-center gap-1 text-[10px] text-ink-faint">
                          {running && (
                            <span className="rounded-full border border-sky/40 bg-sky/10 px-1.5 py-0.5 font-semibold text-sky">
                              fut
                            </span>
                          )}
                          {archived && (
                            <span className="rounded-full border border-line px-1.5 py-0.5">
                              archív
                            </span>
                          )}
                          {formatSessionTime(session.lastMessageAt)}
                        </span>
                      </div>
                      {session.preview ? (
                        <p className="mt-0.5 line-clamp-2 text-xs text-ink-faint">{session.preview}</p>
                      ) : (
                        <p className="mt-1 inline-flex rounded-md bg-night-2 px-2 py-1 text-[11px] text-ink-faint">
                          Tartalom törölve vagy üres
                        </p>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
            {hasMore && onLoadMore && (
              <button
                type="button"
                onClick={onLoadMore}
                disabled={isBusy || loadingMore}
                className="w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/30 hover:text-coral-deep disabled:opacity-40"
              >
                {loadingMore ? 'Betöltés…' : 'Továbbiak'}
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}

export type { ChatSession, ChatSessionStatusFilter }
