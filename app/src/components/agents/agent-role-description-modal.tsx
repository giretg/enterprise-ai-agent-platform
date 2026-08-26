'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChatMarkdown } from '@/components/chat/chat-markdown'

function DocumentIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="5" y="3" width="14" height="18" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M8 8h8M8 12h8M8 16h5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}

function AgentRoleDescriptionModal({
  nickname,
  description,
  onClose,
}: {
  nickname: string
  description: string
  onClose: () => void
}) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client portal mount gate
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) return
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mounted, onClose])

  if (!mounted) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-ink/50 p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[min(32rem,90vh)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Munkaköri leírás
            </p>
            <h2 id={titleId} className="mt-0.5 font-display text-lg font-bold leading-tight text-ink">
              {nickname}
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-faint hover:bg-night-2 hover:text-ink"
            aria-label="Bezárás"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {description.trim() ? (
            <ChatMarkdown content={description} variant="agent" />
          ) : (
            <p className="text-sm italic text-ink-faint">Még nincs leírva, miben segít.</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Fejléc-ikon: a bemutatkozó mondat mellett nyitja a teljes munkaköri leírást. */
export function AgentRoleDescriptionButton({
  nickname,
  description,
  compact = false,
}: {
  nickname: string
  description: string
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  if (!description.trim()) return null

  return (
    <>
      <button
        type="button"
        title="Munkaköri leírás"
        aria-label="Munkaköri leírás"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setOpen(true)
        }}
        className={`grid shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-night-2 hover:text-ink ${
          compact ? 'h-6 w-6' : 'h-8 w-8'
        }`}
      >
        <DocumentIcon className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
      </button>
      {open ? (
        <AgentRoleDescriptionModal
          nickname={nickname}
          description={description}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}
