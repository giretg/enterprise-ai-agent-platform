'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type HtmlPreviewTarget = {
  /** Inline (megjelenítési) URL — disposition=inline. */
  url: string
  /** Attachment letöltési URL. */
  downloadUrl: string
  fileName: string
}

export function HtmlPreviewModal({
  target,
  onClose,
}: {
  target: HtmlPreviewTarget
  onClose: () => void
}) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    closeRef.current?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

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
        className="flex h-full max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
          <h2
            id={titleId}
            className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-ink"
            title={target.fileName}
          >
            {target.fileName}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            <a
              href={target.downloadUrl}
              download={target.fileName}
              className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep"
            >
              Letöltés
            </a>
            <a
              href={target.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep"
            >
              Megnyitom új ablakban
            </a>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Bezárás"
              className="flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none text-ink-soft transition-colors hover:bg-line/40 hover:text-ink"
            >
              ×
            </button>
          </div>
        </div>
        <iframe
          title={target.fileName}
          src={target.url}
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 bg-white"
        />
      </div>
    </div>,
    document.body,
  )
}
