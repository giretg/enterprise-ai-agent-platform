'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { getAgent } from '@/app/actions/platform'
import { getRunAnalysisEntry } from '@/app/actions/run-analysis'
import { AgentChatPanel } from '@/components/agents/agent-chat-panel'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AgentWorkspaceApps } from '@/components/agents/agent-workspace-apps'
import { AgentTaskPanel } from '@/components/agents/agent-task-button'
import { personaFor } from '@/lib/agent-persona'
import { recordLastAgentChatForCurrentTenant } from '@/lib/last-agent-chat'
import {
  liveStatusLabel,
  type AgentRailCardState,
  type AgentRailStateResponse,
  type AgentWorkspaceTab,
} from '@/lib/agent-rail-types'
import {
  agentWorkspacePath,
  isAgentWorkspaceClientTab,
  isAgentWorkspaceRouteTab,
  isAgentWorkspaceTab,
  workspaceTabsForAgent,
  type AgentWorkspaceClientTab,
  type AgentWorkspaceRouteTab,
} from '@/lib/agent-workspace-routes'
import type { RunAnalysisEntry } from '@/lib/run-analysis-shared'
import {
  getWorkspaceChatAnalyzeState,
  subscribeWorkspaceChatChrome,
  workspaceChatAnalyze,
  workspaceChatDetach,
  workspaceChatStartNew,
  workspaceChatToggleHistory,
} from '@/lib/agent-workspace-chat-chrome'

type WorkspaceAgent = {
  id: string
  name: string
  status: string
  avatarUrl: string | null
  personaNickname: string | null
  roleInstruction: string
  taskOnly: boolean
}

function workspaceSubtitle(agent: WorkspaceAgent, railCard: AgentRailCardState | null): string {
  const role =
    railCard?.roleLabel?.trim() ||
    agent.roleInstruction?.trim().split(/[.!?\n]/)[0]?.slice(0, 48) ||
    'Munkatárs'
  const status = railCard ? liveStatusLabel(railCard.liveStatus) : '—'
  const when = railCard?.elapsed?.trim()
  return when ? `${role} · ${status} · ${when}` : `${role} · ${status}`
}

function EmptyWorkspace() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Munkaterület</p>
      <h2 className="mt-3 max-w-md font-display text-2xl font-semibold">
        Válassz egy munkatársat a bal sávból
      </h2>
      <p className="mt-2 max-w-lg text-sm text-ink-soft">
        Itt folytatod a beszélgetést, indítasz munkát, vagy megnézed az adatlapot — miközben a
        fejléc-menük ablakban nyílnak, és a futó munka nem szakad meg.
      </p>
    </div>
  )
}

function WorkspaceIconButton({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-card text-sm text-ink-soft transition-colors hover:bg-night-2 hover:text-ink"
    >
      {children}
    </button>
  )
}

function useWorkspaceAnalyzeButton() {
  const [entry, setEntry] = useState<RunAnalysisEntry | null>(null)
  const [chrome, setChrome] = useState(getWorkspaceChatAnalyzeState)

  useEffect(() => {
    void getRunAnalysisEntry().then((res) => {
      if (res.success) setEntry(res.data)
    })
  }, [])

  useEffect(() => {
    const sync = () => setChrome(getWorkspaceChatAnalyzeState())
    sync()
    return subscribeWorkspaceChatChrome(sync)
  }, [])

  const canAnalyze = Boolean(
    entry?.canRunAnalysis && entry.runAnalystAgentId && chrome.hasSavedConversation,
  )

  return {
    canAnalyze,
    analyzeDisabled: chrome.analyzeDisabled,
  }
}

