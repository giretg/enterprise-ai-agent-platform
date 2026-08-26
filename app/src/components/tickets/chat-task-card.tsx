'use client'

import Link from 'next/link'
import {
  formatChatTaskCardMeta,
  type ChatTaskCardView,
} from '@/lib/work-traceability'

export function ChatTaskCard({
  card,
  onOpen,
}: {
  card: ChatTaskCardView
  onOpen?: () => void
}) {
  const meta = formatChatTaskCardMeta(card)

  return (
    <Link
      href={card.href}
      onClick={onOpen}
      className="mt-2 block w-full max-w-md overflow-hidden rounded-xl border border-line bg-card text-left shadow-[0_1px_2px_-1px_rgba(70,45,30,0.12)] transition hover:border-coral/45 hover:shadow-[0_12px_26px_-18px_rgba(90,55,35,0.6)]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line/70 bg-night-2/60 px-3 py-1.5">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-faint">
          Feladat {card.shortRef}
        </span>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            card.live
              ? 'text-sky animate-activity-run-row'
              : card.state === 'done'
                ? 'bg-sage/15 text-sage'
                : card.state === 'awaiting_human' || card.state === 'needs_info'
                  ? 'bg-coral/12 text-coral-deep'
                  : 'bg-ink/[0.05] text-ink-soft'
          }`}
        >
          {card.live ? (
            <span className="relative flex h-1.5 w-1.5" aria-hidden>
              <span className="absolute inline-flex h-full w-full rounded-full bg-sky opacity-60 animate-activity-run-dot" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-sky" />
            </span>
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
          )}
          {card.stateLabel}
        </span>
      </div>
      <div className="px-3 py-2.5">
        <p className="line-clamp-2 text-[13px] font-semibold leading-snug text-ink">{card.title}</p>
        {meta ? <p className="mt-1.5 text-[11px] leading-snug text-ink-faint">{meta}</p> : null}
      </div>
    </Link>
  )
}

export function ChatTaskCardSkeleton() {
  return (
    <div className="mt-2 w-full max-w-md overflow-hidden rounded-xl border border-line bg-card px-3 py-2.5">
      <p className="text-[11px] font-semibold text-ink-faint">Feladat betöltése…</p>
    </div>
  )
}
