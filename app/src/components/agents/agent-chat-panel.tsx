'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition } from 'react'
import { createPortal, flushSync } from 'react-dom'
import {
  archiveConversation,
  createAgentTaskTicket,
  createScheduledAgentTask,
  deleteMessageContent,
  findLatestAgentChatSession,
  listAgentChatSessions,
  listChatTaskCards,
  loadAgentChatMessages,
  promoteConversationWithAi,
} from '@/app/actions/platform'
import { distillSkillFromConversationAction, getAgentSkillsAction } from '@/app/actions/skills'
import { exportConversationDebugLog } from '@/app/actions/debug-log'
import { getRunAnalysisEntry } from '@/app/actions/run-analysis'
import { listChatTriggerableProcessDefinitions } from '@/app/actions/process'
import { processRequiresFileAttachment } from '@/lib/playbook-v2/trigger-input'
import { listAgentDelegatedConnectors } from '@/app/actions/connector-grants'
import { connectorGrantCardFromLoopEvent } from '@/domain/connector-grant/connector-grant-needed'
import { getTenantThinkingTraceControls } from '@/app/actions/chat-thinking-trace'
import { AgentDelegatedConnectorsBar } from '@/components/agents/agent-delegated-connectors-bar'
import type { AgentDelegatedConnectorRow } from '@/lib/agent-delegated-connectors'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import {
  removeAgentChatDockEntry,
  upsertAgentChatDockEntry,
} from '@/components/agents/agent-chat-dock-store'
import {
  clearAgentChatResumeAfterGrant,
  openAgentChat,
  persistAgentChatForOAuth,
} from '@/components/agents/agent-chat-session-store'
import { ChatMarkdown, TypingIndicator } from '@/components/chat/chat-markdown'
import {
  buildRunAnalysisHref,
  type RunAnalysisEntry,
} from '@/lib/run-analysis-shared'
import { getChatPrivacyMarkerContext } from '@/app/actions/privacy'
import type { ChatPrivacyMarkerContext } from '@/lib/privacy-chat-markers'
import {
  chatMessageShowsAgentActivity,
  mergeTurnProgressIntoMessages,
  type ChatTurnActivity,
} from '@/lib/chat-turn-progress'
import {
  useAgentChatTurnLiveness,
} from '@/components/agents/use-agent-chat-turn-liveness'
import {
  decideChatStreamRecovery,
  resolveChatStreamConflict,
  STREAM_RECOVERED_MESSAGE,
  STREAM_RECOVERY_FAILED_MESSAGE,
  type ChatStreamEnding,
} from '@/lib/chat-stream-recovery'
import {
  AgentChatSessionSidebar,
  type ChatSession,
  type ChatSessionStatusFilter,
} from '@/components/chat/chat-session-sidebar'
import {
  ConversationFilesPanel,
  type ConversationFilesPanelHandle,
} from '@/components/chat/conversation-files-panel'
import { personaFor } from '@/lib/agent-persona'
import { recordLastAgentChatForCurrentTenant } from '@/lib/last-agent-chat'
import {
  conversationIdToResume,
  previousConversationLoaderVisible,
  shouldSkipDuplicateSessionSelect,
  type ConversationHistoryLoadState,
} from '@/lib/resume-last-agent-conversation'
import { LoadingState } from '@/components/ui/spinner'
import { useAgentWorkspaceChatChrome } from '@/components/agents/use-agent-workspace-chat-chrome'
import {
  ChatHeaderMenu,
  ChatMenuItem,
  MessageBubble,
  type AgentActivity,
  type ChatMessage,
  type ConsequenceApprovalCard,
  type MemoryCandidateCard,
} from '@/components/agents/agent-chat-message'
import {
  agentBubbleIdForTurn,
  makePendingAttachment,
  readAgentChatEventStream,
  stripGrantedQueryFromUrl,
  stripPrefillQueryFromUrl,
  uploadAttachments,
  upsertActivity,
  upsertConnectorGrant,
  upsertConsequenceApproval,
  upsertMemoryCandidate,
  withPendingChatExtras,
  type PendingAttachment,
} from '@/components/agents/agent-chat-state'
import {
  appendThinkingDelta,
  canStartThinkingTraceStream,
  type ThinkingTraceControlState,
} from '@/lib/chat-thinking-trace'
import { skillNameToSlashToken } from '@/lib/skill/skill-slash-command'
import {
  useSkillSlashAutocomplete,
} from '@/components/skills/skill-slash-autocomplete'
import {
  EMPTY_TASK_SCHEDULE,
  taskScheduleToInput,
  validateTaskSchedule,
  type TaskScheduleState,
} from '@/components/tickets/task-schedule-fields'
import {
  AgentChatComposer,
  type AgentChatComposerMode,
  type ChatProcessDefinition,
  type ChatSkillOption,
} from '@/components/agents/agent-chat-composer'
import { MemoryStrip } from '@/components/agents/memory-strip'
import { type ChatTaskCardView } from '@/lib/work-traceability'

const CHAT_SESSIONS_PAGE_SIZE = 10

type ChatAgent = {
  id: string
  name: string
  status?: string
  avatarUrl?: string | null
  personaNickname?: string | null
  personaGreeting?: string | null
  personaTrait?: string | null
}

