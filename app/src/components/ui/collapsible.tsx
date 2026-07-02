'use client'

import { useId, useState, type ReactNode } from 'react'

export function Collapsible({
  title,
  subtitle,
  defaultOpen = false,
  children,
}: {
  title: string
  subtitle?: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-night-2/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-night-2"
      >
        <span className="min-w-0">
          <span className="block font-display text-base font-semibold tracking-tight text-ink">
            {title}
          </span>
          {subtitle && <span className="mt-0.5 block text-xs text-ink-faint">{subtitle}</span>}
        </span>
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className={`h-3 w-3 shrink-0 text-ink-soft transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div id={panelId} className="border-t border-line px-4 py-4">
          {children}
        </div>
      )}
    </div>
  )
}
