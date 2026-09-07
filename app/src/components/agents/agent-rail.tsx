'use client'

import Link from 'next/link'
import { useCallback, useMemo, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { AgentRailCard } from '@/components/agents/agent-rail-card'
import {
  setAgentRailFilter,
  setAgentRailCollapsed,
  setAgentRailMobileOpen,
  setAgentRailSearch,
  toggleAgentRailCollapsed,
  useAgentRailUiState,
} from '@/components/agents/agent-rail-store'
import { openControlPlanePanel } from '@/lib/control-plane-panel-store'
import {
  agentWorkspacePath,
  defaultAgentWorkspaceTab,
  parseAgentWorkspacePath,
} from '@/lib/agent-workspace-routes'
import { useAdaptivePoll } from '@/lib/use-adaptive-poll'
import {
  railFilterMatches,
  type AgentRailCardState,
  type AgentRailFilter,
  type AgentRailStateResponse,
  type AgentWorkspaceTab,
} from '@/lib/agent-rail-types'

/** Sűrű ütem: dolgozik vagy rád vár valamelyik agent. */
const POLL_ACTIVE_MS = 5000
/** Nyugalmi ütem: mindenki szabad — ilyenkor ritkábban kérdezünk. */
const POLL_IDLE_MS = 20000

const FILTERS: { key: AgentRailFilter; label: string; dot?: string }[] = [
  { key: 'all', label: 'Mind' },
  { key: 'wait', label: 'Vár rád', dot: 'bg-honey' },
  { key: 'busy', label: 'Dolgozik', dot: 'bg-sky' },
  { key: 'idle', label: 'Szabad', dot: 'bg-sage' },
]

function selectedAgentIdFromPath(pathname: string): string | null {
  return parseAgentWorkspacePath(pathname)?.agentId ?? null
}

export function AgentRail({
  canCreateAgent,
}: {
  canCreateAgent?: boolean
}) {
  const pathname = usePathname()
  const router = useRouter()
  const ui = useAgentRailUiState()
  const selectedId = selectedAgentIdFromPath(pathname)
  const [cards, setCards] = useState<AgentRailCardState[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/agents/rail-state', { cache: 'no-store' })
      if (!res.ok) {
        setLoadError('A csapat állapota most nem frissíthető.')
        return
      }
      const data = (await res.json()) as AgentRailStateResponse
      setCards(data.agents)
      setLoadError(null)
    } catch {
      setLoadError('A csapat állapota most nem frissíthető.')
    }
  }, [])

  const someoneNeedsAttention = useMemo(
    () => cards.some((card) => card.liveStatus === 'busy' || card.liveStatus === 'wait'),
    [cards],
  )
  useAdaptivePoll(refresh, {
    activeMs: POLL_ACTIVE_MS,
    idleMs: POLL_IDLE_MS,
    idle: !someoneNeedsAttention,
  })

  const filtered = useMemo(() => {
    const q = ui.search.trim().toLowerCase()
    return cards.filter((card) => {
      if (!railFilterMatches(ui.filter, card.liveStatus)) return false
      if (!q) return true
      const hay =
        `${card.name} ${card.roleLabel} ${card.roleDescription} ${card.personaNickname ?? ''} ${card.personaGreeting ?? ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [cards, ui.filter, ui.search])

  const busyCount = cards.filter((c) => c.liveStatus === 'busy').length

  const navigateAgent = (agentId: string, tab?: AgentWorkspaceTab) => {
    setAgentRailMobileOpen(false)
    const card = cards.find((c) => c.id === agentId)
    const defaultTab: AgentWorkspaceTab = defaultAgentWorkspaceTab(card?.taskOnly ?? false)
    router.push(agentWorkspacePath(agentId, tab ?? defaultTab))
  }

  const navigateAttention = (href: string) => {
    setAgentRailMobileOpen(false)
    router.push(href)
  }

  const railInner = (
    <>
      <div className="shrink-0 border-b border-line/80 p-3.5 pb-2.5">
        <div className="mb-2.5 flex items-center gap-2">
          {!ui.collapsed ? (
            <>
              <h2 className="font-display text-base font-bold">Munkatársak</h2>
              <span className="text-[11px] font-semibold text-ink-faint">
                {cards.length} · {busyCount} dolgozik
              </span>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => setAgentRailMobileOpen(false)}
            className="ml-auto grid h-9 w-9 place-items-center rounded-lg border border-line bg-card text-base text-ink-soft hover:bg-night-2 xl:hidden"
            aria-label="Munkatárslista bezárása"
          >
            ✕
          </button>
          <button
            type="button"
            onClick={() => toggleAgentRailCollapsed()}
            className="ml-auto hidden h-7 w-7 place-items-center rounded-lg border border-line bg-card text-xs text-ink-soft hover:bg-night-2 xl:grid"
            aria-label={ui.collapsed ? 'Sáv kinyitása' : 'Sáv összecsukása'}
          >
            {ui.collapsed ? '⟩' : '⟨'}
          </button>
        </div>

        {!ui.collapsed ? (
          <>
            <div className="relative mb-2.5">
              <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-xs opacity-50">
                🔍
              </span>
              <input
                type="search"
                value={ui.search}
                onChange={(e) => setAgentRailSearch(e.target.value)}
                placeholder="Keresés név vagy szerepkör szerint…"
                className="w-full rounded-[10px] border border-line bg-paper py-2 pr-3 pl-8 text-[13px] text-ink placeholder:text-ink-faint"
              />
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Szűrők">
              {FILTERS.map((filter) => (
                <button
                  key={filter.key}
                  type="button"
                  aria-pressed={ui.filter === filter.key}
                  onClick={() => setAgentRailFilter(filter.key)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                    ui.filter === filter.key
                      ? 'border-coral bg-coral text-card'
                      : 'border-line bg-card text-ink-soft hover:text-ink'
                  }`}
                >
                  {filter.dot ? (
                    <span
                      aria-hidden
                      className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${filter.dot}`}
                    />
                  ) : null}
                  {filter.label}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>

      <div
        role="listbox"
        aria-label="Munkatársak"
        className={`min-h-0 flex-1 overflow-y-auto px-3 py-2 ${ui.collapsed ? 'flex flex-col items-center gap-2' : 'space-y-2'}`}
      >
        {loadError ? (
          <p className="px-2 py-3 text-xs text-coral-deep">{loadError}</p>
        ) : filtered.length === 0 ? (
          <p className="px-2 py-3 text-xs text-ink-faint">Nincs találat erre a szűrésre.</p>
        ) : (
          filtered.map((card) => (
            <AgentRailCard
              key={card.id}
              card={card}
              selected={selectedId === card.id}
              collapsed={ui.collapsed}
              onSelect={() => navigateAgent(card.id)}
              onOpenTab={(tab) => navigateAgent(card.id, tab)}
              onOpenAttention={navigateAttention}
            />
          ))
        )}
      </div>

      {!ui.collapsed ? (
        <div className="shrink-0 border-t border-line/80 p-3">
          {canCreateAgent ? (
            <button
              type="button"
              onClick={() => openControlPlanePanel('agent.new')}
              className="w-full rounded-[10px] border border-dashed border-line py-2 text-xs font-semibold text-ink-soft hover:border-solid hover:bg-card hover:text-ink"
            >
              + Új munkatárs
            </button>
          ) : (
            <Link
              href="/control-plane/agents"
              className="block w-full rounded-[10px] border border-dashed border-line py-2 text-center text-xs font-semibold text-ink-soft hover:border-solid hover:bg-card hover:text-ink"
            >
              Teljes lista
            </Link>
          )}
        </div>
      ) : null}
    </>
  )

  return (
    <>
      {/* Mobil fiók */}
      <div
        className={`fixed inset-0 z-40 bg-ink/30 backdrop-blur-[2px] transition-opacity xl:hidden ${
          ui.mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={() => setAgentRailMobileOpen(false)}
        aria-hidden={!ui.mobileOpen}
      />
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex h-full min-h-0 w-[min(100vw-2rem,336px)] shrink-0 flex-col overflow-hidden border-r border-line bg-card/95 backdrop-blur-md transition-[width,transform] duration-200 xl:static xl:top-auto ${
          ui.collapsed ? 'xl:w-[76px]' : 'xl:w-[336px]'
        } ${
          ui.mobileOpen ? 'translate-x-0' : '-translate-x-full xl:translate-x-0'
        }`}
        aria-label="Munkatárs-sáv"
      >
        {railInner}
      </aside>
    </>
  )
}

/** Fejléc gomb: mobil sáv megnyitása (<1080px). */
export function AgentRailMobileToggle() {
  const ui = useAgentRailUiState()
  const toggle = () => {
    if (!ui.mobileOpen) setAgentRailCollapsed(false)
    setAgentRailMobileOpen(!ui.mobileOpen)
  }
  return (
    <button
      type="button"
      onClick={toggle}
      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-line bg-card px-2.5 text-xs font-semibold text-ink-soft hover:border-coral/40 hover:text-coral-deep xl:hidden"
      aria-label="Munkatárs váltása"
      aria-expanded={ui.mobileOpen}
    >
      <span className="text-sm">👥</span>
      <span>Munkatársak</span>
    </button>
  )
}