function WorkspaceHeader({
  agent,
  tab,
  railCard,
}: {
  agent: WorkspaceAgent
  tab: AgentWorkspaceTab
  railCard: AgentRailCardState | null
}) {
  const persona = personaFor(agent.name, agent)
  const router = useRouter()
  const showChatChrome = tab === 'chat' && !agent.taskOnly
  const { canAnalyze, analyzeDisabled } = useWorkspaceAnalyzeButton()

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-card/55 px-4 py-3 backdrop-blur-sm sm:gap-3 sm:px-5">
      <AgentAvatar
        name={agent.name}
        status={agent.status}
        size="md"
        avatarUrl={agent.avatarUrl}
        personaNickname={agent.personaNickname}
      />
      <div className="min-w-0 flex-1 sm:max-w-[14rem]">
        <h1 className="truncate font-display text-[17px] font-bold leading-tight">{persona.nickname}</h1>
        <p className="truncate text-[11.5px] text-ink-faint">{workspaceSubtitle(agent, railCard)}</p>
      </div>

      <nav
        aria-label="Munkaterület fülek"
        className="order-last flex w-full gap-0.5 rounded-xl border border-line bg-night-2 p-0.5 sm:order-none sm:ml-2 sm:w-auto"
      >
        {workspaceTabsForAgent(agent.taskOnly).map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            onClick={() => router.push(agentWorkspacePath(agent.id, item.key))}
            className={`rounded-[9px] px-3 py-1.5 text-[13px] font-semibold transition-colors sm:px-3.5 ${
              tab === item.key
                ? 'bg-card text-coral-deep shadow-sm'
                : 'text-ink-faint hover:text-ink-soft'
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {showChatChrome ? (
        <div className="ml-auto flex items-center gap-2">
          {canAnalyze ? (
            <button
              type="button"
              title="Futás-elemző megnyitása ezzel a beszélgetéssel kitöltve"
              aria-label="Elemezd"
              disabled={analyzeDisabled}
              onClick={() => workspaceChatAnalyze()}
              className="inline-flex h-8 shrink-0 items-center rounded-lg border border-honey/35 bg-honey/10 px-2.5 text-[13px] font-semibold text-honey transition-colors hover:bg-honey/20 disabled:opacity-40 lg:px-3"
            >
              Elemezd
            </button>
          ) : null}
          <button
            type="button"
            title="Új beszélgetés"
            aria-label="Új beszélgetés"
            onClick={() => workspaceChatStartNew()}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-coral px-2.5 text-[13px] font-semibold text-card shadow-[0_8px_18px_-12px_rgba(178,58,85,0.9)] transition-colors hover:bg-coral-deep lg:px-3"
          >
            <span aria-hidden>＋</span>
            <span className="hidden lg:inline">Új beszélgetés</span>
          </button>
          <WorkspaceIconButton title="Előzmények" onClick={() => workspaceChatToggleHistory()}>
            🕘
          </WorkspaceIconButton>
          <WorkspaceIconButton title="Megnyitás külön ablakban" onClick={() => workspaceChatDetach()}>
            ⧉
          </WorkspaceIconButton>
        </div>
      ) : tab === 'profile' || tab === 'training' ? null : (
        <button
          type="button"
          onClick={() => router.push(agentWorkspacePath(agent.id, 'profile'))}
          className="ml-auto rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft hover:border-coral/40"
        >
          Adatlap
        </button>
      )}
    </header>
  )
}

function WorkspaceChat({ agent, initialPrefill }: { agent: WorkspaceAgent; initialPrefill?: string | null }) {
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <AgentChatPanel
        key={agent.id}
        agent={agent}
        open
        embedded
        initialPrefill={initialPrefill ?? null}
        onClose={() => {}}
      />
    </div>
  )
}

function WorkspaceTask({ agent }: { agent: WorkspaceAgent }) {
  if (!agent.taskOnly) return null
  return (
    <div className="flex-1 overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-2xl">
        <AgentTaskPanel agentId={agent.id} />
      </div>
    </div>
  )
}

function WorkspaceApps({ agent }: { agent: WorkspaceAgent }) {
  return <AgentWorkspaceApps agentId={agent.id} taskOnly={agent.taskOnly} />
}

function WorkspaceProfile({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">{children}</div>
}

export function AgentWorkspace({
  children = null,
}: {
  children?: React.ReactNode
}) {
  const params = useParams<{ agentId?: string; tab?: string }>()
  const searchParams = useSearchParams()
  const router = useRouter()
  const agentId = params.agentId
  const tab = isAgentWorkspaceTab(params.tab) ? params.tab : 'chat'
  const initialPrefill = searchParams.get('prefill')?.trim() || null
  const [agent, setAgent] = useState<WorkspaceAgent | null>(null)
  const [railCard, setRailCard] = useState<AgentRailCardState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!agentId) return
    let cancelled = false
    void getAgent({ id: agentId }).then((res) => {
      if (cancelled) return
      if (!res.success) {
        setError(res.error)
        setAgent(null)
        return
      }
      setAgent({
        id: res.data.agent.id,
        name: res.data.agent.name,
        status: res.data.agent.status,
        avatarUrl: res.data.agent.avatarUrl,
        personaNickname: res.data.agent.personaNickname,
        roleInstruction: res.data.agent.roleInstruction,
        taskOnly: res.data.agent.taskOnly,
      })
      setError(null)
    })
    return () => {
      cancelled = true
    }
  }, [agentId])

  useEffect(() => {
    if (!agentId) return
    let cancelled = false
    const refreshRail = async () => {
      try {
        const res = await fetch('/api/agents/rail-state', { cache: 'no-store' })
        if (!res.ok || cancelled) return
        const data = (await res.json()) as AgentRailStateResponse
        setRailCard(data.agents.find((row) => row.id === agentId) ?? null)
      } catch {
        if (!cancelled) setRailCard(null)
      }
    }
    void refreshRail()
    const timer = window.setInterval(() => void refreshRail(), 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [agentId])

  useEffect(() => {
    if (!agent || !agentId || agent.id !== agentId) return
    if (agent.taskOnly && tab === 'chat') {
      router.replace(agentWorkspacePath(agentId, 'task'))
      return
    }
    if (!agent.taskOnly && tab === 'task') {
      router.replace(agentWorkspacePath(agentId, 'chat'))
    }
  }, [agent, agentId, tab, router])

  useEffect(() => {
    if (!agent || !agentId || agent.id !== agentId) return
    void recordLastAgentChatForCurrentTenant(agentId)
  }, [agent, agentId])

  if (!agentId) return <EmptyWorkspace />

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-coral-deep">{error}</p>
      </div>
    )
  }

  if (!agent || agent.id !== agentId) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-ink-faint">Betöltés…</p>
      </div>
    )
  }

  const loading = (
    <div className="flex flex-1 items-center justify-center p-6">
      <p className="text-sm text-ink-faint">Betöltés…</p>
    </div>
  )
  const clientContent: Record<AgentWorkspaceClientTab, React.ReactNode> = {
    chat: agent.taskOnly ? null : (
      <WorkspaceChat agent={agent} initialPrefill={initialPrefill} />
    ),
    task: <WorkspaceTask agent={agent} />,
    apps: <WorkspaceApps agent={agent} />,
  }
  const routeContent: Record<AgentWorkspaceRouteTab, React.ReactNode> = {
    board: children ?? loading,
    training: children ?? loading,
    profile: <WorkspaceProfile>{children}</WorkspaceProfile>,
  }
  const content = isAgentWorkspaceClientTab(tab)
    ? clientContent[tab]
    : isAgentWorkspaceRouteTab(tab)
      ? routeContent[tab]
      : null

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-night/30">
      <WorkspaceHeader agent={agent} tab={tab} railCard={railCard} />
      {content}
    </div>
  )
}

export function AgentWorkspaceRouter({ isAgentRoute }: { isAgentRoute: boolean }) {
  if (!isAgentRoute) return <EmptyWorkspace />
  return <AgentWorkspace />
}