export function AgentChatPanel({
  agent,
  open,
  onClose,
  canDistillSkill = false,
  initialConversationId = null,
  resumeAfterGrant = false,
  initialPrefill = null,
  restoreSignal = 0,
  tileTarget = null,
  embedded = false,
  focusMessageId = null,
}: {
  agent: ChatAgent
  open: boolean
  onClose: () => void
  /** Admin: D14 skill-desztilláció a beszélgetésből (skill-catalog-spec §WP-6). */
  canDistillSkill?: boolean
  /** Deep-link / Aktív futások: nyitáskor ezt a beszélgetést tölti be + reattach. */
  initialConversationId?: string | null
  /** OAuth-grant után a szerveroldali folytatás-forduló. */
  resumeAfterGrant?: boolean
  /** RA-08: deep-link — szerkeszthető első üzenet a composerben (nem auto-send). */
  initialPrefill?: string | null
  /** Növekvő jel: újboli megnyitáskor leveszi a tálcáról. */
  restoreSignal?: number
  /** A közös session-host célpontja: itt a megnyitott panelek reszponzív rácsba kerülnek. */
  tileTarget?: HTMLElement | null
  /** Agent-sáv munkaterület: inline chat, nem lebegő ablak. */
  embedded?: boolean
  /** Tábla „Eredet” ugrás: ezt az üzenetet emeli ki. */
  focusMessageId?: string | null
}) {
  const persona = personaFor(agent.name, agent)
  const router = useRouter()
  const dockId = useId()
  const [input, setInput] = useState('')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [workspaceFilePaths, setWorkspaceFilePaths] = useState<string[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [lastTicketId, setLastTicketId] = useState<string | null>(null)
  const [ticketSchedule, setTicketSchedule] = useState<TaskScheduleState>(EMPTY_TASK_SCHEDULE)
  const [ticketAuthorizeRunAs, setTicketAuthorizeRunAs] = useState(false)
  const [isAgentTyping, setIsAgentTyping] = useState(false)
  const [stopPending, setStopPending] = useState(false)
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const applyPolledTurnProgress = useCallback(
    (progress: { turnId: string; partialText: string; activities: ChatTurnActivity[] }) => {
      const agentMessageId = agentBubbleIdForTurn(progress.turnId)
      flushSync(() => {
        setMessages((prev) =>
          mergeTurnProgressIntoMessages(prev, {
            agentMessageId,
            activities: progress.activities,
            partialText: progress.partialText,
          }),
        )
      })
    },
    [],
  )
  const {
    stalled: activeTurnStalled,
    stallDetail: activeTurnStallDetail,
    reset: resetActiveTurnLiveness,
    updateFromSnapshot: updateActiveTurnLiveness,
  } = useAgentChatTurnLiveness({
    active: isAgentTyping,
    conversationId,
    activeTurnId,
    onProgress: applyPolledTurnProgress,
  })
  const clearActiveTurnState = useCallback(() => {
    setIsAgentTyping(false)
    setActiveTurnId(null)
    resetActiveTurnLiveness()
  }, [resetActiveTurnLiveness])
  const [runningConversationIds, setRunningConversationIds] = useState<string[]>([])
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [historyLoadState, setHistoryLoadState] = useState<ConversationHistoryLoadState>('idle')
  const [latestConversationId, setLatestConversationId] = useState<string | null | undefined>(
    undefined,
  )
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false)
  const [sessionsHasMore, setSessionsHasMore] = useState(false)
  const [sessionsNextOffset, setSessionsNextOffset] = useState(0)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [sessionsFilter, setSessionsFilter] = useState<ChatSessionStatusFilter>('active')
  const [conversationStatus, setConversationStatus] = useState<'active' | 'archived'>('active')
  /** Ticket → Megbeszélés (#219): forrás feladat a chat fejlécében. */
  const [continuedFromTicket, setContinuedFromTicket] = useState<{
    id: string
    title: string
  } | null>(null)
  /** Ticket-szál olvasható előzménye a megbeszélés chatben (nem Message rekord). */
  const [ticketDiscussionHistory, setTicketDiscussionHistory] = useState<
    Array<{
      id: string
      role: 'user' | 'agent' | 'system'
      text: string
      authorLabel: string
      createdAt: string
    }>
  >([])
  const [chatProcessDefs, setChatProcessDefs] = useState<ChatProcessDefinition[]>([])
  const [selectedProcessDefId, setSelectedProcessDefId] = useState<string | null>(null)
  /**
   * Mi legyen az üzenetből: válasz most (chat) vagy feladat a táblán (task).
   * Korábban ez implicit volt — két egyenrangú gomb állt egymás mellett, és a
   * feladat-specifikus mezők (ütemezés, run-as) akkor is látszottak, amikor
   * sima beszélgetés folyt.
   */
  const [composerMode, setComposerMode] = useState<AgentChatComposerMode>('chat')
  const [taskCards, setTaskCards] = useState<Record<string, ChatTaskCardView>>({})
  const [taskCardsLoading, setTaskCardsLoading] = useState(false)
  const [privacyContext, setPrivacyContext] = useState<ChatPrivacyMarkerContext | null>(null)
  const [runAnalysisEntry, setRunAnalysisEntry] = useState<RunAnalysisEntry | null>(null)
  const [pending, startTransition] = useTransition()
  const [ticketPending, startTicketTransition] = useTransition()
  const [archivePending, startArchiveTransition] = useTransition()
  const [distillPending, startDistillTransition] = useTransition()
  const [debugLogPending, startDebugLogTransition] = useTransition()
  const [distillTargetSkillId, setDistillTargetSkillId] = useState<string>('')
  const [distillTargets, setDistillTargets] = useState<Array<{ id: string; name: string }>>([])
  const [agentSkills, setAgentSkills] = useState<ChatSkillOption[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const filesRef = useRef<ConversationFilesPanelHandle>(null)
  const streamAbortRef = useRef<AbortController | null>(null)
  const streamConversationIdRef = useRef<string | null>(null)
  const activeTurnIdRef = useRef<string | null>(null)
  /**
   * Ha a user a futó forduló közben nyomja a „Jóváhagyom”-ot, a tool a szerveren
   * már lefut, de a folytatás-forduló nem indítható (`isAgentTyping`). Ilyenkor
   * ide kerülnek az approval-id-k; a gépelés végeztével automatikusan elindul
   * a folytatás (különben a gomb eltűnik, Excel/munkafájl soha nem készül el).
   */
  const pendingConsequenceContinuationRef = useRef<string[] | null>(null)
  /** Új beszélgetés gomb: ne töltsük vissza azonnal a legutóbbi szálat. */
  const [userStartedNew, setUserStartedNew] = useState(false)
  /** In-flight szálbetöltés — Új beszélgetés közben a válasz ne írja vissza a régi szálat. */
  const sessionLoadGenRef = useRef(0)
  /** Ugyanarra a szálra ne induljon második párhuzamos loadAgentChatMessages. */
  const inFlightSessionRef = useRef<string | null>(null)
  const grantResumeStartedRef = useRef(false)
  const prefillAppliedRef = useRef(false)
  const startAgentTurnRef = useRef<
    | ((options: {
        text: string
        attachments: PendingAttachment[]
        userBubbleText?: string
        consequenceApprovalIds?: string[]
        connectorGrantContinuation?: boolean
      }) => void)
    | null
  >(null)
  const [mounted, setMounted] = useState(false)
  const [minimized, setMinimized] = useState(false)
  const handleMinimize = useCallback(() => setMinimized(true), [])
  const handleOauthRedirect = useCallback(() => {
    persistAgentChatForOAuth({
      agent,
      canDistillSkill,
      initialConversationId: conversationId,
    })
    handleMinimize()
  }, [agent, canDistillSkill, conversationId, handleMinimize])
  const [connectableUserConnectors, setConnectableUserConnectors] = useState<
    AgentDelegatedConnectorRow[]
  >([])
  const [connectableUserConnectorsLoading, setConnectableUserConnectorsLoading] = useState(false)
  const [thinkingTraceControls, setThinkingTraceControls] =
    useState<ThinkingTraceControlState>('loading')

  useEffect(() => {
    activeTurnIdRef.current = activeTurnId
  }, [activeTurnId])

  useEffect(() => {
    // Bezáráskor a következő nyitás ne tálcán induljon.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!open) setMinimized(false)
  }, [open])

  useEffect(() => {
    if (restoreSignal <= 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMinimized(false)
  }, [restoreSignal])

  useEffect(() => {
    if (!open || !minimized) {
      removeAgentChatDockEntry(dockId)
      return
    }
    upsertAgentChatDockEntry({
      id: dockId,
      agentName: agent.name,
      agentStatus: agent.status,
      avatarUrl: agent.avatarUrl,
      personaNickname: agent.personaNickname,
      displayName: persona.nickname,
      isTyping: isAgentTyping,
      onRestore: () => setMinimized(false),
      onClose,
    })
  }, [
    open,
    minimized,
    dockId,
    agent.name,
    agent.status,
    agent.avatarUrl,
    agent.personaNickname,
    persona.nickname,
    isAgentTyping,
    onClose,
  ])

  useEffect(() => {
    return () => removeAgentChatDockEntry(dockId)
  }, [dockId])

  const markConversationRunning = useCallback((convId: string | null, running: boolean) => {
    if (!convId) return
    setRunningConversationIds((prev) => {
      if (running) return prev.includes(convId) ? prev : [...prev, convId]
      return prev.filter((id) => id !== convId)
    })
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => setMounted(true), 0)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!open) streamAbortRef.current?.abort()
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      setConnectableUserConnectorsLoading(true)
      try {
        const res = await listAgentDelegatedConnectors(agent.id)
        if (cancelled) return
        setConnectableUserConnectors(res.success ? res.data : [])
      } finally {
        if (!cancelled) setConnectableUserConnectorsLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [open, agent.id])

  useEffect(() => {
    let cancelled = false
    void getTenantThinkingTraceControls().then((res) => {
      if (cancelled) return
      setThinkingTraceControls(res.success && res.data.enabled === true ? 'enabled' : 'disabled')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    })
  }, [])

  const refreshSessions = useCallback(async () => {
    setSessionsLoading(true)
    try {
      const res = await listAgentChatSessions({
        agentId: agent.id,
        status: sessionsFilter,
        limit: CHAT_SESSIONS_PAGE_SIZE,
        offset: 0,
      })
      if (res.success) {
        setSessions(res.data.sessions)
        setSessionsHasMore(res.data.hasMore)
        setSessionsNextOffset(res.data.nextOffset)
      }
    } finally {
      setSessionsLoading(false)
    }
  }, [agent.id, sessionsFilter])

  const loadMoreSessions = useCallback(async () => {
    if (sessionsLoading || sessionsLoadingMore || !sessionsHasMore) return
    setSessionsLoadingMore(true)
    try {
      const res = await listAgentChatSessions({
        agentId: agent.id,
        status: sessionsFilter,
        limit: CHAT_SESSIONS_PAGE_SIZE,
        offset: sessionsNextOffset,
      })
      if (res.success) {
        setSessions((prev) => {
          const merged = [...prev]
          for (const session of res.data.sessions) {
            if (!merged.some((existing) => existing.id === session.id)) merged.push(session)
          }
          return merged
        })
        setSessionsHasMore(res.data.hasMore)
        setSessionsNextOffset(res.data.nextOffset)
      }
    } finally {
      setSessionsLoadingMore(false)
    }
  }, [agent.id, sessionsFilter, sessionsHasMore, sessionsLoading, sessionsLoadingMore, sessionsNextOffset])

  useEffect(() => {
    if (!open || !sessionsOpen) return
    const timer = window.setTimeout(() => void refreshSessions(), 0)
    return () => window.clearTimeout(timer)
  }, [open, sessionsOpen, refreshSessions])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (initialConversationId || initialPrefill?.trim()) {
        setLatestConversationId(null)
        return
      }
      setLatestConversationId(undefined)
      void findLatestAgentChatSession({ agentId: agent.id }).then((res) => {
        if (cancelled) return
        setLatestConversationId(res.success ? (res.data.session?.id ?? null) : null)
      })
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, agent.id, initialConversationId, initialPrefill])

  useEffect(() => {
    if (!open) return
    void (async () => {
      const res = await listChatTriggerableProcessDefinitions({ agentId: agent.id })
      if (res.success) setChatProcessDefs(res.data as ChatProcessDefinition[])
    })()
  }, [open, agent.id])

  const startNewSession = useCallback((opts?: { force?: boolean }) => {
    if (isAgentTyping && !opts?.force) return
    setUserStartedNew(true)
    sessionLoadGenRef.current += 1
    inFlightSessionRef.current = null
    setHistoryLoadState('ready')
    pendingConsequenceContinuationRef.current = null
    setConversationId(null)
    setMessages([])
    setStatusMessage(null)
    setLastTicketId(null)
    setContinuedFromTicket(null)
    setTicketDiscussionHistory([])
    setConversationStatus('active')
    setSessionsFilter('active')
    setSessionsOpen(false)
    setSelectedProcessDefId(null)
  }, [isAgentTyping])

  useEffect(() => {
    if (open) {
      setTimeout(() => textareaRef.current?.focus(), 100)
    }
  }, [open])

  useEffect(() => {
    scrollToBottom()
  }, [messages, isAgentTyping, scrollToBottom])

  useEffect(() => {
    return () => {
      pendingAttachments.forEach((a) => {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
      })
    }
  }, [pendingAttachments])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape' || !open || minimized || embedded) return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [embedded, minimized, onClose, open])

  const resetComposer = () => {
    setInput('')
    setTicketSchedule(EMPTY_TASK_SCHEDULE)
    setTicketAuthorizeRunAs(false)
    pendingAttachments.forEach((a) => {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
    })
    setPendingAttachments([])
  }

  const handleFilesSelected = (files: FileList | null) => {
    if (!files?.length) return
    const next = Array.from(files).map(makePendingAttachment)
    setPendingAttachments((prev) => [...prev, ...next])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeAttachment = (id: string) => {
    setPendingAttachments((prev) => {
      const target = prev.find((a) => a.id === id)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((a) => a.id !== id)
    })
  }

  const turnBlocksComposer = isAgentTyping && !activeTurnStalled
  const controlsBusy =
    pending || ticketPending || archivePending || distillPending || debugLogPending || turnBlocksComposer

  useEffect(() => {
    if (!open) return
    let cancelled = false
    getAgentSkillsAction(agent.id).then((res) => {
      if (cancelled || !res.success) return
      const enabledBySkill = new Map<string, ChatSkillOption>()
      const distillBySkill = new Map<string, { id: string; name: string }>()
      for (const row of res.data) {
        if (!distillBySkill.has(row.skillId)) {
          distillBySkill.set(row.skillId, { id: row.skillId, name: row.name })
        }
        if (row.enabled && !enabledBySkill.has(row.skillId)) {
          enabledBySkill.set(row.skillId, {
            skillId: row.skillId,
            skillVersionId: row.skillVersionId,
            name: row.name,
            description: row.description,
            allowAttachments: row.allowAttachments,
          })
        }
      }
      setAgentSkills([...enabledBySkill.values()])
      if (canDistillSkill) {
        setDistillTargets([...distillBySkill.values()])
      }
    })
    return () => {
      cancelled = true
    }
  }, [agent.id, canDistillSkill, open])

  // #199/D6 — chatben a csatolmány-tiltás CSAK figyelmeztetés: a küldést nem
  // törjük meg. A kemény kapu ott van, ahol a skillt explicit kiválasztják
  // (korlátozott feladat + normál board-feladat); a chat szabad beszélgetés,
  // ahol a felhasználó a csatolmányt más célra is szánhatja.
  const attachmentWarningSkills = useMemo(() => {
    if (pendingAttachments.length === 0) return []
    const tokens = new Set<string>()
    for (const match of input.matchAll(/(?:^|\s)\/([a-zA-Z0-9_-]+)/g)) {
      tokens.add(match[1].toLowerCase())
    }
    if (tokens.size === 0) return []
    return agentSkills
      .filter((skill) => !skill.allowAttachments && tokens.has(skillNameToSlashToken(skill.name)))
      .map((skill) => skill.name)
  }, [agentSkills, input, pendingAttachments.length])

  const composerDisabled = controlsBusy || conversationStatus === 'archived'
  // A `/` menü viselkedése közös a Playbook-szerző prompttal (`skill-slash-autocomplete`),
  // hogy a két felület ne tudjon szétcsúszni.
  const slash = useSkillSlashAutocomplete({
    skills: agentSkills,
    value: input,
    onChange: setInput,
    inputRef: textareaRef,
    disabled: composerDisabled,
  })

  /**
   * Módváltáskor a feladat-specifikus beállítások nem maradhatnak élve
   * láthatatlanul: a rejtett ütemezés a küldés jelentését változtatná meg.
   */
  const switchComposerMode = useCallback((next: AgentChatComposerMode) => {
    setComposerMode(next)
    if (next !== 'task') {
      setTicketSchedule(EMPTY_TASK_SCHEDULE)
      setTicketAuthorizeRunAs(false)
    }
    if (next !== 'process') {
      setSelectedProcessDefId(null)
    }
  }, [])

  const selectedProcessDef = useMemo(
    () => chatProcessDefs.find((def) => def.id === selectedProcessDefId) ?? null,
    [chatProcessDefs, selectedProcessDefId],
  )

  const processMissingFileAttachment = useMemo(() => {
    if (composerMode !== 'process' || !selectedProcessDef) return false
    if (pendingAttachments.length > 0) return false
    return processRequiresFileAttachment(selectedProcessDef.slots)
  }, [composerMode, pendingAttachments.length, selectedProcessDef])

  const hasComposerContent =
    input.trim().length > 0 ||
    pendingAttachments.length > 0 ||
    (composerMode === 'process' &&
      selectedProcessDef !== null &&
      selectedProcessDef.slots.filter((slot) => slot.required).length === 0)

  const canSubmit =
    conversationStatus !== 'archived' &&
    hasComposerContent &&
    !pending &&
    !ticketPending &&
    !isAgentTyping &&
    canStartThinkingTraceStream(thinkingTraceControls) &&
    (composerMode !== 'process' || (selectedProcessDefId !== null && !processMissingFileAttachment))

  const handleDeleteMessageContent = useCallback(
    (messageId: string) => {
      if (controlsBusy) return
      void (async () => {
        const confirmed = await confirmDialog({
          title: 'Üzenettartalom törlése',
          description: 'Törlöd az üzenet tartalmát? A szálban csak a csontváz marad.',
          confirmLabel: 'Törlés',
          tone: 'danger',
        })
        if (!confirmed) return

        startTransition(async () => {
          const res = await deleteMessageContent({ messageId })
          if (!res.success) {
            setStatusMessage(res.error)
            return
          }
          const deletedAt = new Date().toISOString()
          setMessages((prev) =>
            prev.map((message) =>
              message.id === messageId
                ? { ...message, text: '', attachments: [], contentDeletedAt: deletedAt }
                : message,
            ),
          )
          setStatusMessage('Üzenettartalom törölve.')
          await refreshSessions()
        })
      })()
    },
    [controlsBusy, refreshSessions],
  )

  const handleMemoryCandidateUpdate = useCallback(
    (messageId: string, candidateId: string, patch: Partial<MemoryCandidateCard>) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                memoryCandidates: m.memoryCandidates?.map((c) =>
                  c.candidateId === candidateId ? { ...c, ...patch } : c,
                ),
              }
            : m,
        ),
      )
    },
    [],
  )

  const handleConsequenceApprovalUpdate = useCallback(
    (messageId: string, approvalId: string, patch: Partial<ConsequenceApprovalCard>) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                consequenceApprovals: m.consequenceApprovals?.map((a) =>
                  a.approvalId === approvalId ? { ...a, ...patch } : a,
                ),
              }
            : m,
        ),
      )
    },
    [],
  )

  const handlePromoteConversation = useCallback(() => {
    if (!conversationId || controlsBusy) return
    startTicketTransition(async () => {
      setStatusMessage(null)
      setLastTicketId(null)
      const res = await promoteConversationWithAi({ conversationId })
      if (!res.success) {
        setStatusMessage(res.error)
        return
      }
      const refreshed = await loadAgentChatMessages({ conversationId, agentId: agent.id })
      if (refreshed.success) {
        setConversationStatus(refreshed.data.conversation.status)
        setContinuedFromTicket(refreshed.data.continuedFromTicket ?? null)
        setTicketDiscussionHistory(refreshed.data.ticketDiscussionHistory ?? [])
        setIsAdmin(refreshed.data.isAdmin)
        setMessages(
          withPendingChatExtras(
            refreshed.data.messages.map((m) => ({
              ...m,
              createdAt: new Date(m.createdAt).toISOString(),
            })),
            refreshed.data.pendingConsequenceApprovals?.map((a) => ({
              ...a,
              status: 'pending' as const,
            })),
            refreshed.data.pendingConnectorGrants,
          ),
        )
      }
      if ('ticketId' in res.data) {
        setLastTicketId(res.data.ticketId)
        setStatusMessage('A feladat elkészült és belinkeltem a beszélgetésbe.')
      } else {
        setStatusMessage('Az AI visszakérdezett a feladat létrehozása előtt.')
      }
      await refreshSessions()
    })
  }, [agent.id, conversationId, controlsBusy, refreshSessions])

  const handleArchiveConversation = useCallback(() => {
    if (!conversationId || controlsBusy || conversationStatus === 'archived') return
    void (async () => {
      const confirmed = await confirmDialog({
        title: 'Beszélgetés archiválása',
        description: 'Archiválod ezt a beszélgetést? Ezután csak olvasható lesz.',
        confirmLabel: 'Archiválás',
        tone: 'danger',
      })
      if (!confirmed) return
      startArchiveTransition(async () => {
        setStatusMessage(null)
        const res = await archiveConversation({ conversationId })
        if (!res.success) {
          setStatusMessage(res.error)
          return
        }
        setConversationStatus('archived')
        setStatusMessage('Beszélgetés archiválva.')
        await refreshSessions()
      })
    })()
  }, [controlsBusy, conversationId, conversationStatus, refreshSessions])

  const handleDistillSkill = useCallback(() => {
    if (!conversationId || controlsBusy || !canDistillSkill) return
    if (messages.length === 0) {
      setStatusMessage('Nincs desztillálható üzenet ebben a beszélgetésben.')
      return
    }
    startDistillTransition(async () => {
      setStatusMessage(null)
      const res = await distillSkillFromConversationAction({
        conversationId,
        agentId: agent.id,
        ...(distillTargetSkillId ? { targetSkillId: distillTargetSkillId } : {}),
      })
      if (!res.success) {
        setStatusMessage(res.error)
        return
      }
      const reqHint =
        res.data.requires.length > 0
          ? ` Javasolt eszközök: ${res.data.requires.map((r) => r.toolName).join(', ')}.`
          : ''
      const versionHint = res.data.created ? 'Új skill draft' : 'Új verzió javaslat'
      setStatusMessage(
        `${versionHint} (${res.data.riskTier}): „${res.data.name}".${reqHint} Jóváhagyás: Skill katalógus.`,
      )
    })
  }, [agent.id, canDistillSkill, conversationId, controlsBusy, distillTargetSkillId, messages.length])

  const handleExportDebugLog = useCallback(() => {
    if (!conversationId || controlsBusy || !canDistillSkill) return
    startDebugLogTransition(async () => {
      setStatusMessage(null)
      const res = await exportConversationDebugLog({ conversationId })
      if (!res.success) {
        setStatusMessage(res.error)
        return
      }
      const blob = new Blob([res.data.content], { type: res.data.mediaType })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = res.data.filename
      a.click()
      URL.revokeObjectURL(url)
      setStatusMessage(`Debug-log letöltve: ${res.data.filename}`)
    })
  }, [canDistillSkill, controlsBusy, conversationId])

  const handleAnalyzeConversation = useCallback(() => {
    if (!conversationId || !runAnalysisEntry?.canRunAnalysis || !runAnalysisEntry.runAnalystAgentId) {
      return
    }
    const sessionTitle = sessions.find((session) => session.id === conversationId)?.title
    router.push(
      buildRunAnalysisHref(runAnalysisEntry.runAnalystAgentId, {
        kind: 'conversation',
        conversationId,
        title: sessionTitle,
      }),
    )
  }, [conversationId, runAnalysisEntry, router, sessions])

  const toggleWorkspaceHistory = useCallback(() => setSessionsOpen((open) => !open), [])
  useAgentWorkspaceChatChrome({
    embedded,
    open,
    agent,
    canDistillSkill,
    conversationId,
    startNewChat: startNewSession,
    toggleHistory: toggleWorkspaceHistory,
    analyze: handleAnalyzeConversation,
    analyzeDisabled: controlsBusy,
  })

  const reloadConversationMessages = useCallback(
    async (convId: string) => {
      const res = await loadAgentChatMessages({ conversationId: convId, agentId: agent.id })
      if (!res.success) {
        setStatusMessage(res.error)
        return false
      }
      const privacyRes = await getChatPrivacyMarkerContext({
        agentId: agent.id,
        conversationId: convId,
      })
      if (privacyRes.success) {
        setPrivacyContext(privacyRes.data)
      }
      setConversationId(convId)
      setConversationStatus(res.data.conversation.status)
      setContinuedFromTicket(res.data.continuedFromTicket ?? null)
      setTicketDiscussionHistory(res.data.ticketDiscussionHistory ?? [])
      setIsAdmin(res.data.isAdmin)
      setMessages(
        withPendingChatExtras(
          res.data.messages.map((m) => ({
            ...m,
            createdAt: new Date(m.createdAt).toISOString(),
          })),
          res.data.pendingConsequenceApprovals?.map((a) => ({ ...a, status: 'pending' as const })),
          res.data.pendingConnectorGrants,
        ),
      )
      if (sessionsOpen) {
        startTransition(() => {
          void refreshSessions()
        })
      }
      return true
    },
    [agent.id, refreshSessions, sessionsOpen],
  )

  const consumeReattachStream = useCallback(
    async (params: {
      turnId: string
      conversationId: string
      agentMessageId: string
      signal: AbortSignal
    }) => {
      const response = await fetch(`/api/v1/agent-chat/turns/${params.turnId}/stream`, {
        signal: params.signal,
      })
      if (!response.ok || !response.body) {
        setStatusMessage(`Visszacsatlakozás sikertelen (${response.status})`)
        setIsAgentTyping(false)
        setStopPending(false)
        setActiveTurnId(null)
        markConversationRunning(params.conversationId, false)
        // A forduló közben / után is perzisztálódhatott a válasz — üres buborék
        // helyett a DB végállapotot töltjük.
        await reloadConversationMessages(params.conversationId)
        return
      }

      let accumulatedReply = ''
      let sawTerminalEvent = false

      try {
        for await (const event of readAgentChatEventStream(response.body)) {
            if (event.type === 'snapshot') {
              const activities = Array.isArray(event.activities)
                ? (event.activities as AgentActivity[])
                : []
              accumulatedReply = event.partialText ?? ''
              setActiveTurnId(event.turnId)
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === params.agentMessageId
                      ? {
                          ...m,
                          text: accumulatedReply,
                          activities,
                        }
                      : m,
                  ),
                )
              })
            } else if (event.type === 'activity') {
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === params.agentMessageId
                      ? { ...m, activities: upsertActivity(m.activities, event.activity) }
                      : m,
                  ),
                )
              })
            } else if (event.type === 'consequence_approval' && event.approval) {
              // issue #97 — a visszacsatlakozó ág is megkapja a kaput: lecsatlakozás
              // után is legyen gomb, ne csak a folyamatosan nézett fordulóban.
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === params.agentMessageId
                      ? {
                          ...m,
                          consequenceApprovals: upsertConsequenceApproval(m.consequenceApprovals, {
                            ...event.approval,
                            status: 'pending',
                          }),
                        }
                      : m,
                  ),
                )
              })
            } else if (event.type === 'connector_grant_needed' && event.grant) {
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === params.agentMessageId
                      ? {
                          ...m,
                          connectorGrants: upsertConnectorGrant(
                            m.connectorGrants,
                            connectorGrantCardFromLoopEvent(event.grant),
                          ),
                        }
                      : m,
                  ),
                )
              })
            } else if (
              event.type === 'thinking' &&
              typeof event.delta === 'string' &&
              thinkingTraceControls === 'enabled'
            ) {
              const { turnId, delta } = event
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === params.agentMessageId
                      ? {
                          ...m,
                          thinking: appendThinkingDelta(
                            m.thinking,
                            { turnId, delta },
                            thinkingTraceControls,
                          ),
                        }
                      : m,
                  ),
                )
              })
            } else if (event.type === 'token') {
              accumulatedReply += event.chunk
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === params.agentMessageId ? { ...m, text: accumulatedReply } : m,
                  ),
                )
              })
            } else if (
              event.type === 'done' &&
              event.reason === 'cancelled' &&
              event.conversationId &&
              event.messageId
            ) {
              sawTerminalEvent = true
              await reloadConversationMessages(event.conversationId)
              return
            } else if (event.type === 'done' && event.conversationId && event.messageId) {
              sawTerminalEvent = true
              await reloadConversationMessages(event.conversationId)
              return
            } else if (event.type === 'error') {
              sawTerminalEvent = true
              setStatusMessage(event.message ?? 'A válasz hibával zárult.')
              await reloadConversationMessages(params.conversationId)
              return
            }
        }

        // Stream lezárult done/error nélkül (proxy timeout, élő busz elszakadás).
        // Ha a válasz közben elkészült, a DB-ből kell visszatölteni — különben
        // üres agent-buborék marad a UI-on.
        if (!sawTerminalEvent && !params.signal.aborted) {
          await reloadConversationMessages(params.conversationId)
        }
      } finally {
        setIsAgentTyping(false)
        setStopPending(false)
        setActiveTurnId(null)
        markConversationRunning(params.conversationId, false)
      }
    },
    [markConversationRunning, reloadConversationMessages, thinkingTraceControls],
  )

  const reattachToConversation = useCallback(
    async (convId: string) => {
      try {
        const res = await fetch(
          `/api/v1/agent-chat/turns?conversationId=${encodeURIComponent(convId)}&active=1`,
        )
        if (!res.ok) return false
        const data = (await res.json()) as {
          active: boolean
          turn: {
            id: string
            status?: string
            partialText: string
            activities: unknown
            userMessageId: string | null
            heartbeatAt?: string
            startedAt?: string
            cancelRequested?: boolean
          } | null
        }
        if (!data.active || !data.turn) return false

        const stalled = updateActiveTurnLiveness(data.turn)

        const agentMessageId = agentBubbleIdForTurn(data.turn.id)
        const activities = Array.isArray(data.turn.activities)
          ? (data.turn.activities as AgentActivity[])
          : []

        setActiveTurnId(data.turn.id)
        setStopPending(false)
        if (stalled) {
          setIsAgentTyping(false)
          markConversationRunning(convId, false)
        } else {
          streamAbortRef.current?.abort()
          const abortController = new AbortController()
          streamAbortRef.current = abortController
          streamConversationIdRef.current = convId
          setIsAgentTyping(true)
          markConversationRunning(convId, true)
          setMessages((prev) => {
            const withoutOptimistic = prev.filter((m) => m.id !== agentMessageId)
            const last = withoutOptimistic[withoutOptimistic.length - 1]
            if (last?.role === 'agent' && !last.text.trim() && !chatMessageShowsAgentActivity(last)) {
              return withoutOptimistic.map((m, i) =>
                i === withoutOptimistic.length - 1
                  ? {
                      ...m,
                      id: agentMessageId,
                      text: data.turn!.partialText ?? '',
                      activities,
                    }
                  : m,
              )
            }
            return [
              ...withoutOptimistic,
              {
                id: agentMessageId,
                role: 'agent' as const,
                text: data.turn!.partialText ?? '',
                attachments: [],
                createdAt: new Date().toISOString(),
                activities,
              },
            ]
          })
          void consumeReattachStream({
            turnId: data.turn.id,
            conversationId: convId,
            agentMessageId,
            signal: abortController.signal,
          })
          return true
        }
        setMessages((prev) => {
          const withoutOptimistic = prev.filter((m) => m.id !== agentMessageId)
          const last = withoutOptimistic[withoutOptimistic.length - 1]
          if (last?.role === 'agent' && !last.text.trim() && !chatMessageShowsAgentActivity(last)) {
            return withoutOptimistic.map((m, i) =>
              i === withoutOptimistic.length - 1
                ? {
                    ...m,
                    id: agentMessageId,
                    text: data.turn!.partialText ?? '',
                    activities,
                  }
                : m,
            )
          }
          return [
            ...withoutOptimistic,
            {
              id: agentMessageId,
              role: 'agent' as const,
              text: data.turn!.partialText ?? '',
              attachments: [],
              createdAt: new Date().toISOString(),
              activities,
            },
          ]
        })
        return true
      } catch {
        return false
      }
    },
    [consumeReattachStream, markConversationRunning, updateActiveTurnLiveness],
  )

  const selectSession = useCallback(
    async (id: string) => {
      if (
        shouldSkipDuplicateSessionSelect({
          requestedId: id,
          currentConversationId: conversationId,
          inFlightId: inFlightSessionRef.current,
        })
      ) {
        setSessionsOpen(false)
        return
      }

      // Más beszélgetésre váltáskor a helyi stream-olvasást megszakítjuk (a szerver fut tovább).
      // A sorban álló folytatást ELŐBB eldobjuk — különben a setIsAgentTyping(false)
      // flushelná a régi approval-id-kat az új beszélgetésre.
      streamAbortRef.current?.abort()
      pendingConsequenceContinuationRef.current = null
      clearActiveTurnState()
      setStopPending(false)

      sessionLoadGenRef.current += 1
      const loadGen = sessionLoadGenRef.current
      inFlightSessionRef.current = id
      setHistoryLoadState('loading')
      setUserStartedNew(false)
      setConversationId(id)
      setStatusMessage(null)
      setLastTicketId(null)
      setContinuedFromTicket(null)
      setTicketDiscussionHistory([])
      setSessionsOpen(false)
      setSelectedProcessDefId(null)
      setConversationStatus(sessions.find((session) => session.id === id)?.status ?? 'active')

      try {
        const res = await loadAgentChatMessages({ conversationId: id, agentId: agent.id })
        if (loadGen !== sessionLoadGenRef.current) return
        if (res.success) {
          setConversationStatus(res.data.conversation.status)
          setContinuedFromTicket(res.data.continuedFromTicket ?? null)
          setTicketDiscussionHistory(res.data.ticketDiscussionHistory ?? [])
          setIsAdmin(res.data.isAdmin)
          setMessages(
            withPendingChatExtras(
              res.data.messages.map((m) => ({
                ...m,
                createdAt: new Date(m.createdAt).toISOString(),
              })),
              res.data.pendingConsequenceApprovals?.map((a) => ({ ...a, status: 'pending' as const })),
              res.data.pendingConnectorGrants,
            ),
          )
          void reattachToConversation(id)
        } else {
          setStatusMessage(res.error)
        }
      } finally {
        if (loadGen === sessionLoadGenRef.current) {
          inFlightSessionRef.current = null
          setHistoryLoadState('ready')
        }
      }
    },
    [agent.id, clearActiveTurnState, conversationId, reattachToConversation, sessions],
  )

  const selectSessionRef = useRef(selectSession)
  useEffect(() => {
    selectSessionRef.current = selectSession
  })

  // Beszélgetés gomb / munkaterület: a legutóbbi aktív szálat folytatjuk, nem üres újat.
  useEffect(() => {
    if (!open) return
    const resumeId = conversationIdToResume({
      open,
      initialConversationId,
      currentConversationId: conversationId,
      userStartedNew,
      latestConversationId,
      initialPrefill,
    })
    if (!resumeId) return
    // Szándékos: a legutóbbi szál id-ja után aszinkron folytatjuk. A session-lista
    // (előzmények sáv) nem kell ehhez, és a selectSession identitás se indítson új loadot.
    void selectSessionRef.current(resumeId)
  }, [
    open,
    initialConversationId,
    conversationId,
    userStartedNew,
    latestConversationId,
    initialPrefill,
  ])

  useEffect(() => {
    // Agentváltáskor a következő nyitás megint a legutóbbi szálat hozza, ne az üres újat.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUserStartedNew(false)
  }, [agent.id])

  // Deep-link: panel nyitáskor betölti az initialConversationId-t és reattach-el.
  useEffect(() => {
    if (!open || !initialConversationId) return
    // Szándékos: nyitáskor aszinkron beszélgetés-betöltést indítunk (a setState a fetch UTÁN
    // fut, nem szinkron az effekt törzsében) — a deep-link-nyitás nem fejezhető ki render alatt.
    void selectSession(initialConversationId)
    // Csak nyitáskor / initialConversationId változáskor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialConversationId])

  useEffect(() => {
    if (!open) return
    void getChatPrivacyMarkerContext({
      agentId: agent.id,
      conversationId,
    }).then((res) => {
      if (res.success) setPrivacyContext(res.data)
    })
  }, [open, agent.id, conversationId])

  useEffect(() => {
    if (!open) return
    void getRunAnalysisEntry().then((res) => {
      if (res.success) setRunAnalysisEntry(res.data)
    })
  }, [open])

  // RA-08: deep-link prefill — szerkeszthető szöveg a composerben, nem auto-send.
  useEffect(() => {
    if (resumeAfterGrant) grantResumeStartedRef.current = false
    if (initialPrefill) prefillAppliedRef.current = false
  }, [resumeAfterGrant, initialPrefill, restoreSignal])

  useEffect(() => {
    if (!open || !initialPrefill?.trim()) return
    if (prefillAppliedRef.current) return
    if (initialConversationId && conversationId !== initialConversationId) return
    const timer = window.setTimeout(() => {
      prefillAppliedRef.current = true
      startNewSession({ force: true })
      setInput(initialPrefill)
      stripPrefillQueryFromUrl()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [open, initialPrefill, initialConversationId, conversationId, startNewSession])

  // A Stop a FUTÓ FORDULÓ azonosítójára hivatkozik (#65). Amíg nincs turnId — a
  // `turn` esemény a stream legelső eseménye —, nincs mit megállítani.
  const handleStop = () => {
    const turnId = activeTurnIdRef.current
    if (!turnId || stopPending) return
    setStopPending(true)
    setStatusMessage(null)
    void (async () => {
      try {
        const response = await fetch(`/api/v1/agent-chat/turns/${turnId}/cancel`, {
          method: 'POST',
        })
        if (response.status === 200) {
          // Már lezárult, mire a Stop odaért — nem hiba, csak nincs mit megállítani.
          setStopPending(false)
          setStatusMessage('A válasz már befejeződött.')
          return
        }
        if (!response.ok) {
          setStopPending(false)
          setStatusMessage(
            response.status === 404
              ? 'Nincs futó válasz — lehet, hogy már befejeződött.'
              : 'Megállítás sikertelen.',
          )
        }
      } catch {
        setStopPending(false)
        setStatusMessage('Megállítás sikertelen.')
      }
    })()
  }

  /**
   * Egy agent-forduló elindítása és a SSE-stream feldolgozása.
   *
   * A szerkesztőmezőből küldött üzenet és a jóváhagyás utáni folytatás ugyanaz a
   * folyamat: mindkettőnek buborék, „gépel" jelző, aktivitás-lista és lezáráskor
   * DB-újratöltés jár. (A folytatásnál a forduló SZÖVEGÉT a szerver adja — a
   * kliens csak a jóváhagyás-azonosítókat küldi.)
   */
  const startAgentTurn = (options: {
    text: string
    attachments: PendingAttachment[]
    /** Amit a felhasználó a saját buborékában lát, amíg a DB-végállapot meg nem érkezik. */
    userBubbleText?: string
    consequenceApprovalIds?: string[]
    connectorGrantContinuation?: boolean
  }) => {
    const text = options.text
    const localAttachments = options.attachments
    const optimisticUserId = `optimistic-user-${Date.now()}`
    let agentBubbleMessageId = `optimistic-agent-pending-${Date.now()}`

    const optimisticUserMessage: ChatMessage = {
      id: optimisticUserId,
      role: 'user',
      text: options.userBubbleText ?? (text || '(csatolmányok)'),
      attachments: localAttachments.map((a) => ({
        documentId: a.id,
        filename: a.file.name,
        kind: a.kind,
        previewDataUrl: a.previewUrl,
      })),
      createdAt: new Date().toISOString(),
    }

    const optimisticAgentMessage: ChatMessage = {
      id: agentBubbleMessageId,
      role: 'agent',
      text: '',
      attachments: [],
      createdAt: new Date().toISOString(),
      activities: [],
    }

    setMessages((prev) => [...prev, optimisticUserMessage, optimisticAgentMessage])
    setStatusMessage(null)
    setLastTicketId(null)
    resetActiveTurnLiveness()
    setIsAgentTyping(true)
    streamConversationIdRef.current = conversationId
    if (conversationId) markConversationRunning(conversationId, true)

    let accumulatedReply = ''

    const abortController = new AbortController()
    streamAbortRef.current = abortController

    void (async () => {
      let persistedUserMessageId: string | null = null
      // Ha a megszakadt olvasás után visszacsatlakozunk a futó fordulóra, a
      // háttér-stream (consumeReattachStream) veszi át a buborék és a
      // „gépel" jelző életciklusát — a lezáró `finally` ilyenkor nem nullázhat.
      let handedOffToReattach = false

      function removeFailedOptimisticMessages() {
        setMessages((prev) =>
          prev.filter(
            (message) =>
              message.id !== agentBubbleMessageId &&
              (persistedUserMessageId !== null || message.id !== optimisticUserId),
          ),
        )
      }

      /**
       * A forduló idő előtt megszakadt olvasásának EGYETLEN kezelője — mindegy,
       * hogy a stream lezáró esemény nélkül ért véget, vagy a `reader.read()`
       * dobott (elvágott válasz-törzs mobilhálón / proxy timeoutnál). A döntést
       * a tiszta {@link decideChatStreamRecovery} hozza, itt csak végrehajtjuk.
       */
      async function recoverInterruptedStream(ending: ChatStreamEnding) {
        const action = decideChatStreamRecovery({
          ending,
          userMessagePersisted: persistedUserMessageId !== null,
          conversationId: streamConversationIdRef.current ?? conversationId,
        })
        if (action.kind === 'none') return
        if (action.kind === 'discard') {
          // A szerver még vissza sem igazolta a user-üzenetet: nincs mit
          // visszaszerezni, a félkész buborékokat takarítjuk.
          removeFailedOptimisticMessages()
          setStatusMessage(action.message)
          return
        }
        try {
          const attached = await reattachToConversation(action.conversationId)
          if (attached) {
            handedOffToReattach = true
            return
          }
          await reloadConversationMessages(action.conversationId)
          setStatusMessage(STREAM_RECOVERED_MESSAGE)
        } catch {
          // A visszaszerzés maga is elbukhat (tartós hálózatkiesés). Ilyenkor is
          // az a fontos üzenet, hogy a munka nem veszett el.
          setStatusMessage(STREAM_RECOVERY_FAILED_MESSAGE)
        }
      }

      try {
        const documentIds = localAttachments.length > 0 ? await uploadAttachments(localAttachments) : []
        if (abortController.signal.aborted) return

        const response = await fetch('/api/v1/agent-chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abortController.signal,
          body: JSON.stringify({
            agentId: agent.id,
            content: text,
            conversationId: conversationId ?? undefined,
            attachmentDocumentIds: documentIds,
            processDefinitionId:
              composerMode === 'process' ? (selectedProcessDefId ?? undefined) : undefined,
            ...(options.consequenceApprovalIds?.length
              ? { consequenceApprovalIds: options.consequenceApprovalIds }
              : {}),
            ...(options.connectorGrantContinuation ? { connectorGrantContinuation: true } : {}),
          }),
        })

        // Aktív-forduló ütközés (D7) VAGY taskOnly tiltás (#199): mindkettő 409.
        // A fajtákat nem szabad összekeverni — a taskOnly eddig „már készül a
        // válasz”-ként jelent meg, eltüntette a kérdést, és beragadt a „most dolgozik".
        if (response.status === 409) {
          removeFailedOptimisticMessages()
          markConversationRunning(conversationId, false)
          let conflictBody: {
            error?: string
            message?: string
            activeTurnId?: string | null
            conversationId?: string
          } = {}
          try {
            conflictBody = (await response.json()) as typeof conflictBody
          } catch {
            // ignore
          }
          const conflict = resolveChatStreamConflict(conflictBody, conversationId)
          if (conflict.kind === 'active_turn') {
            if (conflict.conversationId) {
              setConversationId(conflict.conversationId)
              const attached = await reattachToConversation(conflict.conversationId)
              if (attached) {
                setStatusMessage('Már fut egy válasz — visszacsatlakoztál hozzá.')
                return
              }
            }
            setStatusMessage(conflict.message)
            setIsAgentTyping(false)
            return
          }
          setStatusMessage(conflict.message)
          setIsAgentTyping(false)
          return
        }

        if (!response.ok || !response.body) {
          removeFailedOptimisticMessages()
          markConversationRunning(conversationId, false)
          setStatusMessage(
            options.connectorGrantContinuation
              ? `A hozzáférés megvan, de az agent folytatása nem indult el (${response.status}). Írd meg a chatben, hogy folytassa.`
              : options.consequenceApprovalIds?.length
                ? `A jóváhagyott művelet lefutott, de az agent folytatása nem indult el (${response.status}). Írd meg a chatben, hogy folytassa.`
                : `Küldés sikertelen (${response.status})`,
          )
          return
        }

        let streamTerminalEvent = false

        for await (const event of readAgentChatEventStream(response.body)) {
            if (event.type === 'turn' && event.turnId) {
              const turnBubbleId = agentBubbleIdForTurn(event.turnId)
              setActiveTurnId(event.turnId)
              // flushSync: a rákövetkező activity upsert már a turn-id-s buborékot
              // találja meg, ne az optimistic id-t (ugyanabban a SSE chunkban).
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) => (m.id === agentBubbleMessageId ? { ...m, id: turnBubbleId } : m)),
                )
              })
              agentBubbleMessageId = turnBubbleId
            } else if (event.type === 'meta' && event.conversationId) {
              persistedUserMessageId = event.userMessageId
              streamConversationIdRef.current = event.conversationId
              markConversationRunning(event.conversationId, true)
              setConversationId(event.conversationId)
              setConversationStatus('active')
              setMessages((prev) =>
                prev.map((message) =>
                  message.id === optimisticUserId
                    ? { ...message, id: event.userMessageId }
                    : message,
                ),
              )
            } else if (event.type === 'activity') {
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === agentBubbleMessageId
                      ? {
                          ...m,
                          activities: upsertActivity(m.activities, event.activity),
                        }
                      : m,
                  ),
                )
              })
            } else if (
              event.type === 'thinking' &&
              typeof event.delta === 'string' &&
              thinkingTraceControls === 'enabled'
            ) {
              const { turnId, delta } = event
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === agentBubbleMessageId
                      ? {
                          ...m,
                          thinking: appendThinkingDelta(
                            m.thinking,
                            { turnId, delta },
                            thinkingTraceControls,
                          ),
                        }
                      : m,
                  ),
                )
              })
            } else if (event.type === 'memory_candidate' && event.candidate) {
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === agentBubbleMessageId
                      ? {
                          ...m,
                          memoryCandidates: upsertMemoryCandidate(m.memoryCandidates, {
                            ...event.candidate,
                            status: 'proposed',
                          }),
                        }
                      : m,
                  ),
                )
              })
            } else if (event.type === 'consequence_approval' && event.approval) {
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === agentBubbleMessageId
                      ? {
                          ...m,
                          consequenceApprovals: upsertConsequenceApproval(m.consequenceApprovals, {
                            ...event.approval,
                            status: 'pending',
                          }),
                        }
                      : m,
                  ),
                )
              })
            } else if (event.type === 'connector_grant_needed' && event.grant) {
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === agentBubbleMessageId
                      ? {
                          ...m,
                          connectorGrants: upsertConnectorGrant(
                            m.connectorGrants,
                            connectorGrantCardFromLoopEvent(event.grant),
                          ),
                        }
                      : m,
                  ),
                )
              })
            } else if (event.type === 'token' && typeof event.chunk === 'string') {
              accumulatedReply += event.chunk
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === agentBubbleMessageId ? { ...m, text: m.text + event.chunk! } : m,
                  ),
                )
              })
            } else if (
              event.type === 'done' &&
              event.reason === 'cancelled' &&
              event.conversationId &&
              event.messageId
            ) {
              markConversationRunning(event.conversationId, false)
              setActiveTurnId(null)
              await reloadConversationMessages(event.conversationId)
              setStatusMessage('Agent válasz megszakítva — részeredmény mentve.')
              streamTerminalEvent = true
              break
            } else if (event.type === 'done' && event.conversationId && event.messageId) {
              setConversationId(event.conversationId)
              setConversationStatus('active')
              markConversationRunning(event.conversationId, false)
              setActiveTurnId(null)
              // A Folyamat-választás csak addig marad rögzítve, amíg a Futás
              // ténylegesen el nem indul (§4.4) — utána a chat visszaáll
              // normál beszélgetésre, hogy ne próbálja újraindítani.
              if (accumulatedReply.includes('Futás elindítva a(z)')) {
                setSelectedProcessDefId(null)
              }
              // Mindig a DB végállapotot töltjük: hosszú tool-körök / proxy
              // timeout után a token-stream hiányos lehet, miközben a válasz
              // már perzisztálva van — különben üres agent-buborék marad.
              await reloadConversationMessages(event.conversationId)
              streamTerminalEvent = true
              break
            } else if (event.type === 'error') {
              // Csak a persist-ACK után tartjuk meg a user-üzenetet. Validációs vagy
              // korai szerverhiba esetén a meta esemény még nem érkezett meg.
              removeFailedOptimisticMessages()
              setStatusMessage(event.message ?? 'Küldés sikertelen')
              streamTerminalEvent = true
              break
            }
          if (streamTerminalEvent) break
        }

        if (!streamTerminalEvent) {
          await recoverInterruptedStream('closed_without_terminal')
        }

      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          return
        }
        // A `reader.read()` a válasz-törzs elvágásakor hibát DOB (mobilhálón
        // `TypeError: network error`), nem lezáró eseményt ad — ezért ugyanaz a
        // visszaszerzés jár neki, mint a lezáró esemény nélküli végnek. Enélkül
        // a felhasználó nyers hibaszöveget és üres választ kapott, miközben a
        // forduló a szerveren tovább futott és az eredménye perzisztálódott.
        await recoverInterruptedStream('read_threw')
      } finally {
        if (streamAbortRef.current === abortController) {
          streamAbortRef.current = null
        }
        // Visszacsatlakozás után a háttér-stream birtokolja a buborékot, a
        // stream-konverzáció-ref-et és a „gépel" jelzőt — ezeket nem bántjuk.
        if (!handedOffToReattach) {
          streamConversationIdRef.current = null
          setIsAgentTyping(false)
        }
        setStopPending(false)
        filesRef.current?.refresh()
      }
    })()
  }

  const handleSend = () => {
    if (!canSubmit) return
    const text = input.trim()
    const localAttachments = [...pendingAttachments]
    resetComposer()
    void recordLastAgentChatForCurrentTenant(agent.id)
    startAgentTurn({ text, attachments: localAttachments })
  }

  // A gépelés-vége flush refen keresztül hívja az aktuális implementációt.
  // A ref írása effectben történik: render közben a React 19 szerint nem
  // módosítható, és ez az effect a lenti folytatás-effect előtt fut le.
  useEffect(() => {
    startAgentTurnRef.current = startAgentTurn
  })

  /**
   * Futó forduló közbeni „Jóváhagyom" → folytatás sorba. A forduló végén
   * (isAgentTyping false) automatikusan elindul, hogy ne vesszen el a lánc.
   */
  useEffect(() => {
    if (isAgentTyping) return
    const ids = pendingConsequenceContinuationRef.current
    if (!ids || ids.length === 0) return
    if (conversationStatus === 'archived') {
      pendingConsequenceContinuationRef.current = null
      return
    }
    pendingConsequenceContinuationRef.current = null
    startAgentTurnRef.current?.({
      text: '',
      attachments: [],
      userBubbleText: '✅ Jóváhagyva — a művelet lefutott, folytasd.',
      consequenceApprovalIds: ids,
    })
  }, [isAgentTyping, conversationStatus])

  /**
   * OAuth-grant után (`?granted=1`): a beszélgetés betöltődése után egy
   * folytatás-forduló indul. A zászló a session-store-ban él, hogy a URL
   * takarítása ne írja felül.
   */
  useEffect(() => {
    if (!open || !resumeAfterGrant) return
    if (!initialConversationId || conversationId !== initialConversationId) return
    if (isAgentTyping) return
    if (conversationStatus === 'archived') return
    if (grantResumeStartedRef.current) return
    grantResumeStartedRef.current = true
    clearAgentChatResumeAfterGrant(agent.id)
    stripGrantedQueryFromUrl()
    startAgentTurnRef.current?.({
      text: '',
      attachments: [],
      userBubbleText: '✅ Hozzáférés megadva — folytasd.',
      connectorGrantContinuation: true,
    })
  }, [
    agent.id,
    conversationId,
    conversationStatus,
    initialConversationId,
    isAgentTyping,
    open,
    resumeAfterGrant,
    restoreSignal,
  ])

  const ticketRefIds = useMemo(
    () =>
      [...new Set(messages.map((message) => message.ticketRefId).filter((id): id is string => Boolean(id)))],
    [messages],
  )
  const ticketRefKey = ticketRefIds.join(',')

  useEffect(() => {
    if (ticketRefIds.length === 0) return
    let cancelled = false
    const load = async (initial: boolean) => {
      if (initial) setTaskCardsLoading(true)
      const res = await listChatTaskCards({ ticketIds: ticketRefIds })
      if (cancelled || !res.success) {
        if (!cancelled && initial) setTaskCardsLoading(false)
        return
      }
      const next: Record<string, ChatTaskCardView> = {}
      for (const card of res.data.cards) next[card.ticketId] = card
      setTaskCards(next)
      setTaskCardsLoading(false)
    }
    void load(true)
    const timer = window.setInterval(() => void load(false), 4000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [ticketRefKey, ticketRefIds])

  useEffect(() => {
    if (!focusMessageId || messages.length === 0) return
    const node = document.getElementById(`message-${focusMessageId}`)
    if (!node) return
    node.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focusMessageId, messages])

  /**
   * A „Jóváhagyom" gomb után a művelet a szerveren MÁR lefutott — innen az agent
   * folytatja. Enélkül a felhasználó csak annyit lát, hogy „nem történik semmi":
   * nincs válasz, és a hátralévő lépések (pl. a sorok beírása a létrehozott
   * fájlba) sem futnak le.
   *
   * Ha a kapu-üzenet még streamel, miközben a user már approve-ol (gyakori race),
   * a folytatást sorba tesszük — nem dobjuk el „írj üzenetet" státusszal.
   */
  const handleConsequenceApproved = (approvalIds: string[]) => {
    // A frissen írt fájl azonnal látszódjon a Workspace listában.
    filesRef.current?.refresh()
    if (approvalIds.length === 0) return
    if (conversationStatus === 'archived') {
      setStatusMessage('A művelet lefutott. Az agent folytatásához írj egy üzenetet a chatben.')
      return
    }
    if (isAgentTyping) {
      const prev = pendingConsequenceContinuationRef.current ?? []
      pendingConsequenceContinuationRef.current = [...new Set([...prev, ...approvalIds])]
      setStatusMessage('A művelet lefutott — amint az agent befejezi a választ, folytatjuk.')
      return
    }
    startAgentTurn({
      text: '',
      attachments: [],
      userBubbleText: '✅ Jóváhagyva — a művelet lefutott, folytasd.',
      consequenceApprovalIds: approvalIds,
    })
  }

  const handleCreateTicket = () => {
    if (!canSubmit) return
    const scheduleError = validateTaskSchedule(ticketSchedule)
    if (scheduleError) {
      setStatusMessage(scheduleError)
      return
    }
    const scheduleInput = taskScheduleToInput(ticketSchedule)
    if (!scheduleInput) {
      setStatusMessage('Érvénytelen ütemezés.')
      return
    }
    const text = input.trim()
    const localAttachments = [...pendingAttachments]
    const executeAfterIso = scheduleInput.runAt
    const titleSource = text || localAttachments[0]?.file.name || 'Feladat'

    startTicketTransition(async () => {
      setStatusMessage(null)
      setLastTicketId(null)
      try {
        const documentIds = localAttachments.length > 0 ? await uploadAttachments(localAttachments) : []
        if (executeAfterIso) {
          const scheduledContent =
            text ||
            `Csatolmányok: ${localAttachments.map((attachment) => attachment.file.name).join(', ')}`
          const res = await createScheduledAgentTask({
            agentId: agent.id,
            title: `Feladat: ${titleSource.slice(0, 80)}`,
            content: scheduledContent,
            conversationId: conversationId ?? undefined,
            attachmentDocumentIds: documentIds,
            nextRunAt: executeAfterIso,
            recurrence:
              scheduleInput.scheduleMode === 'recurring'
                ? scheduleInput.recurrence ?? 'daily'
                : 'none',
            intervalHours: scheduleInput.intervalHours,
            maxRuns: scheduleInput.maxRuns,
            authorizeRunAs:
              scheduleInput.scheduleMode === 'recurring' ? ticketAuthorizeRunAs : true,
          })
          if (!res.success) {
            setStatusMessage(res.error)
            return
          }
          setLastTicketId(res.data.ticketId)
          resetComposer()
          setStatusMessage(
            scheduleInput.scheduleMode === 'once'
              ? 'Ütemezett feladat a táblán — a dispatcher a megadott időpontban indítja.'
              : 'Rendszeres feladat a táblán — a dispatcher a gyakoriság szerint indítja.',
          )
          return
        }

        const res = await createAgentTaskTicket({
          agentId: agent.id,
          content: text,
          conversationId: conversationId ?? undefined,
          attachmentDocumentIds: documentIds,
        })
        if (!res.success) {
          setStatusMessage(res.error)
          return
        }
        setLastTicketId(res.data.ticketId)
        resetComposer()
        if (res.data.conversationId) {
          setConversationId(res.data.conversationId)
          const loaded = await loadAgentChatMessages({
            conversationId: res.data.conversationId,
            agentId: agent.id,
          })
          if (loaded.success) {
            setMessages(
              withPendingChatExtras(
                loaded.data.messages.map((message) => ({
                  ...message,
                  createdAt: new Date(message.createdAt).toISOString(),
                })),
                loaded.data.pendingConsequenceApprovals?.map((approval) => ({
                  ...approval,
                  status: 'pending' as const,
                })),
                loaded.data.pendingConnectorGrants,
              ),
            )
          }
        }
        setStatusMessage('Feladat a táblán — a kártyán követheted, hol tart.')
      } catch (e) {
        setStatusMessage(e instanceof Error ? e.message : 'Feladat létrehozás sikertelen')
      }
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash.handleKeyDown(e)) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // Az Enter mindig azt teszi, amit az elsődleges gomb ígér.
      if (composerMode === 'task') handleCreateTicket()
      else handleSend()
    }
  }

  if (!open || !mounted) return null

  const inSessionGrid = embedded || tileTarget !== null

  const panel = (
    <div
      className={
        embedded
          ? 'flex h-full min-h-0 w-full flex-col overflow-hidden'
          : inSessionGrid
            ? `pointer-events-auto relative flex h-[calc(100dvh-1.5rem)] min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-2xl sm:h-full sm:min-h-0 ${
                minimized ? 'hidden' : ''
              }`
            : `fixed inset-0 z-[200] flex items-end justify-center sm:items-center sm:p-6 lg:p-4 ${
                minimized ? 'pointer-events-none invisible' : ''
              }`
      }
      aria-hidden={minimized}
      {...(minimized ? { inert: true } : {})}
    >
      {!inSessionGrid ? (
        <button
          type="button"
          aria-label="Bezárás"
          className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
          onClick={onClose}
          tabIndex={minimized ? -1 : undefined}
        />
      ) : null}
      <div
        role={embedded ? undefined : 'dialog'}
        aria-modal={embedded ? undefined : inSessionGrid ? false : !minimized}
        aria-labelledby="agent-chat-title"
        className={
          embedded
            ? 'flex h-full min-h-0 w-full flex-col overflow-hidden'
            : inSessionGrid
              ? 'flex h-full min-h-0 w-full flex-col'
              : 'relative z-[1] flex h-[100dvh] w-full flex-col overflow-hidden border border-line bg-card shadow-2xl sm:h-[min(calc(100dvh-3rem),calc(100vh-3rem))] sm:max-w-[min(calc(100vw-3rem),100rem)] sm:rounded-2xl lg:h-[min(calc(100dvh-2rem),calc(100vh-2rem))] lg:max-w-[min(calc(100vw-2rem),120rem)]'
        }
      >
        {!embedded ? (
        <header className="flex shrink-0 items-center gap-2.5 border-b border-line bg-card px-3 py-2.5 sm:gap-3 sm:px-4">
          <button
            type="button"
            onClick={() => setSessionsOpen((v) => !v)}
            className="shrink-0 rounded-lg border border-line px-2 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep sm:hidden"
            aria-expanded={sessionsOpen}
            aria-label="Előzmények megnyitása"
          >
            ☰
          </button>
          <AgentAvatar
            name={agent.name}
            status={agent.status}
            size="sm"
            avatarUrl={agent.avatarUrl}
            personaNickname={agent.personaNickname}
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h2
                id="agent-chat-title"
                className="truncate font-display text-base font-semibold leading-tight sm:text-lg"
              >
                {persona.nickname}
              </h2>
              {/* Egyetlen állapotjelző a szál helyzetéről — a régi „aktív szál”
                  chip nem árulta el a lényeget: dolgozik-e éppen az agent. */}
              {activeTurnStalled ? (
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-coral/40 bg-coral/10 px-2 py-0.5 text-[10px] font-semibold text-coral-deep">
                  <span className="h-1.5 w-1.5 rounded-full bg-coral" aria-hidden />
                  úgy tűnik megállt
                </span>
              ) : isAgentTyping ? (
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-sky/40 bg-sky/10 px-2 py-0.5 text-[10px] font-semibold text-sky">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky" aria-hidden />
                  dolgozik
                </span>
              ) : conversationStatus === 'archived' ? (
                <span className="shrink-0 rounded-full border border-line bg-night-2 px-2 py-0.5 text-[10px] font-semibold text-ink-faint">
                  archivált
                </span>
              ) : null}
            </div>
            {connectableUserConnectorsLoading ? (
              <p className="text-[11px] text-ink-faint">Kapcsolatok betöltése…</p>
            ) : connectableUserConnectors.length > 0 ? (
              <AgentDelegatedConnectorsBar items={connectableUserConnectors} variant="compact" />
            ) : (
              <p className="truncate text-[11px] text-ink-faint">
                {conversationId ? 'Mentett beszélgetés' : 'Új beszélgetés'}
              </p>
            )}
          </div>

          {conversationId && (
            <ChatHeaderMenu>
              {runAnalysisEntry?.canRunAnalysis && runAnalysisEntry.runAnalystAgentId ? (
                <ChatMenuItem
                  title="Elemezd"
                  hint="Futás-elemző megnyitása ezzel a beszélgetéssel kitöltve."
                  onClick={handleAnalyzeConversation}
                  disabled={controlsBusy}
                />
              ) : null}
              <ChatMenuItem
                title={ticketPending ? 'Elemzés…' : 'Feladat készítése a szálból'}
                hint="A beszélgetésből AI-feladat lesz a Kanban táblán."
                onClick={handlePromoteConversation}
                disabled={controlsBusy || conversationStatus === 'archived'}
                tone="warn"
              />
              {canDistillSkill && (
                <>
                  {distillTargets.length > 0 && (
                    <label
                      className="block px-3 py-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span className="block text-[11px] font-semibold text-ink-soft">
                        Desztillálás célja
                      </span>
                      <select
                        value={distillTargetSkillId}
                        onChange={(e) => setDistillTargetSkillId(e.target.value)}
                        disabled={controlsBusy}
                        className="mt-1 w-full rounded-lg border border-line bg-night-2 px-2 py-1.5 text-xs text-ink-soft disabled:opacity-40"
                      >
                        <option value="">Új skill</option>
                        {distillTargets.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} (új verzió)
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <ChatMenuItem
                    title={distillPending ? 'Desztillálás…' : 'Skill desztillálása'}
                    hint="A beszélgetés módszeréből skill-vázlat készül (jóváhagyás kell)."
                    onClick={handleDistillSkill}
                    disabled={controlsBusy || messages.length === 0}
                  />
                  <ChatMenuItem
                    title={debugLogPending ? 'Log készül…' : 'Debug-log letöltése'}
                    hint="Teljes telemetria: üzenetek, fordulók, model- és tool-hívások."
                    onClick={handleExportDebugLog}
                    disabled={controlsBusy}
                  />
                </>
              )}
              {conversationStatus !== 'archived' && (
                <>
                  <div className="my-1 h-px bg-line" />
                  <ChatMenuItem
                    title={archivePending ? 'Archiválás…' : 'Szál archiválása'}
                    hint="Olvasható marad, de nem lehet hozzá új üzenetet fűzni."
                    onClick={handleArchiveConversation}
                    disabled={controlsBusy || ticketPending || archivePending}
                  />
                </>
              )}
            </ChatHeaderMenu>
          )}

          <div className="flex shrink-0 items-center gap-0.5 border-l border-line pl-1.5">
            <button
              type="button"
              onClick={handleMinimize}
              className="rounded-lg p-1.5 text-ink-faint transition-colors hover:bg-night-2 hover:text-ink"
              aria-label="Beszélgetés tálcára rakása"
              title="Tálcára rakás"
            >
              −
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-ink-faint transition-colors hover:bg-night-2 hover:text-ink"
              aria-label="Beszélgetés bezárása"
              title="Bezárás"
            >
              ✕
            </button>
          </div>
        </header>
        ) : null}

        {continuedFromTicket && (
          <div className="shrink-0 border-b border-sky/25 bg-sky/8 px-3 py-2 sm:px-4">
            <p className="text-xs leading-snug text-ink-soft">
              <span className="font-semibold text-sky">Feladat megbeszélése:</span>{' '}
              <Link
                href={`/control-plane/tickets/${continuedFromTicket.id}`}
                className="font-medium text-ink underline decoration-sky/40 underline-offset-2 transition-colors hover:text-coral-deep hover:decoration-coral/50"
                title={continuedFromTicket.title}
              >
                {continuedFromTicket.title}
              </Link>
            </p>
          </div>
        )}

        <div
          className={`relative flex min-h-0 flex-1 overflow-hidden${embedded ? '' : ' sm:flex-row-reverse'}`}
        >
          {sessionsOpen && (
            <button
              type="button"
              aria-label="Előzmények bezárása"
              className={`absolute inset-0 z-10 bg-ink/40 ${embedded ? '' : 'sm:hidden'}`}
              onClick={() => setSessionsOpen(false)}
            />
          )}

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div
              ref={scrollRef}
              className={`flex-1 overflow-y-auto ${embedded ? 'px-6 py-5' : 'px-4 py-5 sm:px-6'}`}
            >
              {messages.length === 0 && ticketDiscussionHistory.length === 0 && !isAgentTyping ? (
                previousConversationLoaderVisible({
                  messageCount: messages.length,
                  ticketHistoryCount: ticketDiscussionHistory.length,
                  isAgentTyping,
                  userStartedNew,
                  statusMessage,
                  conversationId,
                  historyLoadState,
                  latestConversationId,
                  initialConversationId,
                  initialPrefill,
                }) ? (
                  <LoadingState
                    label="Előző beszélgetés betöltése…"
                    className="h-full min-h-[200px]"
                  />
                ) : (
                <div className="mx-auto flex h-full min-h-[200px] max-w-md flex-col items-center justify-center text-center">
                  <span className="text-4xl" aria-hidden>
                    {persona.emoji}
                  </span>
                  <p className="mt-4 text-base text-ink-soft">{persona.greeting}</p>
                  <p className="mt-1.5 text-xs text-ink-faint">
                    Írd le, mire van szükséged — {persona.nickname} válaszol.
                  </p>
                  {/* Üres állapot: a panel képességei nem derülnek ki a beviteli
                      mezőből, ezért itt egyszer, hétköznapi nyelven kimondjuk. */}
                  <ul className="mt-6 w-full space-y-2 text-left">
                    {[
                      {
                        icon: '📎',
                        title: 'Fájl vagy kép csatolása',
                        hint: 'Húzd be, vagy használd a gemkapcsot a beviteli mezőnél.',
                      },
                      ...(agentSkills.length > 0
                        ? [
                            {
                              icon: '⚡',
                              title: 'Skill indítása',
                              hint: 'Írj / jelet, vagy válassz a „Skill” gombbal.',
                            },
                          ]
                        : []),
                      {
                        icon: '📋',
                        title: 'Üzenetből feladat',
                        hint: 'Válts „Feladat” módra, ha a táblára kell kerülnie — akár időzítve.',
                      },
                      ...(chatProcessDefs.length > 0
                        ? [
                            {
                              icon: '▶',
                              title: 'Folyamat indítása',
                              hint: 'Válts „Folyamat” módra, válassz folyamatot, majd küldj üzenetet vagy csatolj fájlt.',
                            },
                          ]
                        : []),
                    ].map((tip) => (
                      <li
                        key={tip.title}
                        className="flex items-start gap-2.5 rounded-xl border border-line bg-card px-3 py-2.5"
                      >
                        <span aria-hidden className="text-base leading-5">
                          {tip.icon}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-xs font-semibold text-ink">{tip.title}</span>
                          <span className="block text-[11px] leading-snug text-ink-faint">
                            {tip.hint}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                )
              ) : (
                <div className={embedded ? 'mx-auto max-w-[860px]' : 'mx-auto max-w-5xl'}>
                  {ticketDiscussionHistory.length > 0 && (
                    <div className="mb-6 space-y-3 border-b border-line pb-5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                        Feladat előzménye
                      </p>
                      {ticketDiscussionHistory.map((item) => {
                        const isUser = item.role === 'user'
                        return (
                          <div
                            key={item.id}
                            className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
                          >
                            <div
                              className={`max-w-[min(88%,64rem)] rounded-2xl px-4 py-3 text-sm shadow-sm ${
                                isUser
                                  ? 'rounded-tr-md bg-coral/85 text-card'
                                  : item.role === 'system'
                                    ? 'rounded-tl-md border border-dashed border-line bg-night-2 text-ink-faint'
                                    : 'rounded-tl-md border border-line bg-card/80 text-ink-soft'
                              }`}
                            >
                              <div
                                className={`mb-1 text-[11px] font-semibold ${
                                  isUser ? 'text-card/80' : 'text-ink-faint'
                                }`}
                              >
                                {item.authorLabel}
                              </div>
                              {isUser ? (
                                <div className="[&_a]:text-card [&_a]:underline [&_strong]:text-card">
                                  <ChatMarkdown content={item.text} variant="user" />
                                </div>
                              ) : (
                                <ChatMarkdown content={item.text} variant="agent" />
                              )}
                            </div>
                          </div>
                        )
                      })}
                      {messages.length === 0 && !isAgentTyping && (
                        <p className="pt-1 text-center text-xs text-ink-faint">
                          Írd meg a kérdésed — {persona.nickname} a feladat előzményével válaszol.
                        </p>
                      )}
                    </div>
                  )}
                  {messages.map((message, index) => (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      isBusy={controlsBusy}
                      showAuthor={messages[index - 1]?.role !== message.role}
                      agentName={persona.nickname}
                      agentAvatarUrl={agent.avatarUrl}
                      agentStatus={agent.status}
                      personaNickname={agent.personaNickname}
                      taskCard={
                        message.ticketRefId ? taskCards[message.ticketRefId] ?? null : null
                      }
                      taskCardLoading={Boolean(message.ticketRefId) && taskCardsLoading}
                      focused={focusMessageId === message.id}
                      activityStalled={
                        activeTurnStalled &&
                        activeTurnId != null &&
                        message.id === agentBubbleIdForTurn(activeTurnId)
                      }
                      activityStallDetail={activeTurnStallDetail}
                      onDeleteContent={handleDeleteMessageContent}
                      onOpenTask={handleMinimize}
                      onMemoryCandidateUpdate={handleMemoryCandidateUpdate}
                      onConsequenceApprovalUpdate={handleConsequenceApprovalUpdate}
                      onConsequenceApproved={handleConsequenceApproved}
                      grantReturnTo={
                        conversationId
                          ? { kind: 'conversation', id: conversationId, agentId: agent.id }
                          : undefined
                      }
                      onOauthRedirect={handleOauthRedirect}
                      workspaceBaseUrl={
                        conversationId
                          ? `/api/v1/conversations/${conversationId}/workspace/files`
                          : undefined
                      }
                      workspaceFilePaths={workspaceFilePaths}
                      isAdmin={isAdmin}
                      privacyContext={privacyContext}
                    />
                  ))}
                  {isAgentTyping &&
                    !messages[messages.length - 1]?.text &&
                    !chatMessageShowsAgentActivity(messages[messages.length - 1]) && (
                    <div className="mt-4">
                      <TypingIndicator agentName={persona.nickname} />
                    </div>
                  )}
                </div>
              )}
            </div>

            {conversationId && (
              <ConversationFilesPanel
                conversationId={conversationId}
                panelRef={filesRef}
                onFilesChange={setWorkspaceFilePaths}
              />
            )}

            <div
              className={
                embedded
                  ? 'shrink-0 bg-transparent px-6 pb-5 pt-0'
                  : 'shrink-0 border-t border-line bg-night px-3 py-3 sm:px-5 sm:py-4'
              }
            >
              <AgentChatComposer
                embedded={embedded}
                nickname={persona.nickname}
                archived={conversationStatus === "archived"}
                statusMessage={statusMessage}
                lastTicketId={lastTicketId}
                onOpenTicket={handleMinimize}
                attachmentWarningSkills={attachmentWarningSkills}
                attachments={pendingAttachments}
                onRemoveAttachment={removeAttachment}
                onFilesSelected={handleFilesSelected}
                fileInputRef={fileInputRef}
                mode={composerMode}
                onModeChange={switchComposerMode}
                disabled={composerDisabled}
                skills={agentSkills}
                slash={slash}
                processes={chatProcessDefs}
                selectedProcess={selectedProcessDef}
                selectedProcessId={selectedProcessDefId}
                processMissingFileAttachment={processMissingFileAttachment}
                onSelectProcess={setSelectedProcessDefId}
                ticketSchedule={ticketSchedule}
                onTicketScheduleChange={setTicketSchedule}
                ticketAuthorizeRunAs={ticketAuthorizeRunAs}
                onTicketAuthorizeRunAsChange={setTicketAuthorizeRunAs}
                input={input}
                onInputChange={setInput}
                textareaRef={textareaRef}
                onKeyDown={handleKeyDown}
                turnBlocksComposer={turnBlocksComposer}
                stopPending={stopPending}
                ticketPending={ticketPending}
                pending={pending}
                canSubmit={canSubmit}
                onStop={handleStop}
                onCreateTicket={handleCreateTicket}
                onSend={handleSend}
              />
              <MemoryStrip
                conversationId={conversationId}
                agentId={agent.id}
                workspaceFiles={workspaceFilePaths}
              />
            </div>
          </div>

          <div
            className={`absolute inset-y-0 right-0 z-20 w-[min(88vw,17rem)] border-l border-line bg-night shadow-xl transition-transform duration-200 ease-out ${
              embedded
                ? sessionsOpen
                  ? 'translate-x-0'
                  : 'translate-x-full'
                : `sm:static sm:z-0 sm:w-56 sm:shrink-0 sm:translate-x-0 sm:shadow-none lg:w-64 xl:w-72 ${
                    sessionsOpen ? 'translate-x-0' : 'translate-x-full sm:translate-x-0'
                  }`
            }`}
          >
            <AgentChatSessionSidebar
              sessions={sessions}
              activeConversationId={conversationId}
              runningConversationIds={runningConversationIds}
              statusFilter={sessionsFilter}
              loading={sessionsLoading}
              loadingMore={sessionsLoadingMore}
              hasMore={sessionsHasMore}
              isBusy={controlsBusy}
              onSelect={selectSession}
              onNewChat={startNewSession}
              onLoadMore={loadMoreSessions}
              onStatusFilterChange={setSessionsFilter}
              className="h-full"
            />
          </div>
        </div>
      </div>
    </div>
  )

  if (embedded) return panel
  return createPortal(panel, tileTarget ?? document.body)
}

export function AgentChatButton({
  agent,
  className = '',
  compact = false,
  label = '💬 Beszélgetés',
  canDistillSkill = false,
  initialConversationId = null,
  autoOpen = false,
  resumeAfterGrant = false,
  initialPrefill = null,
}: {
  agent: ChatAgent
  className?: string
  compact?: boolean
  label?: string
  canDistillSkill?: boolean
  initialConversationId?: string | null
  autoOpen?: boolean
  resumeAfterGrant?: boolean
  initialPrefill?: string | null
}) {
  useEffect(() => {
    if (!autoOpen) return
    openAgentChat({
      agent,
      canDistillSkill,
      initialConversationId,
      initialPrefill,
      ...(resumeAfterGrant ? { resumeAfterGrant: true } : {}),
    })
    // Szándékos: autoOpen / deep-link változáskor nyissa (vagy hozza elő) a panelt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, agent.id, initialConversationId, initialPrefill, canDistillSkill, resumeAfterGrant])

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        openAgentChat({
          agent,
          canDistillSkill,
          initialConversationId,
          initialPrefill,
        })
      }}
      className={
        className ||
        (compact
          ? 'rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep'
          : 'rounded-full bg-sage px-4 py-2 text-sm font-semibold text-card shadow-[0_8px_20px_-12px_rgba(93,138,79,0.7)] transition-transform hover:-translate-y-0.5')
      }
    >
      {label}
    </button>
  )
}
