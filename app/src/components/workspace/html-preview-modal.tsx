'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  loadWorkspaceHtmlPreview,
  WorkspaceHtmlPreviewError,
  WORKSPACE_HTML_PREVIEW_GATEWAY_MESSAGE,
} from '@/lib/load-workspace-html-preview'
import {
  INLINE_HTML_CONTENT_TYPE,
  htmlWithInlinePreviewCsp,
} from '@/lib/workspace-inline-html-headers'

export type HtmlPreviewTarget = {
  /** Inline (megjelenítési) URL — disposition=inline. */
  url: string
  /** Attachment letöltési URL. */
  downloadUrl: string
  fileName: string
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; objectUrl: string; html: string }
  | { status: 'error'; message: string }

function downloadLoadedHtml(fileName: string, html: string) {
  const blob = new Blob([html], { type: INLINE_HTML_CONTENT_TYPE })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
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
  const [retryKey, setRetryKey] = useState(0)
  const requestId = `${target.url}#${retryKey}`
  const [result, setResult] = useState<{ id: string; state: LoadState } | null>(null)
  const loadState: LoadState = result?.id === requestId ? result.state : { status: 'loading' }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client portal mount gate
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

  useEffect(() => {
    const controller = new AbortController()
    let createdUrl: string | null = null

    void loadWorkspaceHtmlPreview(target.url, { signal: controller.signal }).then(
      (html) => {
        const objectUrl = URL.createObjectURL(
          new Blob([htmlWithInlinePreviewCsp(html)], { type: INLINE_HTML_CONTENT_TYPE }),
        )
        if (controller.signal.aborted) {
          URL.revokeObjectURL(objectUrl)
          return
        }
        createdUrl = objectUrl
        setResult({ id: requestId, state: { status: 'ready', objectUrl, html } })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        const message =
          error instanceof WorkspaceHtmlPreviewError
            ? error.message
            : WORKSPACE_HTML_PREVIEW_GATEWAY_MESSAGE
        setResult({ id: requestId, state: { status: 'error', message } })
      },
    )

    return () => {
      controller.abort()
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [requestId, target.url])

  if (!mounted) return null

  const ready = loadState.status === 'ready' ? loadState : null

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
            <button
              type="button"
              disabled={!ready}
              onClick={() => ready && downloadLoadedHtml(target.fileName, ready.html)}
              className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep disabled:opacity-40"
            >
              Letöltés
            </button>
            <button
              type="button"
              disabled={!ready}
              onClick={() => ready && window.open(ready.objectUrl, '_blank', 'noopener,noreferrer')}
              className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep disabled:opacity-40"
            >
              Megnyitom új ablakban
            </button>
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
        {loadState.status === 'ready' ? (
          <iframe
            title={target.fileName}
            src={loadState.objectUrl}
            sandbox=""
            referrerPolicy="no-referrer"
            className="min-h-0 w-full flex-1 bg-white"
          />
        ) : (
          <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            {loadState.status === 'loading' ? (
              <p className="text-sm text-ink-soft">Riport betöltése…</p>
            ) : (
              <>
                <p className="text-sm text-coral" role="alert">
                  {loadState.message}
                </p>
                <button
                  type="button"
                  onClick={() => setRetryKey((key) => key + 1)}
                  className="rounded-full border border-coral/40 bg-card px-4 py-2 text-xs font-semibold text-coral transition-colors hover:bg-coral/10"
                >
                  Újra
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
