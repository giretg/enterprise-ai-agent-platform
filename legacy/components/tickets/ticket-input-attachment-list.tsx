import { ticketInputAttachmentDownloadUrl } from '@/lib/ticket-input-attachments'
import type { TicketInputAttachmentView } from '@/domain/ticket/ticket-input-attachment-service'

export type { TicketInputAttachmentView }

function formatBytes(value: number | null): string | null {
  if (!value) return null
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function TicketInputAttachmentList({
  ticketId,
  attachments,
}: {
  ticketId: string
  attachments: TicketInputAttachmentView[]
}) {
  if (attachments.length === 0) return null
  return (
    <div className="mt-3 border-t border-line/70 pt-3">
      <p className="mb-2 text-xs font-medium text-ink-faint">Bemeneti csatolmányok</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {attachments.map((attachment) => {
          const sizeLabel = formatBytes(attachment.byteSize)
          return (
            <a
              key={attachment.id}
              href={ticketInputAttachmentDownloadUrl(ticketId, attachment.id)}
              className="flex items-center justify-between gap-3 rounded-lg border border-line bg-card px-3 py-2 text-xs hover:border-sky/50"
            >
              <span className="truncate text-ink">{attachment.filename}</span>
              <span className="shrink-0 text-sky">
                Letöltés
                {sizeLabel ? ` · ${sizeLabel}` : ''}
              </span>
            </a>
          )
        })}
      </div>
    </div>
  )
}
