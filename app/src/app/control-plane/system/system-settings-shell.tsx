'use client'

import { useState, type ReactNode } from 'react'

export type SettingsSection = {
  id: string
  label: string
  description?: string
  content: ReactNode
}

/**
 * Bal oldali témaválasztó: egyszerre egy szekció látszik.
 */
export function SettingsSectionShell({
  sections,
  ariaLabel = 'Beállítási témák',
  navHeading = 'Témák',
  initialId,
}: {
  sections: SettingsSection[]
  ariaLabel?: string
  navHeading?: string
  initialId?: string
}) {
  const fallbackId =
    (initialId && sections.some((section) => section.id === initialId) ? initialId : null) ??
    sections[0]?.id ??
    ''
  const [activeId, setActiveId] = useState(fallbackId)

  const active =
    sections.find((section) => section.id === activeId) ??
    sections.find((section) => section.id === fallbackId) ??
    sections[0]
  if (!active) return null

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <nav
        aria-label={ariaLabel}
        className="shrink-0 rounded-xl border border-line/60 bg-panel/40 p-2 lg:sticky lg:top-4 lg:w-56"
      >
        <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          {navHeading}
        </p>
        <div className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
          {sections.map((section) => {
            const selected = section.id === active.id
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveId(section.id)}
                className={`w-full break-words rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  selected
                    ? 'bg-coral/15 font-medium text-coral-deep'
                    : 'text-ink-soft hover:bg-night/30 hover:text-ink'
                }`}
              >
                {section.label}
              </button>
            )
          })}
        </div>
      </nav>

      <div className="min-w-0 flex-1 space-y-3">
        {active.description ? (
          <p className="text-sm text-ink-soft">{active.description}</p>
        ) : null}
        {active.content}
      </div>
    </div>
  )
}
