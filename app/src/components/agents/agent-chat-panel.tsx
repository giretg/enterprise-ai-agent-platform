'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { createPortal, flushSync } from 'react-dom'
import {
  approveMemoryCandidate,
  archiveConversation,
  createAgentTaskTicket,
  createScheduledAgentTask,
  deleteMessageContent,
  listAgentChatSessions,
  loadAgentChatMessages,
  modifyMemoryCandidate,
  promoteConversationWithAi,
  rejectMemoryCandidate,
  ticketMemoryCandidate,
  uploadDocument,
} from '@/app/actions/platform'
import { distillSkillFromConversationAction, getAgentSkillsAction } from '@/app/actions/skills'
import { listChatTriggerableProcessDefinitions } from '@/app/actions/process'
import { listAgentDelegatedConnectors } from '@/app/actions/connector-grants'
import { AgentDelegatedConnectorsBar } from '@/components/agents/agent-delegated-connectors-bar'
import type { AgentDelegatedConnectorRow } from '@/lib/agent-delegated-connectors'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { ChatMarkdown, TypingIndicator } from '@/components/chat/chat-markdown'
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
import {
  filterSkillsForSlashQuery,
  getActiveSlashQuery,
  insertSkillSlashToken,
  skillNameToSlashToken,
} from '@/lib/skill/skill-slash-command'

type PendingAttachment = {
  id: string
  file: File
  previewUrl: string | null
  kind: 'text' | 'image'
}

type ChatMessage = {
  id: string
  role: 'user' | 'agent' | 'system' | 'tool'
  text: string
  attachments: Array<{
    documentId: string
    filename: string
    kind: 'text' | 'image'
    previewDataUrl?: string | null
  }>
  createdAt: string
  contentDeletedAt?: string | null
  ticketRefId?: string | null
  activities?: AgentActivity[]
  activitiesCollapsed?: boolean
  memoryCandidates?: MemoryCandidateCard[]
}

type ScheduledTaskRecurrence = 'none' | 'daily' | 'weekly' | 'monthly'

type ChatProcessDefinition = {
  id: string
  name: string
  description: string | null
  slots: Array<{ name: string; type: string; required: boolean; description?: string }>
}

type AgentActivity = {
  id: string
  kind: 'reasoning' | 'tool'
  title: string
  detail?: string
  status: 'running' | 'done' | 'error' | 'skipped'
  archivePath?: string
}

/**
 * WP-5 (agent-memory-persistent-cross-conversation-spec.md §6.2) — az agent
 * `memory_propose` hívása után a chat-streambe kerülő batch-kártya egy sora.
 * A `status`/`resultMessage` kliens-oldali, a jóváhagyási gombok eredményét
 * tükrözi (a szerver a forrás-igazság, ez csak a kártya azonnali visszajelzése).
 */
type MemoryCandidateCard = {
  candidateId: string
  operation: string
  type: string | null
  title: string | null
  summary: string | null
  projectKey: string
  workstreamKey: string | null
  status: 'proposed' | 'approved' | 'ticketed' | 'rejected'
  resultMessage?: string
}

type AgentChatStreamEvent =
  | { type: 'meta'; conversationId: string }
  | { type: 'activity'; activity: AgentActivity }
  | { type: 'memory_candidate'; candidate: Omit<MemoryCandidateCard, 'status' | 'resultMessage'> }
  | { type: 'token'; chunk: string }
  | { type: 'done'; conversationId: string; messageId: string; ticketRefId?: string | null }
  | { type: 'cancelled'; conversationId: string; messageId: string }
  | { type: 'error'; message?: string }

const CHAT_SESSIONS_PAGE_SIZE = 10

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

function makePendingAttachment(file: File): PendingAttachment {
  const kind = isImageFile(file) ? 'image' : 'text'
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    file,
    kind,
    previewUrl: kind === 'image' ? URL.createObjectURL(file) : null,
  }
}

async function uploadAttachments(files: PendingAttachment[]): Promise<string[]> {
  const ids: string[] = []
  for (const attachment of files) {
    const fd = new FormData()
    fd.set('file', attachment.file)
    const res = await uploadDocument(fd)
    if (!res.success) throw new Error(res.error)
    ids.push(res.data.id)
  }
  return ids
}

function activityStatusLabel(status: AgentActivity['status']): string {
  switch (status) {
    case 'running':
      return 'fut'
    case 'done':
      return 'kész'
    case 'skipped':
      return 'kihagyva'
    case 'error':
      return 'hiba'
  }
}

function activityDotClass(status: AgentActivity['status']): string {
  switch (status) {
    case 'running':
      return 'bg-sky'
    case 'done':
      return 'bg-sage'
    case 'skipped':
      return 'bg-honey'
    case 'error':
      return 'bg-coral'
  }
}

function upsertActivity(activities: AgentActivity[] | undefined, next: AgentActivity): AgentActivity[] {
  const current = activities ?? []
  const index = current.findIndex((activity) => activity.id === next.id)
  if (index < 0) return [...current, next]
  return current.map((activity, i) => (i === index ? { ...activity, ...next } : activity))
}

function upsertMemoryCandidate(
  candidates: MemoryCandidateCard[] | undefined,
  next: MemoryCandidateCard,
): MemoryCandidateCard[] {
  const current = candidates ?? []
  const index = current.findIndex((c) => c.candidateId === next.candidateId)
  if (index < 0) return [...current, next]
  return current.map((c, i) => (i === index ? { ...c, ...next } : c))
}

const MEMORY_CANDIDATE_TYPE_LABEL: Record<string, string> = {
  focus: 'Fókusz',
  decision: 'Döntés',
  open_task: 'Nyitott feladat',
  assumption: 'Feltételezés',
  finding: 'Feltárás',
  constraint: 'Megkötés',
  artifact: 'Artifact',
  failed_attempt: 'Sikertelen próbálkozás',
  handoff_summary: 'Átadás-összefoglaló',
}

const MEMORY_CANDIDATE_STATUS_LABEL: Record<MemoryCandidateCard['status'], string> = {
  proposed: 'Jóváhagyásra vár',
  approved: 'Jóváhagyva',
  ticketed: 'Ticketben (jóváhagyásra vár)',
  rejected: 'Elutasítva',
}

