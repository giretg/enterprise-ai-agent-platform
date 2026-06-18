'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import {
  createAgentTaskTicket,
  createScheduledAgentTask,
  listAgentChatSessions,
  loadAgentChatMessages,
  sendAgentMessage,
  uploadDocument,
} from '@/app/actions/platform'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { ChatMarkdown, TypingIndicator } from '@/components/chat/chat-markdown'
import { AgentChatSessionSidebar, type ChatSession } from '@/components/chat/chat-session-sidebar'
import { personaFor } from '@/lib/agent-persona'

type PendingAttachment = {
  id: string
  file: File
  previewUrl: string | null
  kind: 'text' | 'image'
}

type ChatMessage = {
  id: string
  role: 'user' | 'agent' | 'system'
  text: string
  attachments: Array<{
    documentId: string
    filename: string
    kind: 'text' | 'image'
    previewDataUrl?: string | null
  }>
  createdAt: string
}

type ScheduledTaskRecurrence = 'none' | 'daily' | 'weekly' | 'monthly'

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

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'

  return (
    <div className={`flex animate-rise ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 shadow-sm ${
          isUser
            ? 'rounded-br-md bg-coral text-card'
            : 'rounded-bl-md border border-line bg-card text-ink-soft'
        }`}
      >
        {message.text && (
          isUser ? (
            <div className="text-sm [&_a]:text-card [&_a]:underline [&_strong]:text-card">
              <ChatMarkdown content={message.text} variant="user" />
            </div>
          ) : (
            <ChatMarkdown content={message.text} variant="agent" />
          )
        )}
        {message.attachments.length > 0 && (
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
      </div>
    </div>
  )
}

export function AgentChatPanel({
  agent,
  open,
  onClose,
}: {
  agent: { id: string; name: string; status?: string }
  open: boolean
  onClose: () => void
}) {
  const persona = personaFor(agent.name)
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
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [ticketPending, startTicketTransition] = useTransition()
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
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
      const res = await listAgentChatSessions({ agentId: agent.id })
      if (res.success) setSessions(res.data.sessions)
    } finally {
      setSessionsLoading(false)
    }
  }, [agent.id])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => void refreshSessions(), 0)
    return () => window.clearTimeout(timer)
  }, [open, refreshSessions])

  const startNewSession = useCallback(() => {
    if (isAgentTyping) return
    setConversationId(null)
    setMessages([])
    setStatusMessage(null)
    setLastTicketId(null)
    setSessionsOpen(false)
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

      const res = await loadAgentChatMessages({ conversationId: id, agentId: agent.id })
      if (res.success) {
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
    [agent.id, conversationId, isAgentTyping],
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
    (input.trim().length > 0 || pendingAttachments.length > 0) &&
    !pending &&
    !ticketPending &&
    !isAgentTyping

  const handleSend = () => {
    if (!canSubmit) return
    const text = input.trim()
    const localAttachments = [...pendingAttachments]
    const optimisticId = `optimistic-user-${Date.now()}`

    const optimisticMessage: ChatMessage = {
      id: optimisticId,
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

    setMessages((prev) => [...prev, optimisticMessage])
    resetComposer()
    setStatusMessage(null)
    setLastTicketId(null)
    setIsAgentTyping(true)

    startTransition(async () => {
      try {
        const documentIds = localAttachments.length > 0 ? await uploadAttachments(localAttachments) : []
        const res = await sendAgentMessage({
          agentId: agent.id,
          content: text,
          conversationId: conversationId ?? undefined,
          attachmentDocumentIds: documentIds,
        })

        if (!res.success) {
          setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
          setStatusMessage(res.error)
          return
        }

        setConversationId(res.data.conversationId)

        const loaded = await loadAgentChatMessages({
          conversationId: res.data.conversationId,
          agentId: agent.id,
        })
        if (loaded.success) {
          setMessages(
            loaded.data.messages.map((m) => ({
              ...m,
              createdAt: new Date(m.createdAt).toISOString(),
            })),
          )
        } else {
          setMessages((prev) => [
            ...prev.filter((m) => m.id !== optimisticId),
            {
              id: `user-${res.data.conversationId}-${Date.now()}`,
              role: 'user',
              text: text || '(csatolmányok)',
              attachments: localAttachments.map((a, i) => ({
                documentId: documentIds[i] ?? a.id,
                filename: a.file.name,
                kind: a.kind,
                previewDataUrl: a.previewUrl,
              })),
              createdAt: new Date().toISOString(),
            },
            {
              id: res.data.messageId,
              role: 'agent',
              text: res.data.reply,
              attachments: [],
              createdAt: new Date().toISOString(),
            },
          ])
        }

        void refreshSessions()
      } catch (e) {
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId))
        setStatusMessage(e instanceof Error ? e.message : 'Küldés sikertelen')
      } finally {
        setIsAgentTyping(false)
      }
    })
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
          <AgentAvatar name={agent.name} status={agent.status} size="sm" />
          <div className="min-w-0 flex-1">
            <h2 id="agent-chat-title" className="truncate font-display text-lg font-semibold">
              {persona.nickname}
            </h2>
            <p className="truncate text-xs text-ink-faint">{agent.name}</p>
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
              loading={sessionsLoading}
              isBusy={isAgentTyping || pending}
              onSelect={selectSession}
              onNewChat={startNewSession}
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
                    <MessageBubble key={message.id} message={message} />
                  ))}
                  {isAgentTyping && <TypingIndicator agentName={persona.nickname} />}
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-line bg-night/40 px-4 py-3 sm:px-5 sm:py-4">
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
              <span className="shrink-0">Ütemezés</span>
              <input
                type="datetime-local"
                value={ticketExecuteAfter}
                onChange={(e) => setTicketExecuteAfter(e.target.value)}
                disabled={pending || ticketPending || isAgentTyping}
                className="min-w-0 flex-1 rounded-lg border border-line bg-night-2 px-2 py-1.5 text-xs text-ink"
              />
            </label>
            {ticketExecuteAfter && (
              <>
                <label className="flex items-center gap-2">
                  <span className="shrink-0">Ismétlés</span>
                  <select
                    value={ticketRecurrence}
                    onChange={(e) => setTicketRecurrence(e.target.value as ScheduledTaskRecurrence)}
                    disabled={pending || ticketPending || isAgentTyping}
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
                    <span className="shrink-0">Max</span>
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={ticketMaxRuns}
                      onChange={(e) => setTicketMaxRuns(e.target.value)}
                      disabled={pending || ticketPending || isAgentTyping}
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
                disabled={pending || ticketPending || isAgentTyping}
                className="h-3.5 w-3.5 accent-coral"
              />
              <span>Run-as</span>
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
              disabled={pending || ticketPending || isAgentTyping}
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
              disabled={pending || ticketPending || isAgentTyping}
              className="max-h-36 min-h-[44px] flex-1 resize-none bg-transparent px-1 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none disabled:opacity-50"
            />

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
  agent: { id: string; name: string; status?: string }
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
