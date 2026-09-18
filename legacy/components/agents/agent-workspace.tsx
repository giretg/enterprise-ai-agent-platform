'use client'

import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { getAgent, getAgentBoardTabBadge } from '@/app/actions/platform'
import { getRunAnalysisEntry } from '@/app/actions/run-analysis'
import { AgentChatPanel } from '@/components/agents/agent-chat-panel'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AgentWorkspaceApps } from '@/components/agents/agent-workspace-apps'
import { AgentTaskPanel } from '@/components/agents/agent-task-button'
import { setAgentRailMobileOpen } from '@/components/agents/agent-rail-store'
import { recordLastAgentChatForCurrentTenant } from '@/lib/last-agent-chat'
import { type AgentWorkspaceTab } from '@/lib/agent-rail-types'
import { boardTabBadge, type BoardTabBadge } from '@/lib/board-tab-badge'
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
  getWorkspaceChatChromeState,
  subscribeWorkspaceChatChrome,
  workspaceChatAnalyze,
  workspaceChatDetach,
  workspaceChatDistill,
  workspaceChatSetDistillTarget,
  workspaceChatStartNew,
  workspaceChatToggleHistory,
} from '@/lib/agent-workspace-chat-chrome'
import {
  ChatHeaderMenu,
  ChatMenuItem,
  DistillSkillMenuItems,
  FallbackModelBadge,
} from '@/components/agents/agent-chat-message'

type WorkspaceAgent = {
  id: string
  name: string
  status: string
  avatarUrl: string | null
  personaNickname: string | null
  personaGreeting: string | null
  roleInstruction: string
  taskOnly: boolean
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
  className = '',
  children,
}: {
  title: string
  onClick: () => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`grid h-8 w-8 place-items-center rounded-lg border border-line bg-card text-sm text-ink-soft transition-colors hover:bg-night-2 hover:text-ink ${className}`}
    >
      {children}
    </button>
  )
}

function useWorkspaceAnalyzeButton() {
  const [entry, setEntry] = useState<RunAnalysisEntry | null>(null)
  const [chrome, setChrome] = useState(getWorkspaceChatChromeState)

  useEffect(() => {
    void getRunAnalysisEntry().then((res) => {
      if (res.success) setEntry(res.data)
    })
  }, [])

  useEffect(() => {
    const sync = () => setChrome(getWorkspaceChatChromeState())
    sync()
    return subscribeWorkspaceChatChrome(sync)
  }, [])

  const canAnalyze = Boolean(
    entry?.canRunAnalysis && entry.runAnalystAgentId && chrome.hasSavedConversation,
  )

  return {
    canAnalyze,
    analyzeDisabled: chrome.analyzeDisabled,
    canDistill: chrome.hasSavedConversation,
    fallbackModel: chrome.fallbackModel,
    distillDisabled: chrome.distillDisabled,
    distillPending: chrome.distillPending,
    distillTargets: chrome.distillTargets,
    distillTargetSkillId: chrome.distillTargetSkillId,
  }
}

const BOARD_TAB_BADGE_POLL_MS = 15_000

function useBoardTabBadge(agentId: string) {
  const [badge, setBadge] = useState<BoardTabBadge | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      try {
        const res = await getAgentBoardTabBadge({ agentId })
        if (cancelled) return
        if (!res.success) return
        setBadge(boardTabBadge(res.data))
      } catch {
        // Előző szám marad — a poll majd újrapróbálja.
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), BOARD_TAB_BADGE_POLL_MS)
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [agentId])

  return badge
}

