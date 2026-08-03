'use client'

import { type RefObject, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * „Feladat létrehozva — kezdődjön a feldolgozás?" megerősítő modál.
 *
 * Közös komponens: a normál feladat-űrlap és a korlátozott feladatkörű agent
 * (#199) feladat-indítója is ezt használja, hogy a létrehozás utáni élmény
 * mindkét úton azonos legyen.
 *
 * Portal: a Munkatársak kártyán `hover:-translate-y-1` van — a transform
 * containing blockot csinál a `fixed` overlaynek, ezért body-ra portalozunk.
 */
export type DispatchPrompt = {
  ticketId: string
  title: string
} | null

function PlayIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

export function TicketDispatchPromptModal({
  prompt,
  pending,
  message,
  returnFocusRef,
  onStart,
  onLater,
}: {
  prompt: NonNullable<DispatchPrompt>
  pending: boolean
  message: string | null
  returnFocusRef: RefObject<HTMLButtonElement | null>
  onStart: () => void
  onLater: () => void
}) {
  const titleId = useId()
  const descriptionId = useId()
  const laterButtonRef = useRef<HTMLButtonElement>(null)
  const startButtonRef = useRef<HTMLButtonElement>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) return
    const returnFocusTarget = returnFocusRef.current
    startButtonRef.current?.focus()
    return () => returnFocusTarget?.focus()
  }, [mounted, returnFocusRef])

  if (!mounted) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={() => !pending && onLater()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="atelier-card w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !pending) {
            event.preventDefault()
            onLater()
            return
          }
          if (event.key !== 'Tab') return
          if (event.shiftKey && document.activeElement === laterButtonRef.current) {
            event.preventDefault()
            startButtonRef.current?.focus()
          } else if (!event.shiftKey && document.activeElement === startButtonRef.current) {
            event.preventDefault()
            laterButtonRef.current?.focus()
          }
        }}
      >
        <h3 id={titleId} className="font-display text-lg font-semibold">
          Feladat létrehozva
        </h3>
        <p id={descriptionId} className="mt-2 text-sm text-ink-soft">
          <span className="font-medium text-ink">«{prompt.title}»</span> — kezdődjön a feladat
          feldolgozása?
        </p>
        {message && (
          <p className="mt-3 rounded-lg border border-honey/40 bg-honey/10 px-3 py-2 text-sm text-honey">
            {message}
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            ref={laterButtonRef}
            type="button"
            disabled={pending}
            onClick={onLater}
            className="rounded-lg border border-line px-4 py-2 text-sm text-ink-soft transition hover:bg-night-2 disabled:opacity-50"
          >
            Később
          </button>
          <button
            ref={startButtonRef}
            type="button"
            disabled={pending}
            onClick={onStart}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent/90 disabled:opacity-50"
          >
            <PlayIcon className="h-4 w-4" />
            {pending ? 'Indítás…' : 'Indítás'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