function FieldHelp({ description }: { description: string }) {
  return (
    <details className="group relative inline-flex">
      <summary
        className="flex h-4 w-4 cursor-help list-none items-center justify-center rounded-full border border-line bg-card text-[10px] font-semibold text-ink-faint transition-colors hover:border-coral/40 hover:text-coral-deep"
        aria-label="Mező súgó"
      >
        ?
      </summary>
      <div className="pointer-events-none absolute left-1/2 top-[calc(100%+0.35rem)] z-20 w-56 -translate-x-1/2 rounded-lg border border-line bg-card px-2.5 py-2 text-[11px] leading-relaxed text-ink-soft opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-open:opacity-100">
        {description}
      </div>
    </details>
  )
}

function AgentActivityPanel({
  activities,
  collapsed,
}: {
  activities: AgentActivity[]
  collapsed: boolean
}) {
  const running = activities.find((activity) => activity.status === 'running')
  const hasError = activities.some((activity) => activity.status === 'error')
  const summary = running
    ? `${running.title} fut`
    : hasError
      ? 'Műveletek hibával'
      : 'Műveletek kész'

  return (
    <details
      open={!collapsed}
      className="mb-3 rounded-lg border border-line bg-night-2/70 px-3 py-2 text-xs text-ink-soft"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-medium text-ink">
        <span className="min-w-0 truncate">
          Agent aktivitás
          <span className="ml-2 font-normal text-ink-faint">{summary}</span>
        </span>
        <span className="shrink-0 rounded-full bg-card px-1.5 py-0.5 text-[10px] font-semibold text-ink-faint">
          {activities.length}
        </span>
      </summary>
      <div className="mt-2 space-y-1.5">
        {activities.map((activity) => (
          <div key={activity.id} className="flex min-w-0 items-start gap-2">
            <span
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${activityDotClass(activity.status)} ${
                activity.status === 'running' ? 'animate-pulse' : ''
              }`}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="truncate font-medium text-ink">{activity.title}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-faint">
                  {activityStatusLabel(activity.status)}
                </span>
              </div>
              {(activity.detail || activity.archivePath) && (
                <p className="truncate text-[11px] text-ink-faint" title={activity.archivePath ?? activity.detail}>
                  {activity.detail}
                  {activity.archivePath ? ` · ${activity.archivePath}` : ''}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </details>
  )
}

/**
 * WP-5 (§6.2 batch-kártya) — egy üzenet összes memória-javaslata egy kártyán,
 * soronként Jóváhagyom/Módosítom/Ticketbe küldöm/Elutasítom gombbal, plusz
 * egy "Jóváhagyom mind" a nyitott (proposed) sorokra. A jogosultsági
 * elágazást (inline vs. ticket) a szerver dönti el — a kártya csak a
 * visszakapott eredményt (jóváhagyva / ticketben / hiba) jeleníti meg.
 */
function MemoryCandidatesPanel({
  candidates,
  onUpdate,
}: {
  candidates: MemoryCandidateCard[]
  onUpdate: (candidateId: string, patch: Partial<MemoryCandidateCard>) => void
}) {
  const [pending, startTransition] = useTransition()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editSummary, setEditSummary] = useState('')

  const openCount = candidates.filter((c) => c.status === 'proposed').length

  const runApprove = (candidateId: string) => {
    startTransition(async () => {
      const res = await approveMemoryCandidate({ candidateId })
      if (!res.success) {
        onUpdate(candidateId, { resultMessage: res.error })
        return
      }
      const outcome = (res.data as { outcome?: string }).outcome
      onUpdate(candidateId, {
        status: outcome === 'ticketed' ? 'ticketed' : 'approved',
        resultMessage: undefined,
      })
    })
  }

  const runReject = (candidateId: string) => {
    startTransition(async () => {
      const res = await rejectMemoryCandidate({ candidateId })
      onUpdate(candidateId, {
        status: res.success ? 'rejected' : 'proposed',
        resultMessage: res.success ? undefined : res.error,
      })
    })
  }

  const runTicket = (candidateId: string) => {
    startTransition(async () => {
      const res = await ticketMemoryCandidate({ candidateId })
      onUpdate(candidateId, {
        status: res.success ? 'ticketed' : 'proposed',
        resultMessage: res.success ? undefined : res.error,
      })
    })
  }

  const runModifySave = (candidateId: string) => {
    startTransition(async () => {
      const res = await modifyMemoryCandidate({ candidateId, patch: { summary: editSummary } })
      onUpdate(candidateId, {
        summary: res.success ? editSummary : candidates.find((c) => c.candidateId === candidateId)?.summary ?? null,
        resultMessage: res.success ? undefined : res.error,
      })
      if (res.success) setEditingId(null)
    })
  }

  return (
    <div className="mb-3 rounded-lg border border-line bg-night-2/70 px-3 py-2 text-xs text-ink-soft">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium text-ink">Memória-javaslat{candidates.length > 1 ? `ok (${candidates.length})` : ''}</span>
        {openCount > 1 && (
          <button
            type="button"
            disabled={pending}
            className="rounded-full bg-sage/20 px-3 py-1 text-[11px] font-semibold text-sage disabled:opacity-50"
            onClick={() => candidates.filter((c) => c.status === 'proposed').forEach((c) => runApprove(c.candidateId))}
          >
            Jóváhagyom mind
          </button>
        )}
      </div>
      <div className="space-y-2">
        {candidates.map((c) => (
          <div key={c.candidateId} className="rounded-md border border-line/70 bg-card/40 px-2.5 py-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="rounded-full bg-card px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                {MEMORY_CANDIDATE_TYPE_LABEL[c.type ?? ''] ?? c.type ?? c.operation}
              </span>
              <span className="truncate font-medium text-ink">{c.title ?? '(cím nélkül)'}</span>
              <span className="ml-auto shrink-0 text-[10px] text-ink-faint">{MEMORY_CANDIDATE_STATUS_LABEL[c.status]}</span>
            </div>
            {c.summary && <p className="mt-1 text-[11px] text-ink-faint">{c.summary}</p>}
            <p className="mt-1 text-[10px] text-ink-faint">
              scope: {c.projectKey}
              {c.workstreamKey ? ` / ${c.workstreamKey}` : ''}
            </p>
            {c.resultMessage && <p className="mt-1 text-[11px] text-coral">{c.resultMessage}</p>}
            {c.status === 'proposed' && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  disabled={pending}
                  className="rounded-full bg-sage/20 px-2.5 py-1 text-[11px] font-semibold text-sage disabled:opacity-50"
                  onClick={() => runApprove(c.candidateId)}
                >
                  Jóváhagyom
                </button>
                <button
                  type="button"
                  disabled={pending}
                  className="rounded-full bg-sky/20 px-2.5 py-1 text-[11px] font-semibold text-sky disabled:opacity-50"
                  onClick={() => {
                    setEditingId(editingId === c.candidateId ? null : c.candidateId)
                    setEditSummary(c.summary ?? '')
                  }}
                >
                  Módosítom
                </button>
                <button
                  type="button"
                  disabled={pending}
                  className="rounded-full bg-honey/20 px-2.5 py-1 text-[11px] font-semibold text-honey disabled:opacity-50"
                  onClick={() => runTicket(c.candidateId)}
                >
                  Ticketbe küldöm
                </button>
                <button
                  type="button"
                  disabled={pending}
                  className="rounded-full bg-coral/20 px-2.5 py-1 text-[11px] font-semibold text-coral disabled:opacity-50"
                  onClick={() => runReject(c.candidateId)}
                >
                  Elutasítom
                </button>
              </div>
            )}
            {editingId === c.candidateId && (
              <div className="mt-2 flex flex-col gap-1.5">
                <textarea
                  className="w-full rounded-lg border border-line bg-night-2 p-2 text-[11px]"
                  rows={3}
                  value={editSummary}
                  onChange={(e) => setEditSummary(e.target.value)}
                />
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    disabled={pending}
                    className="rounded-full bg-sage/20 px-2.5 py-1 text-[11px] font-semibold text-sage disabled:opacity-50"
                    onClick={() => runModifySave(c.candidateId)}
                  >
                    Mentés
                  </button>
                  <button
                    type="button"
                    className="rounded-full bg-card px-2.5 py-1 text-[11px] font-semibold text-ink-faint"
                    onClick={() => setEditingId(null)}
                  >
                    Mégse
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function MessageBubble({
  message,
  isBusy,
  onDeleteContent,
  onMemoryCandidateUpdate,
}: {
  message: ChatMessage
  isBusy: boolean
  onDeleteContent: (messageId: string) => void
  onMemoryCandidateUpdate: (messageId: string, candidateId: string, patch: Partial<MemoryCandidateCard>) => void
}) {
  const isUser = message.role === 'user'
  const isDeleted = Boolean(message.contentDeletedAt)

  return (
    <div className={`flex animate-rise ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`group relative max-w-[85%] rounded-2xl px-4 py-3 shadow-sm ${
          isDeleted
            ? 'border border-dashed border-line bg-night-2 text-ink-faint'
            : isUser
              ? 'rounded-br-md bg-coral text-card'
              : 'rounded-bl-md border border-line bg-card text-ink-soft'
        }`}
      >
        {isDeleted ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="h-2 w-10 rounded-full bg-line" aria-hidden />
            <span>Tartalom törölve</span>
          </div>
        ) : (
          <>
            {!isUser && message.activities && message.activities.length > 0 && (
              <AgentActivityPanel
                activities={message.activities}
                collapsed={message.activitiesCollapsed ?? false}
              />
            )}
            {!isUser && message.memoryCandidates && message.memoryCandidates.length > 0 && (
              <MemoryCandidatesPanel
                candidates={message.memoryCandidates}
                onUpdate={(candidateId, patch) => onMemoryCandidateUpdate(message.id, candidateId, patch)}
              />
            )}
            {message.text &&
              (isUser ? (
                <div className="text-sm [&_a]:text-card [&_a]:underline [&_strong]:text-card">
                  <ChatMarkdown content={message.text} variant="user" />
                </div>
              ) : (
                <ChatMarkdown content={message.text} variant="agent" />
              ))}
          </>
        )}
        {!isDeleted && message.attachments.length > 0 && (
          <div
            className={`mt-2 flex flex-wrap gap-2 ${message.text ? 'border-t pt-2' : ''} ${
              isUser ? 'border-white/20' : 'border-line'
            }`}
          >
            {message.attachments.map((attachment) =>
              attachment.kind === 'image' && attachment.previewDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={attachment.documentId}
                  src={attachment.previewDataUrl}
                  alt={attachment.filename}
                  className="max-h-40 max-w-full rounded-lg object-cover"
                />
              ) : (
                <span
                  key={attachment.documentId}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${
                    isUser ? 'bg-card/15 text-card' : 'bg-night-2 text-ink-faint'
                  }`}
                >
                  📎 {attachment.filename}
                </span>
              ),
            )}
          </div>
        )}
        {!isDeleted && !message.id.startsWith('optimistic-') && (
          <button
            type="button"
            onClick={() => onDeleteContent(message.id)}
            disabled={isBusy}
            className={`absolute -top-2 ${isUser ? '-left-2' : '-right-2'} rounded-full border border-line bg-card px-2 py-1 text-[10px] font-semibold text-ink-faint opacity-0 shadow-sm transition-opacity hover:text-coral-deep group-hover:opacity-100 focus:opacity-100 disabled:opacity-40`}
            title="Üzenettartalom törlése"
            aria-label="Üzenettartalom törlése"
          >
            Törlés
          </button>
        )}
        {message.ticketRefId && (
          <Link
            href={`/control-plane/tickets/${message.ticketRefId}`}
            className={`mt-2 inline-flex text-[11px] font-semibold hover:underline ${
              isUser ? 'text-card' : 'text-coral'
            }`}
          >
            {message.text.includes('Futás elindítva a(z)')
              ? 'Belépő ticket megnyitása →'
              : 'Ticket megnyitása →'}
          </Link>
        )}
      </div>
    </div>
  )
}

export type ChatSkillOption = {
  skillId: string
  skillVersionId: string
  name: string
  description: string
}

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
}: {
  agent: ChatAgent
  open: boolean
  onClose: () => void
  /** Admin: D14 skill-desztilláció a beszélgetésből (skill-catalog-spec §WP-6). */
  canDistillSkill?: boolean
}) {
  const persona = personaFor(agent.name, agent)
  const [input, setInput] = useState('')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [lastTicketId, setLastTicketId] = useState<string | null>(null)
  const [ticketExecuteAfter, setTicketExecuteAfter] = useState('')
  const [ticketRecurrence, setTicketRecurrence] = useState<ScheduledTaskRecurrence>('none')
  const [ticketMaxRuns, setTicketMaxRuns] = useState('')
  const [ticketAuthorizeRunAs, setTicketAuthorizeRunAs] = useState(false)
  const [isAgentTyping, setIsAgentTyping] = useState(false)
  const [stopPending, setStopPending] = useState(false)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false)
  const [sessionsHasMore, setSessionsHasMore] = useState(false)
  const [sessionsNextOffset, setSessionsNextOffset] = useState(0)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [sessionsFilter, setSessionsFilter] = useState<ChatSessionStatusFilter>('active')
  const [conversationStatus, setConversationStatus] = useState<'active' | 'archived'>('active')
  const [chatProcessDefs, setChatProcessDefs] = useState<ChatProcessDefinition[]>([])
  const [selectedProcessDefId, setSelectedProcessDefId] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [ticketPending, startTicketTransition] = useTransition()
  const [archivePending, startArchiveTransition] = useTransition()
  const [distillPending, startDistillTransition] = useTransition()
  const [distillTargetSkillId, setDistillTargetSkillId] = useState<string>('')
  const [distillTargets, setDistillTargets] = useState<Array<{ id: string; name: string }>>([])
  const [agentSkills, setAgentSkills] = useState<ChatSkillOption[]>([])
  const [inputCursor, setInputCursor] = useState(0)
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const filesRef = useRef<ConversationFilesPanelHandle>(null)
  const streamAbortRef = useRef<AbortController | null>(null)
  const streamConversationIdRef = useRef<string | null>(null)
  const [mounted, setMounted] = useState(false)
  const [connectableUserConnectors, setConnectableUserConnectors] = useState<
    AgentDelegatedConnectorRow[]
  >([])
  const [connectableUserConnectorsLoading, setConnectableUserConnectorsLoading] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setMounted(true), 0)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow
    }
  }, [open])

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
    if (!open) return
    const timer = window.setTimeout(() => void refreshSessions(), 0)
    return () => window.clearTimeout(timer)
  }, [open, refreshSessions])

  useEffect(() => {
    if (!open) return
    void (async () => {
      const res = await listChatTriggerableProcessDefinitions({ agentId: agent.id })
      if (res.success) setChatProcessDefs(res.data as ChatProcessDefinition[])
    })()
  }, [open, agent.id])

  const startNewSession = useCallback(() => {
    if (isAgentTyping) return
    setConversationId(null)
    setMessages([])
    setStatusMessage(null)
    setLastTicketId(null)
    setConversationStatus('active')
    setSessionsFilter('active')
    setSessionsOpen(false)
    setSelectedProcessDefId(null)
  }, [isAgentTyping])

  const selectSession = useCallback(
    async (id: string) => {
      if (isAgentTyping || id === conversationId) {
        setSessionsOpen(false)
        return
      }

      setConversationId(id)
      setStatusMessage(null)
      setLastTicketId(null)
      setSessionsOpen(false)
      setSelectedProcessDefId(null)
      setConversationStatus(sessions.find((session) => session.id === id)?.status ?? 'active')

      const res = await loadAgentChatMessages({ conversationId: id, agentId: agent.id })
      if (res.success) {
        setConversationStatus(res.data.conversation.status)
        setMessages(
          res.data.messages.map((m) => ({
            ...m,
            createdAt: new Date(m.createdAt).toISOString(),
          })),
        )
      } else {
        setStatusMessage(res.error)
      }
    },
    [agent.id, conversationId, isAgentTyping, sessions],
  )

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
      if (e.key === 'Escape' && open) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  const resetComposer = () => {
    setInput('')
    setTicketExecuteAfter('')
    setTicketRecurrence('none')
    setTicketMaxRuns('')
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

  const canSubmit =
    conversationStatus !== 'archived' &&
    (input.trim().length > 0 || pendingAttachments.length > 0) &&
    !pending &&
    !ticketPending &&
    !isAgentTyping
  const controlsBusy = pending || ticketPending || archivePending || distillPending || isAgentTyping

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

  const slashContext = useMemo(
    () => getActiveSlashQuery(input, inputCursor),
    [input, inputCursor],
  )
  const slashSkillOptions = useMemo(
    () => (slashContext ? filterSkillsForSlashQuery(agentSkills, slashContext.query) : []),
    [agentSkills, slashContext],
  )

  const applySkillSlashSelection = useCallback(
    (skill: ChatSkillOption) => {
      if (!slashContext) return
      const next = insertSkillSlashToken({
        text: input,
        cursorPos: inputCursor,
        slashStart: slashContext.start,
        token: skillNameToSlashToken(skill.name),
      })
      setInput(next.text)
      setInputCursor(next.cursorPos)
      setSlashSelectedIndex(0)
      requestAnimationFrame(() => {
        const textarea = textareaRef.current
        if (!textarea) return
        textarea.focus()
        textarea.setSelectionRange(next.cursorPos, next.cursorPos)
      })
    },
    [input, inputCursor, slashContext],
  )

  const syncInputCursor = useCallback((target: HTMLTextAreaElement) => {
    setInputCursor(target.selectionStart ?? 0)
  }, [])
  const composerDisabled = controlsBusy || conversationStatus === 'archived'
  const slashMenuOpen = !composerDisabled && slashContext !== null

  const handleDeleteMessageContent = useCallback(
    (messageId: string) => {
      if (controlsBusy) return
      if (!window.confirm('Törlöd az üzenet tartalmát? A szálban csak a csontváz marad.')) return

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
        setMessages(
          refreshed.data.messages.map((m) => ({
            ...m,
            createdAt: new Date(m.createdAt).toISOString(),
          })),
        )
      }
      if ('ticketId' in res.data) {
        setLastTicketId(res.data.ticketId)
        setStatusMessage('A ticket elkészült és belinkeltem a beszélgetésbe.')
      } else {
        setStatusMessage('Az AI visszakérdezett a ticket létrehozása előtt.')
      }
      await refreshSessions()
    })
  }, [agent.id, conversationId, controlsBusy, refreshSessions])

  const handleArchiveConversation = useCallback(() => {
    if (!conversationId || controlsBusy || conversationStatus === 'archived') return
    if (!window.confirm('Archiválod ezt a beszélgetést? Ezután csak olvasható lesz.')) return
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

  const reloadConversationMessages = useCallback(
    async (convId: string) => {
      const res = await loadAgentChatMessages({ conversationId: convId, agentId: agent.id })
      if (!res.success) {
        setStatusMessage(res.error)
        return false
      }
      setConversationId(convId)
      setConversationStatus(res.data.conversation.status)
      setMessages(
        res.data.messages.map((m) => ({
          ...m,
          createdAt: new Date(m.createdAt).toISOString(),
        })),
      )
      startTransition(() => {
        void refreshSessions()
      })
      return true
    },
    [agent.id, refreshSessions],
  )

  const handleStop = () => {
    const convId = streamConversationIdRef.current ?? conversationId
    if (!convId || stopPending) return
    setStopPending(true)
    setStatusMessage(null)
    void (async () => {
      try {
        const response = await fetch('/api/v1/agent-chat/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: convId }),
        })
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

  const handleSend = () => {
    if (!canSubmit) return
    const text = input.trim()
    const localAttachments = [...pendingAttachments]
    const optimisticUserId = `optimistic-user-${Date.now()}`
    const optimisticAgentId = `optimistic-agent-${Date.now()}`

    const optimisticUserMessage: ChatMessage = {
      id: optimisticUserId,
      role: 'user',
      text: text || '(csatolmányok)',
      attachments: localAttachments.map((a) => ({
        documentId: a.id,
        filename: a.file.name,
        kind: a.kind,
        previewDataUrl: a.previewUrl,
      })),
      createdAt: new Date().toISOString(),
    }

    const optimisticAgentMessage: ChatMessage = {
      id: optimisticAgentId,
      role: 'agent',
      text: '',
      attachments: [],
      createdAt: new Date().toISOString(),
      activities: [],
      activitiesCollapsed: false,
    }

    setMessages((prev) => [...prev, optimisticUserMessage, optimisticAgentMessage])
    resetComposer()
    setStatusMessage(null)
    setLastTicketId(null)
    setIsAgentTyping(true)
    streamConversationIdRef.current = conversationId

    let accumulatedReply = ''

    const abortController = new AbortController()
    streamAbortRef.current = abortController

    void (async () => {
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
            processDefinitionId: selectedProcessDefId ?? undefined,
          }),
        })

        if (!response.ok || !response.body) {
          setMessages((prev) => prev.filter((m) => m.id !== optimisticUserId && m.id !== optimisticAgentId))
          setStatusMessage(`Küldés sikertelen (${response.status})`)
          return
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let streamTerminalEvent = false

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data: ')) continue
            const raw = trimmed.slice(6)
            let event: AgentChatStreamEvent
            try {
              event = JSON.parse(raw) as AgentChatStreamEvent
            } catch {
              continue
            }

            if (event.type === 'meta' && event.conversationId) {
              streamConversationIdRef.current = event.conversationId
              setConversationId(event.conversationId)
              setConversationStatus('active')
            } else if (event.type === 'activity') {
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === optimisticAgentId
                      ? {
                          ...m,
                          activities: upsertActivity(m.activities, event.activity),
                          activitiesCollapsed: false,
                        }
                      : m,
                  ),
                )
              })
            } else if (event.type === 'memory_candidate' && event.candidate) {
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === optimisticAgentId
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
            } else if (event.type === 'token' && typeof event.chunk === 'string') {
              accumulatedReply += event.chunk
              flushSync(() => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === optimisticAgentId ? { ...m, text: m.text + event.chunk! } : m,
                  ),
                )
              })
            } else if (event.type === 'done' && event.conversationId && event.messageId) {
              setConversationId(event.conversationId)
              setConversationStatus('active')
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === optimisticAgentId
                    ? {
                        ...m,
                        id: event.messageId!,
                        ticketRefId: event.ticketRefId ?? m.ticketRefId,
                        activitiesCollapsed: true,
                      }
                    : m,
                ),
              )
              // A Folyamat-választás csak addig marad rögzítve, amíg a Futás
              // ténylegesen el nem indul (§4.4) — utána a chat visszaáll
              // normál beszélgetésre, hogy ne próbálja újraindítani.
              if (accumulatedReply.includes('Futás elindítva a(z)')) {
                setSelectedProcessDefId(null)
              }
              startTransition(() => { void refreshSessions() })
              streamTerminalEvent = true
              break
            } else if (event.type === 'cancelled' && event.conversationId && event.messageId) {
              await reloadConversationMessages(event.conversationId)
              setStatusMessage('Agent válasz megszakítva — részeredmény mentve.')
              streamTerminalEvent = true
              break
            } else if (event.type === 'error') {
              setMessages((prev) => prev.filter((m) => m.id !== optimisticUserId && m.id !== optimisticAgentId))
              setStatusMessage(event.message ?? 'Küldés sikertelen')
              streamTerminalEvent = true
              break
            }
          }
          if (streamTerminalEvent) break
        }

        if (streamTerminalEvent) {
          try {
            await reader.cancel()
          } catch {
            // A stream néha már lezárt állapotban van; ezt nyeljük.
          }
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          return
        }
        setMessages((prev) => prev.filter((m) => m.id !== optimisticUserId && m.id !== optimisticAgentId))
        setStatusMessage(e instanceof Error ? e.message : 'Küldés sikertelen')
      } finally {
        if (streamAbortRef.current === abortController) {
          streamAbortRef.current = null
        }
        streamConversationIdRef.current = null
        setStopPending(false)
        setIsAgentTyping(false)
        filesRef.current?.refresh()
      }
    })()
  }

  const handleCreateTicket = () => {
    if (!canSubmit) return
    const text = input.trim()
    const localAttachments = [...pendingAttachments]
    const executeAfterIso = ticketExecuteAfter
      ? new Date(ticketExecuteAfter).toISOString()
      : undefined
    const maxRuns = ticketMaxRuns ? Number(ticketMaxRuns) : null
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
            recurrence: ticketRecurrence,
            maxRuns: ticketRecurrence === 'none' ? null : maxRuns,
            authorizeRunAs: ticketAuthorizeRunAs,
          })
          if (!res.success) {
            setStatusMessage(res.error)
            return
          }
          resetComposer()
          setStatusMessage(
            ticketRecurrence === 'none'
              ? 'Ütemezett task létrehozva — a worker a megadott időpontban ticketet készít belőle.'
              : 'Ismétlődő ütemezett task létrehozva.',
          )
          return
        }

        const res = await createAgentTaskTicket({
          agentId: agent.id,
          content: text,
          conversationId: conversationId ?? undefined,
          attachmentDocumentIds: documentIds,
          authorizeRunAs: ticketAuthorizeRunAs,
        })
        if (!res.success) {
          setStatusMessage(res.error)
          return
        }
        setLastTicketId(res.data.ticketId)
        resetComposer()
        setStatusMessage('Ticket létrehozva — megjelenik a Kanban táblán.')
      } catch (e) {
        setStatusMessage(e instanceof Error ? e.message : 'Ticket létrehozás sikertelen')
      }
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMenuOpen && slashSkillOptions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashSelectedIndex((index) => Math.min(index + 1, slashSkillOptions.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashSelectedIndex((index) => Math.max(index - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const skill = slashSkillOptions[slashSelectedIndex]
        if (skill) applySkillSlashSelection(skill)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!open || !mounted) return null

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-end justify-center sm:items-center sm:p-4">
      <button
        type="button"
        aria-label="Bezárás"
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
        onClick={onClose}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-chat-title"
        className="relative z-[1] flex h-[100dvh] w-full max-w-5xl flex-col overflow-hidden border border-line bg-card shadow-2xl sm:h-[min(88vh,820px)] sm:rounded-2xl"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
          <button
            type="button"
            onClick={() => setSessionsOpen((v) => !v)}
            className="rounded-xl border border-line px-2.5 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep sm:hidden"
            aria-expanded={sessionsOpen}
          >
            Előzmények
          </button>
          <AgentAvatar name={agent.name} status={agent.status} size="sm" avatarUrl={agent.avatarUrl} />
          <div className="min-w-0 flex-1">
            <h2 id="agent-chat-title" className="truncate font-display text-lg font-semibold">
              {persona.nickname}
            </h2>
            <p className="truncate text-xs text-ink-faint">
              {agent.name}
              {conversationId && (
                <span className="ml-2 rounded-full border border-line px-2 py-0.5">
                  {conversationStatus === 'archived' ? 'archivált szál' : 'aktív szál'}
                </span>
              )}
            </p>
            {connectableUserConnectorsLoading ? (
              <p className="mt-2 text-[11px] text-ink-faint">Kapcsolatok betöltése…</p>
            ) : connectableUserConnectors.length > 0 ? (
              <AgentDelegatedConnectorsBar items={connectableUserConnectors} variant="compact" />
            ) : null}
          </div>
          <div className="hidden items-center gap-2 sm:flex">
            {conversationId && (
              <>
                <button
                  type="button"
                  onClick={handlePromoteConversation}
                  disabled={controlsBusy || conversationStatus === 'archived'}
                  className="rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-honey/50 hover:bg-honey/10 hover:text-honey disabled:opacity-40"
                  title="AI ticket készítése a beszélgetésből"
                >
                  {ticketPending ? 'Elemzés…' : 'Ticket készítése'}
                </button>
                {canDistillSkill && (
                  <>
                    {distillTargets.length > 0 && (
                      <select
                        value={distillTargetSkillId}
                        onChange={(e) => setDistillTargetSkillId(e.target.value)}
                        disabled={controlsBusy}
                        className="max-w-[10rem] rounded-xl border border-line bg-card px-2 py-1.5 text-xs text-ink-soft disabled:opacity-40"
                        title="Desztillálás célja: új skill, vagy az agenthez rendelt skill új verziója"
                      >
                        <option value="">Új skill</option>
                        {distillTargets.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} (új verzió)
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      type="button"
                      onClick={handleDistillSkill}
                      disabled={controlsBusy || messages.length === 0}
                      className="rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-sage/50 hover:bg-sage/10 hover:text-sage disabled:opacity-40"
                      title="Skill draft készítése a beszélgetés módszeréből (proposed — jóváhagyás kell)"
                    >
                      {distillPending ? 'Desztillálás…' : 'Skill desztillálása'}
                    </button>
                  </>
                )}
                {conversationStatus !== 'archived' && (
                  <button
                    type="button"
                    onClick={handleArchiveConversation}
                    disabled={controlsBusy || ticketPending || archivePending}
                    className="rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:bg-coral/10 hover:text-coral-deep disabled:opacity-40"
                    title="Beszélgetés archiválása"
                  >
                    {archivePending ? 'Archiválás…' : 'Archiválás'}
                  </button>
                )}
              </>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-ink-faint transition-colors hover:bg-night-2 hover:text-ink"
            aria-label="Beszélgetés bezárása"
          >
            ✕
          </button>
        </header>

        <div className="relative flex min-h-0 flex-1">
          {sessionsOpen && (
            <button
              type="button"
              aria-label="Előzmények bezárása"
              className="absolute inset-0 z-10 bg-ink/20 sm:hidden"
              onClick={() => setSessionsOpen(false)}
            />
          )}

          <div
            className={`absolute inset-y-0 left-0 z-20 w-[min(88vw,17rem)] border-r border-line shadow-xl transition-transform sm:static sm:z-0 sm:w-56 sm:shrink-0 sm:translate-x-0 sm:shadow-none ${
              sessionsOpen ? 'translate-x-0' : '-translate-x-full sm:translate-x-0'
            }`}
          >
            <AgentChatSessionSidebar
              sessions={sessions}
              activeConversationId={conversationId}
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

          <div className="flex min-w-0 flex-1 flex-col">
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
              {messages.length === 0 && !isAgentTyping ? (
                <div className="flex h-full min-h-[200px] flex-col items-center justify-center text-center">
                  <span className="text-4xl" aria-hidden>
                    {persona.emoji}
                  </span>
                  <p className="mt-4 max-w-sm text-base text-ink-soft">{persona.greeting}</p>
                  <p className="mt-2 text-xs text-ink-faint">
                    Írj üzenetet, csatolj fájlt vagy képet — {persona.nickname} válaszol.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {messages.map((message) => (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      isBusy={controlsBusy}
                      onDeleteContent={handleDeleteMessageContent}
                      onMemoryCandidateUpdate={handleMemoryCandidateUpdate}
                    />
                  ))}
                  {isAgentTyping &&
                    !messages[messages.length - 1]?.text &&
                    !(messages[messages.length - 1]?.activities?.length) && (
                    <TypingIndicator agentName={persona.nickname} />
                  )}
                </div>
              )}
            </div>

            {conversationId && (
              <ConversationFilesPanel
                conversationId={conversationId}
                panelRef={filesRef}
              />
            )}

            <div className="shrink-0 border-t border-line bg-night/40 px-4 py-3 sm:px-5 sm:py-4">
              {conversationStatus === 'archived' && (
                <p className="mb-2 rounded-lg border border-line bg-night-2 px-3 py-2 text-xs text-ink-faint">
                  Archivált szál: olvasható, új üzenet nem fűzhető hozzá.
                </p>
              )}
              {chatProcessDefs.length > 0 && (
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                  <label className="flex min-w-[13rem] flex-1 items-center gap-2">
                    <span className="inline-flex shrink-0 items-center gap-1.5">
                      Folyamat indítása
                      <FieldHelp description="Ha kiválasztasz egy folyamatot, a következő üzenet nem sima chat válasz lesz, hanem ezt a folyamatot indítja el." />
                    </span>
                    <select
                      value={selectedProcessDefId ?? ''}
                      onChange={(e) => setSelectedProcessDefId(e.target.value || null)}
                      disabled={composerDisabled}
                      className="min-w-0 flex-1 rounded-lg border border-line bg-night-2 px-2 py-1.5 text-xs text-ink"
                    >
                      <option value="">— nincs —</option>
                      {chatProcessDefs.map((def) => (
                        <option key={def.id} value={def.id}>
                          {def.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              {selectedProcessDefId && (
                <p className="mb-2 rounded-lg border border-line bg-night-2 px-3 py-2 text-xs text-ink-faint">
                  {(() => {
                    const def = chatProcessDefs.find((d) => d.id === selectedProcessDefId)
                    const requiredSlots = def?.slots.filter((slot) => slot.required) ?? []
                    if (requiredSlots.length === 0) {
                      return 'A kiválasztott Folyamat indul a következő üzeneteddel.'
                    }
                    return `Add meg üzenetben: ${requiredSlots
                      .map((slot) => slot.description ? `${slot.name} (${slot.description})` : slot.name)
                      .join(', ')}`
                  })()}
                </p>
              )}
              {statusMessage && (
            <p className="mb-2 text-xs text-ink-soft">
              {statusMessage}
              {lastTicketId && (
                <>
                  {' '}
                  <Link
                    href={`/control-plane/tickets/${lastTicketId}`}
                    className="font-semibold text-coral hover:underline"
                  >
                    Ticket megnyitása →
                  </Link>
                </>
              )}
            </p>
          )}

          {pendingAttachments.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {pendingAttachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="group relative overflow-hidden rounded-xl border border-line bg-card"
                >
                  {attachment.kind === 'image' && attachment.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={attachment.previewUrl}
                      alt={attachment.file.name}
                      className="h-16 w-16 object-cover"
                    />
                  ) : (
                    <div className="flex h-16 w-28 items-center justify-center px-2 text-xs text-ink-faint">
                      📎 {attachment.file.name}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => removeAttachment(attachment.id)}
                    className="absolute right-1 top-1 rounded-full bg-ink/60 px-1.5 py-0.5 text-[10px] text-card opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label="Csatolmány eltávolítása"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-soft">
            <label className="flex min-w-[13rem] flex-1 items-center gap-2">
              <span className="inline-flex shrink-0 items-center gap-1.5">
                Ütemezés
                <FieldHelp description="Időpont megadásával az üzenetből azonnali küldés helyett ütemezett task lesz." />
              </span>
              <input
                type="datetime-local"
                value={ticketExecuteAfter}
                onChange={(e) => setTicketExecuteAfter(e.target.value)}
                disabled={composerDisabled}
                className="min-w-0 flex-1 rounded-lg border border-line bg-night-2 px-2 py-1.5 text-xs text-ink"
              />
            </label>
            {ticketExecuteAfter && (
              <>
                <label className="flex items-center gap-2">
                  <span className="inline-flex shrink-0 items-center gap-1.5">
                    Ismétlés
                    <FieldHelp description="Megadja, hogy az ütemezett task egyszer fusson vagy ismétlődjön napi/heti/havi ritmusban." />
                  </span>
                  <select
                    value={ticketRecurrence}
                    onChange={(e) => setTicketRecurrence(e.target.value as ScheduledTaskRecurrence)}
                    disabled={composerDisabled}
                    className="rounded-lg border border-line bg-night-2 px-2 py-1.5 text-xs text-ink"
                  >
                    <option value="none">nincs</option>
                    <option value="daily">naponta</option>
                    <option value="weekly">hetente</option>
                    <option value="monthly">havonta</option>
                  </select>
                </label>
                {ticketRecurrence !== 'none' && (
                  <label className="flex items-center gap-2">
                    <span className="inline-flex shrink-0 items-center gap-1.5">
                      Max
                      <FieldHelp description="Az ismétlődő ütemezés legfeljebb ennyi alkalommal fut le, utána leáll." />
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={ticketMaxRuns}
                      onChange={(e) => setTicketMaxRuns(e.target.value)}
                      disabled={composerDisabled}
                      className="w-20 rounded-lg border border-line bg-night-2 px-2 py-1.5 text-xs text-ink"
                    />
                  </label>
                )}
              </>
            )}
            <label className="flex items-center gap-2 rounded-lg border border-line bg-night-2 px-2 py-1.5">
              <input
                type="checkbox"
                checked={ticketAuthorizeRunAs}
                onChange={(e) => setTicketAuthorizeRunAs(e.target.checked)}
                disabled={composerDisabled}
                className="h-3.5 w-3.5 accent-coral"
              />
              <span className="inline-flex items-center gap-1.5">
                Run-as
                <FieldHelp description="Engedélyezi, hogy a ticket végrehajtásakor a rendszer a nevedben futtathasson jogosultságot igénylő lépéseket." />
              </span>
            </label>
          </div>

          <div className="relative flex items-end gap-2 rounded-2xl border border-line bg-card p-2 shadow-sm focus-within:border-coral/40 focus-within:ring-2 focus-within:ring-coral/15">
            {slashMenuOpen && (
              <div
                role="listbox"
                aria-label="Skill slash-parancsok"
                className="absolute bottom-full left-12 z-20 mb-1 max-h-48 w-72 overflow-y-auto rounded-xl border border-line bg-card py-1 shadow-lg"
              >
                {agentSkills.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-ink-faint">
                    Ehhez az agenthez nincs engedélyezett skill hozzárendelve.
                  </p>
                ) : slashSkillOptions.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-ink-faint">Nincs illeszkedő skill.</p>
                ) : (
                  slashSkillOptions.map((skill, index) => (
                    <button
                      key={skill.skillVersionId}
                      type="button"
                      role="option"
                      aria-selected={index === slashSelectedIndex}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applySkillSlashSelection(skill)}
                      className={`flex w-full flex-col px-3 py-2 text-left text-xs transition-colors ${
                        index === slashSelectedIndex
                          ? 'bg-coral/10 text-coral-deep'
                          : 'hover:bg-night-2'
                      }`}
                    >
                      <span className="font-semibold">/{skillNameToSlashToken(skill.name)}</span>
                      <span className="line-clamp-2 text-ink-faint">{skill.description}</span>
                    </button>
                  ))
                )}
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.txt,.md,.csv,.json,.pdf,.doc,.docx"
              className="hidden"
              onChange={(e) => handleFilesSelected(e.target.files)}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={composerDisabled}
              className="shrink-0 rounded-xl p-2.5 text-ink-faint transition-colors hover:bg-night-2 hover:text-ink disabled:opacity-40"
              title="Fájl vagy kép csatolása"
              aria-label="Fájl vagy kép csatolása"
            >
              📎
            </button>

            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                syncInputCursor(e.target)
                setSlashSelectedIndex(0)
              }}
              onSelect={(e) => syncInputCursor(e.currentTarget)}
              onClick={(e) => syncInputCursor(e.currentTarget)}
              onKeyUp={(e) => syncInputCursor(e.currentTarget)}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder={`Üzenet ${persona.nickname}-nak… (/ a skill betöltéséhez)`}
              disabled={composerDisabled}
              className="max-h-36 min-h-[44px] flex-1 resize-none bg-transparent px-1 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none disabled:opacity-50"
            />
            <FieldHelp description="Ide írd az üzenetet. / megnyomására skill választható — a kiválasztott skill a küldéskor bekerül a promptba. Enter küld, Shift+Enter új sor." />

            <button
              type="button"
              onClick={handleCreateTicket}
              disabled={!canSubmit}
              title={ticketExecuteAfter ? 'Ütemezett task létrehozása' : 'Ticket létrehozása a Kanban táblán'}
              className="shrink-0 rounded-xl border border-line px-3 py-2.5 text-xs font-semibold text-ink-soft transition-colors hover:border-honey/50 hover:bg-honey/10 hover:text-honey disabled:opacity-40"
            >
              {ticketPending ? '…' : ticketExecuteAfter ? 'Ütemezés' : 'Ticket'}
            </button>

            {isAgentTyping ? (
              <button
                type="button"
                onClick={handleStop}
                disabled={stopPending}
                className="shrink-0 rounded-xl border border-coral bg-card px-4 py-2.5 text-sm font-semibold text-coral shadow-[0_8px_20px_-10px_rgba(178,58,85,0.35)] transition-transform hover:-translate-y-0.5 hover:bg-coral/10 disabled:opacity-50"
              >
                {stopPending ? 'Megállítás…' : 'Megállítás'}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSubmit}
                className="shrink-0 rounded-xl bg-coral px-4 py-2.5 text-sm font-semibold text-card shadow-[0_8px_20px_-10px_rgba(178,58,85,0.8)] transition-transform hover:-translate-y-0.5 disabled:opacity-40"
              >
                {pending ? '…' : 'Küldés'}
              </button>
            )}
          </div>

          <p className="mt-2 text-center text-[11px] text-ink-faint">
            Enter küld · Shift+Enter új sor · /skill-név = skill betöltése a promptba
          </p>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function AgentChatButton({
  agent,
  className = '',
  compact = false,
  canDistillSkill = false,
}: {
  agent: ChatAgent
  className?: string
  compact?: boolean
  canDistillSkill?: boolean
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen(true)
        }}
        className={
          className ||
          (compact
            ? 'rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep'
            : 'rounded-full bg-sage px-4 py-2 text-sm font-semibold text-card shadow-[0_8px_20px_-12px_rgba(93,138,79,0.7)] transition-transform hover:-translate-y-0.5')
        }
      >
        💬 {compact ? 'Beszél' : 'Beszélgetés'}
      </button>
      <AgentChatPanel
        agent={agent}
        open={open}
        onClose={() => setOpen(false)}
        canDistillSkill={canDistillSkill}
      />
    </>
  )
}
