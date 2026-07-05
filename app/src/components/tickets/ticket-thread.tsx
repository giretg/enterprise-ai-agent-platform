'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'
import { addTicketComment, uploadTicketCommentAttachment } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'
import { ChatMarkdown } from '@/components/chat/chat-markdown'
import { formatTicketDateTime } from '@/lib/ticket-display'

type ThreadAttachment = {
  id: string
  filename: string
  mimeType: string | null
  byteSize: number | null
  kind: 'file' | 'screenshot'
  document: {
    id: string
    extractedText: string | null
  }
}

export type TicketThreadComment = {
  id: string
  seq: number
  kind: 'human_comment' | 'agent_answer' | 'agent_progress' | 'system_note'
  authorType: 'human' | 'agent' | 'system'
  authorDisplayName: string | null
  body: string
  structured: unknown
  createdAt: string | Date
  attachments: ThreadAttachment[]
}

type DraftAttachment = {
  documentId: string
  filename: string
  mimeType: string | null
  kind: 'file' | 'screenshot'
  byteSize?: number | null
  previewUrl?: string
}

function imageDataUrl(attachment: ThreadAttachment): string | null {
  const text = attachment.document.extractedText
  const match = text?.match(/^\[image:([^\]]+)\]([\s\S]+)$/)
  if (!match) return null
  return `data:${match[1]};base64,${match[2]}`
}

function structuredRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function formatBytes(value: number | null | undefined): string | null {
  if (!value) return null
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function AttachmentList({ attachments }: { attachments: ThreadAttachment[] }) {
  if (attachments.length === 0) return null
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {attachments.map((attachment) => {
        const src = imageDataUrl(attachment)
        return (
          <div key={attachment.id} className="rounded-lg border border-line bg-night-2/70 p-2">
            {src && (
              <img
                src={src}
                alt={attachment.filename}
                className="mb-2 max-h-48 w-full rounded-md object-contain"
              />
            )}
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="truncate text-ink">{attachment.filename}</span>
              <span className="shrink-0 text-ink-faint">
                {formatBytes(attachment.byteSize) ?? attachment.mimeType ?? attachment.kind}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function TicketCommentComposer({
  ticketId,
  canHandBack,
}: {
  ticketId: string
  canHandBack: boolean
}) {
  const router = useRouter()
  const [body, setBody] = useState('')
  const [drafts, setDrafts] = useState<DraftAttachment[]>([])
  const [pending, startTransition] = useTransition()
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const uploadFiles = async (files: File[], kind: 'file' | 'screenshot' = 'file') => {
    if (drafts.length + files.length > 8) {
      setMessage({ tone: 'err', text: 'Legfeljebb 8 csatolmány adható egy kommenthez.' })
      return
    }
    setUploading(true)
    setMessage(null)
    try {
      const next: DraftAttachment[] = []
      for (const file of files) {
        if (file.size > 25 * 1024 * 1024) {
          throw new Error(`${file.name}: legfeljebb 25 MB lehet`)
        }
        const formData = new FormData()
        formData.set('ticketId', ticketId)
        formData.set('kind', kind)
        formData.set('file', file)
        const res = await uploadTicketCommentAttachment(formData)
        if (!res.success) throw new Error(res.error)
        next.push({
          ...res.data,
          kind: res.data.kind === 'screenshot' ? 'screenshot' : 'file',
          previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
        })
      }
      setDrafts((current) => [...current, ...next])
    } catch (error) {
      setMessage({ tone: 'err', text: error instanceof Error ? error.message : 'Feltöltés sikertelen' })
    } finally {
      setUploading(false)
    }
  }

  const submit = (handBackToAgent: boolean) => {
    setMessage(null)
    if (!body.trim() && drafts.length === 0) {
      setMessage({ tone: 'err', text: 'Komment vagy csatolmány megadása kötelező.' })
      return
    }
    startTransition(async () => {
      const res = await addTicketComment({
        ticketId,
        body,
        attachmentDocumentIds: drafts.map((draft) => draft.documentId),
        handBackToAgent,
      })
      if (!res.success) {
        setMessage({ tone: 'err', text: res.error })
        return
      }
      setBody('')
      setDrafts([])
      const warning = typeof res.data.warning === 'string' ? res.data.warning : null
      setMessage({ tone: warning ? 'err' : 'ok', text: warning ?? 'Komment mentve.' })
      router.refresh()
    })
  }

  const disabled = pending || uploading

  return (
    <div className="border-t border-line pt-4">
      {message && (
        <p className={`mb-3 text-sm ${message.tone === 'ok' ? 'text-sage' : 'text-coral'}`}>
          {message.text}
        </p>
      )}
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onPaste={(event) => {
          const images = [...event.clipboardData.items]
            .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file))
            .map((file) => new File([file], `screenshot-${Date.now()}.png`, { type: file.type || 'image/png' }))
          if (images.length > 0) void uploadFiles(images, 'screenshot')
        }}
        maxLength={16 * 1024}
        rows={4}
        className="w-full rounded-lg border border-line bg-night-2 p-3 text-sm text-ink"
        placeholder="Írj kommentet vagy pontosítást..."
      />
      {drafts.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {drafts.map((draft) => (
            <span
              key={draft.documentId}
              className="inline-flex max-w-full items-center gap-2 rounded-lg border border-line bg-night-2 px-3 py-1.5 text-xs text-ink-soft"
            >
              {draft.previewUrl && (
                <img src={draft.previewUrl} alt="" className="h-6 w-6 rounded object-cover" />
              )}
              <span className="truncate">{draft.filename}</span>
              <button
                type="button"
                className="text-ink-faint hover:text-coral"
                onClick={() => setDrafts((current) => current.filter((item) => item.documentId !== draft.documentId))}
              >
                x
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink-soft hover:border-sky/50 hover:text-sky">
          Csatolás
          <input
            type="file"
            multiple
            className="sr-only"
            disabled={disabled}
            onChange={(event) => {
              const files = [...(event.target.files ?? [])]
              event.target.value = ''
              if (files.length > 0) void uploadFiles(files)
            }}
          />
        </label>
        <button
          type="button"
          disabled={disabled}
          onClick={() => submit(false)}
          className="rounded-lg bg-sky/20 px-4 py-2 text-sm font-semibold text-sky hover:bg-sky/30 disabled:opacity-50"
        >
          Komment hozzáadása
        </button>
        {canHandBack && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => submit(true)}
            className="rounded-lg bg-honey/20 px-4 py-2 text-sm font-semibold text-honey hover:bg-honey/30 disabled:opacity-50"
          >
            Pontosítás + visszaadás az agentnek
          </button>
        )}
      </div>
    </div>
  )
}

export function TicketThread({
  ticket,
  comments,
}: {
  ticket: {
    id: string
    title: string
    state: string
    agentId?: string | null
    processInstanceId?: string | null
    taskDescription?: string | null
    createdAt: string | Date
    creator?: { label: string } | null
  }
  comments: TicketThreadComment[]
}) {
  const originalTask = ticket.taskDescription?.trim() || ticket.title
  const canHandBack = Boolean(
    ticket.agentId && !ticket.processInstanceId && ['done', 'awaiting_human'].includes(ticket.state),
  )
  const sorted = useMemo(() => [...comments].sort((a, b) => a.seq - b.seq), [comments])

  return (
    <Card title="Ticket-szál" className="mt-6">
      <div className="space-y-4">
        <article className="rounded-lg border border-line bg-night-2/60 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-faint">
            <Badge tone="neutral">Feladat</Badge>
            <span>{ticket.creator?.label ?? 'Felhasználó'}</span>
            <span>{formatTicketDateTime(ticket.createdAt)}</span>
          </div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{originalTask}</p>
        </article>

        {sorted.map((comment) => {
          const structured = structuredRecord(comment.structured)
          const isAgent = comment.kind === 'agent_answer'
          const isSystem = comment.kind === 'system_note'
          return (
            <article
              key={comment.id}
              className={
                isSystem
                  ? 'rounded-lg border border-line/70 bg-night-2/35 px-4 py-3 text-sm text-ink-faint'
                  : isAgent
                    ? 'rounded-lg border border-sky/25 bg-sky/5 p-4'
                    : 'rounded-lg border border-line bg-card p-4'
              }
            >
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-faint">
                <Badge tone={isAgent ? 'success' : isSystem ? 'neutral' : 'warning'}>
                  {isAgent ? 'AI agent' : isSystem ? 'Rendszer' : 'Ember'}
                </Badge>
                <span>{comment.authorDisplayName ?? (isAgent ? 'Agent' : isSystem ? 'Rendszer' : 'Felhasználó')}</span>
                <span>{formatTicketDateTime(comment.createdAt)}</span>
                {typeof structured.confidence === 'string' && (
                  <Badge tone={structured.confidence === 'high' ? 'success' : 'warning'}>
                    {structured.confidence}
                  </Badge>
                )}
                {typeof structured.model === 'string' && <Badge tone="neutral">{structured.model}</Badge>}
              </div>
              {isAgent ? (
                <ChatMarkdown content={comment.body} variant="agent" />
              ) : (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">{comment.body}</p>
              )}
              <AttachmentList attachments={comment.attachments} />
            </article>
          )
        })}

        <TicketCommentComposer ticketId={ticket.id} canHandBack={canHandBack} />
      </div>
    </Card>
  )
}
