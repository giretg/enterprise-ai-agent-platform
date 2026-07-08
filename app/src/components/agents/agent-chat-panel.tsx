'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { createPortal, flushSync } from 'react-dom'
import {
  archiveConversation,
  createAgentTaskTicket,
  createScheduledAgentTask,
  deleteMessageContent,
  listAgentChatSessions,
  loadAgentChatMessages,
  promoteConversationWithAi,
  uploadDocument,
} from '@/app/actions/platform'
import { listChatTriggerableProcessDefinitions } from '@/app/actions/process'
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

type AgentChatStreamEvent =
  | { type: 'activity'; activity: AgentActivity }
  | { type: 'token'; chunk: string }
  | { type: 'done'; conversationId: string; messageId: string; ticketRefId?: string | null }
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

function MessageBubble({
  message,
  isBusy,
  onDeleteContent,
}: {
  message: ChatMessage
  isBusy: boolean
  onDeleteContent: (messageId: string) => void
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

export type ChatAgent = {
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
}: {
  agent: ChatAgent
  open: boolean
  onClose: () => void
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const filesRef = useRef<ConversationFilesPanelHandle>(null)
  const [mounted, setMounted] = useState(false)

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
  const controlsBusy = pending || ticketPending || archivePending || isAgentTyping
  const composerDisabled = controlsBusy || conversationStatus === 'archived'

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

    let accumulatedReply = ''

    void (async () => {
      try {
        const documentIds = localAttachments.length > 0 ? await uploadAttachments(localAttachments) : []

        const response = await fetch('/api/v1/agent-chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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

            if (event.type === 'activity') {
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
        setMessages((prev) => prev.filter((m) => m.id !== optimisticUserId && m.id !== optimisticAgentId))
        setStatusMessage(e instanceof Error ? e.message : 'Küldés sikertelen')
      } finally {
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

          <div className="flex items-end gap-2 rounded-2xl border border-line bg-card p-2 shadow-sm focus-within:border-coral/40 focus-within:ring-2 focus-within:ring-coral/15">
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
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder={`Üzenet ${persona.nickname}-nak…`}
              disabled={composerDisabled}
              className="max-h-36 min-h-[44px] flex-1 resize-none bg-transparent px-1 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none disabled:opacity-50"
            />
            <FieldHelp description="Ide írd az üzenetet az agentnek. Enterrel küldöd, Shift+Enterrel új sort szúrsz be." />

            <button
              type="button"
              onClick={handleCreateTicket}
              disabled={!canSubmit}
              title={ticketExecuteAfter ? 'Ütemezett task létrehozása' : 'Ticket létrehozása a Kanban táblán'}
              className="shrink-0 rounded-xl border border-line px-3 py-2.5 text-xs font-semibold text-ink-soft transition-colors hover:border-honey/50 hover:bg-honey/10 hover:text-honey disabled:opacity-40"
            >
              {ticketPending ? '…' : ticketExecuteAfter ? 'Ütemezés' : 'Ticket'}
            </button>

            <button
              type="button"
              onClick={handleSend}
              disabled={!canSubmit}
              className="shrink-0 rounded-xl bg-coral px-4 py-2.5 text-sm font-semibold text-card shadow-[0_8px_20px_-10px_rgba(178,58,85,0.8)] transition-transform hover:-translate-y-0.5 disabled:opacity-40"
            >
              {pending ? '…' : 'Küldés'}
            </button>
          </div>

          <p className="mt-2 text-center text-[11px] text-ink-faint">
            Enter küld · Shift+Enter új sor · Ticket = feladat a Kanban táblán
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
}: {
  agent: ChatAgent
  className?: string
  compact?: boolean
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
      <AgentChatPanel agent={agent} open={open} onClose={() => setOpen(false)} />
    </>
  )
}
