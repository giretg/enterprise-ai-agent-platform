'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { LoadingOverlay } from '@/components/ui/spinner'

/**
 * Helyben nyíló ablak a varázslóban (#957): egy másik admin-oldal (kapcsolat,
 * betanult módszer, saját fiók) iframe-ben, keret nélkül — a varázsló a
 * háttérben marad, bezáráskor a hívó frissíti a listákat.
 */
export function InlinePageDialog({
  href,
  title,
  onClose,
}: {
  href: string
  title: string
  onClose: () => void
}) {
  const t = useTranslations('AgentCreate')
  const [loaded, setLoaded] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-2 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="flex h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{title}</p>
            <p className="text-xs text-ink-faint">{t('inlineDialogHint')}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-full bg-coral px-4 py-1.5 text-sm font-semibold text-white"
          >
            {t('inlineDialogClose')}
          </button>
        </div>
        <div className="relative min-h-0 flex-1">
          {!loaded ? <LoadingOverlay /> : null}
          <iframe
            title={title}
            src={href}
            className="h-full w-full border-0"
            onLoad={() => setLoaded(true)}
          />
        </div>
      </div>
    </div>
  )
}