function WorkspaceHeader({
  agent,
  tab,
}: {
  agent: WorkspaceAgent
  tab: AgentWorkspaceTab
}) {
  const router = useRouter()
  const showChatChrome = tab === 'chat' && !agent.taskOnly
  const {
    canAnalyze,
    analyzeDisabled,
    canDistill,
    fallbackModel,
    distillDisabled,
    distillPending,
    distillTargets,
    distillTargetSkillId,
  } = useWorkspaceAnalyzeButton()
  const boardBadge = useBoardTabBadge(agent.id)
  // Mobilon a fülsor vízszintesen görgethető — az aktív fül különben kicsúszhat a képből.
  const activeTabRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [tab])

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-card/55 px-3 py-2.5 backdrop-blur-sm sm:gap-3 sm:px-5 sm:py-3">
      {/* Mobilon az avatar nyitja a munkatárs-sávot; asztali gépen a sáv kijelölése mutatja az agentet. */}
      <button
        type="button"
        onClick={() => setAgentRailMobileOpen(true)}
        className="shrink-0 rounded-full text-left xl:hidden"
        aria-label="Munkatárs váltása"
        title="Munkatárs váltása"
      >
        <AgentAvatar
          name={agent.name}
          status={agent.status}
          size="md"
          avatarUrl={agent.avatarUrl}
          personaNickname={agent.personaNickname}
        />
      </button>

      <nav
        aria-label="Munkaterület fülek"
        className="order-last flex w-full gap-0.5 overflow-x-auto rounded-xl border border-line bg-night-2 p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:order-none sm:ml-2 sm:w-auto"
      >
        {workspaceTabsForAgent(agent.taskOnly).map((item) => {
          const badge = item.key === 'board' ? boardBadge : null
          return (
            <button
              key={item.key}
              ref={tab === item.key ? activeTabRef : undefined}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              aria-label={
                badge ? `${item.label}, ${badge.count} ${badge.spoken}` : item.label
              }
              title={badge?.hint}
              onClick={() => router.push(agentWorkspacePath(agent.id, item.key))}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-[9px] px-3 py-1.5 text-[13px] font-semibold transition-colors sm:px-3.5 ${
                tab === item.key
                  ? 'bg-card text-coral-deep shadow-sm'
                  : 'text-ink-faint hover:text-ink-soft'
              }`}
            >
              {item.label}
              {badge ? (
                <span
                  aria-hidden
                  className={`inline-flex min-w-[1.15rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none ${
                    badge.tone === 'wait'
                      ? 'bg-coral/15 text-coral'
                      : 'bg-sky/15 text-sky'
                  }`}
                >
                  {badge.count}
                </span>
              ) : null}
            </button>
          )
        })}
      </nav>

      {showChatChrome ? (
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <FallbackModelBadge model={fallbackModel} />
          {canDistill ? (
            <ChatHeaderMenu>
              {canAnalyze ? (
                <ChatMenuItem
                  title="Elemezd"
                  hint="Futás-elemző megnyitása ezzel a beszélgetéssel kitöltve."
                  onClick={() => workspaceChatAnalyze()}
                  disabled={analyzeDisabled}
                />
              ) : null}
              <DistillSkillMenuItems
                pending={distillPending}
                disabled={distillDisabled}
                targets={distillTargets}
                targetSkillId={distillTargetSkillId}
                onTargetChange={workspaceChatSetDistillTarget}
                onDistill={() => workspaceChatDistill()}
              />
            </ChatHeaderMenu>
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
          {/* A lebegő csempe csak asztali gépen használható — mobilon elrejtve. */}
          <WorkspaceIconButton
            title="Megnyitás külön ablakban"
            onClick={() => workspaceChatDetach()}
            className="hidden sm:grid"
          >
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

function WorkspaceChat({
  agent,
  initialPrefill,
  initialConversationId,
  focusMessageId,
}: {
  agent: WorkspaceAgent
  initialPrefill?: string | null
  initialConversationId?: string | null
  focusMessageId?: string | null
}) {
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <AgentChatPanel
        key={`${agent.id}:${initialConversationId ?? ''}`}
        agent={agent}
        open
        embedded
        initialPrefill={initialPrefill ?? null}
        initialConversationId={initialConversationId ?? null}
        focusMessageId={focusMessageId ?? null}
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
  const conversationParam = searchParams.get('conversation')?.trim() || null
  const messageParam = searchParams.get('message')?.trim() || null
  const [agent, setAgent] = useState<WorkspaceAgent | null>(null)
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
        personaGreeting: res.data.agent.personaGreeting,
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
      <WorkspaceChat
        agent={agent}
        initialPrefill={initialPrefill}
        initialConversationId={conversationParam}
        focusMessageId={messageParam}
      />
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
      <WorkspaceHeader agent={agent} tab={tab} />
      {content}
    </div>
  )
}

export function AgentWorkspaceRouter({ isAgentRoute }: { isAgentRoute: boolean }) {
  if (!isAgentRoute) return <EmptyWorkspace />
  return <AgentWorkspace />
}
