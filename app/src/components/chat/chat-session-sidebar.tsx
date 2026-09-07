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

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function formatSessionTime(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)

  if (dayDiff <= 0) {
    return date.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
  }
  if (dayDiff === 1) return 'Tegnap'
  return date.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })
}

/**
 * A lista fejben átláthatatlan, ha 20 egyforma sor követi egymást — ezért
 * időbeli sávokra bontjuk: a user rendszerint arra emlékszik, *mikor*
 * beszélgetett, nem a szál címére.
 */
function sessionGroupLabel(iso: string): string {
  const dayDiff = Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / 86_400_000)
  if (dayDiff <= 0) return 'Ma'
  if (dayDiff === 1) return 'Tegnap'
  if (dayDiff <= 7) return 'Az elmúlt 7 napban'
  if (dayDiff <= 30) return 'Az elmúlt 30 napban'
  return 'Régebbi'
}

function groupSessions(sessions: ChatSession[]): Array<{ label: string; items: ChatSession[] }> {
  const groups: Array<{ label: string; items: ChatSession[] }> = []
  for (const session of sessions) {
    const label = sessionGroupLabel(session.lastMessageAt)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(session)
    else groups.push({ label, items: [session] })
  }
  return groups
}

/** A preview gyakran szó szerint a cím — kétszer ugyanazt kiírni csak zaj. */
function normalizeForCompare(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function previewToShow(session: ChatSession): string | null {
  if (!session.preview) return null
  const preview = normalizeForCompare(session.preview)
  const title = normalizeForCompare(session.title.replace(/…$/, ''))
  if (preview === title || preview.startsWith(title)) return null
  return session.preview
}

export function AgentChatSessionSidebar({
  sessions,
  activeConversationId,
  runningConversationIds = [],
  statusFilter = 'active',
  loading,
  loadingMore = false,
  hasMore = false,
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
  onSelect: (conversationId: string) => void
  onNewChat: () => void
  onLoadMore?: () => void
  onStatusFilterChange?: (status: ChatSessionStatusFilter) => void
  className?: string
}) {
  const isNewActive = activeConversationId === null
  const groups = groupSessions(sessions)

  return (
    <aside
      className={`flex h-full w-full flex-col bg-night ${className}`}
      aria-label="Korábbi beszélgetések"
    >
      <div className="shrink-0 space-y-2 px-3 py-3">
        <button
          type="button"
          onClick={onNewChat}
          className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm font-semibold transition-colors ${
            isNewActive
              ? 'border-coral/40 bg-coral/10 text-coral-deep'
              : 'border-line bg-card text-ink-soft hover:border-coral/30 hover:bg-coral/5 hover:text-coral-deep'
          }`}
        >
          <span
            aria-hidden
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-coral/15 text-[13px] leading-none text-coral-deep"
          >
            +
          </span>
          Új beszélgetés
        </button>

        <div
          className="grid grid-cols-2 rounded-lg border border-line bg-night-2 p-0.5"
          role="tablist"
          aria-label="Beszélgetések szűrése"
        >
          {(['active', 'archived'] as const).map((status) => (
            <button
              key={status}
              type="button"
              role="tab"
              onClick={() => onStatusFilterChange?.(status)}
              disabled={loading}
              className={`rounded-md px-2 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50 ${
                statusFilter === status
                  ? 'bg-card text-ink shadow-sm'
                  : 'text-ink-faint hover:text-ink-soft'
              }`}
              aria-selected={statusFilter === status}
            >
              {status === 'active' ? 'Aktív' : 'Archivált'}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading ? (
          <div className="space-y-2 px-1 py-2" aria-live="polite">
            <p className="sr-only">Előzmények betöltése…</p>
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-xl bg-night-2/70 px-3 py-3">
                <div className="h-3 w-2/3 rounded-full bg-line/70" />
                <div className="mt-2 h-2.5 w-full rounded-full bg-line/50" />
              </div>
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <div className="mx-1 mt-2 rounded-xl border border-dashed border-line px-3 py-5 text-center">
            <p className="text-xs font-semibold text-ink-soft">
              {statusFilter === 'archived' ? 'Nincs archivált szál' : 'Még nincs beszélgetés'}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
              {statusFilter === 'archived'
                ? 'A lezárt szálak ide kerülnek, ha archiválod őket.'
                : 'Írj egy üzenetet alul — az új szál automatikusan ide kerül.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {groups.map((group) => (
              <div key={group.label}>
                <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                  {group.label}
                </p>
                <ul className="space-y-0.5">
                  {group.items.map((session) => {
                    const active = session.id === activeConversationId
                    const archived = session.status === 'archived'
                    const running = runningConversationIds.includes(session.id)
                    const preview = previewToShow(session)
                    return (
                      <li key={session.id}>
                        <button
                          type="button"
                          onClick={() => onSelect(session.id)}
                          aria-current={active ? 'true' : undefined}
                          className={`group relative w-full rounded-xl py-2.5 pl-3 pr-4 text-left transition-colors ${
                            active
                              ? 'bg-coral/10 ring-1 ring-inset ring-coral/25'
                              : 'hover:bg-card'
                          }`}
                        >
                          {active && (
                            <span
                              aria-hidden
                              className="absolute inset-y-2 right-1 w-1 rounded-full bg-coral"
                            />
                          )}
                          <div className="flex items-baseline justify-between gap-2">
                            <span
                              className={`line-clamp-1 text-sm ${
                                active
                                  ? 'font-semibold text-coral-deep'
                                  : archived
                                    ? 'font-medium text-ink-soft'
                                    : 'font-medium text-ink'
                              }`}
                            >
                              {session.title}
                            </span>
                            <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">
                              {formatSessionTime(session.lastMessageAt)}
                            </span>
                          </div>

                          {preview && (
                            <p className="mt-0.5 line-clamp-1 text-xs text-ink-faint">{preview}</p>
                          )}

                          {(running || archived) && (
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              {running && (
                                <span className="inline-flex items-center gap-1 rounded-full border border-sky/40 bg-sky/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky">
                                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky" />
                                  most dolgozik
                                </span>
                              )}
                              {archived && (
                                <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] text-ink-faint">
                                  archivált
                                </span>
                              )}
                            </div>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}

            {hasMore && onLoadMore && (
              <button
                type="button"
                onClick={onLoadMore}
                disabled={loadingMore}
                className="w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/30 hover:text-coral-deep disabled:opacity-40"
              >
                {loadingMore ? 'Betöltés…' : 'Régebbi beszélgetések'}
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}

export type { ChatSession, ChatSessionStatusFilter }
