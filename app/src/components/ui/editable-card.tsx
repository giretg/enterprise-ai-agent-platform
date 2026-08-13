'use client'

import { useState, type ReactNode } from 'react'

/**
 * Egy téma = EGY doboz.
 *
 * MIÉRT: korábban ugyanaz az információ két helyen élt — egy „megnéző" dobozban
 * és külön egy „szerkesztő" dobozban (pl. két munkaköri leírás). A felhasználó
 * ilyenkor nem tudja, melyik az igazi, és görgetnie kell, hogy összepárosítsa a
 * kettőt. Itt a nézet és a szerkesztés ugyanabban a keretben váltakozik: aki csak
 * nézni jogosult, a nézetet látja; az admin egy gombnyomással ugyanott átvált
 * szerkesztésre.
 */
export function EditableCard({
  title,
  subtitle,
  canEdit = false,
  view,
  edit,
  editLabel = 'Szerkesztés',
  doneLabel = 'Kész',
  className = '',
}: {
  title: string
  subtitle?: string
  /** Csak akkor jelenik meg a szerkesztés gomb, ha van joga hozzá ÉS van szerkesztő felület. */
  canEdit?: boolean
  view: ReactNode
  edit?: ReactNode
  editLabel?: string
  doneLabel?: string
  className?: string
}) {
  const [editing, setEditing] = useState(false)
  const editable = canEdit && edit != null
  const inEdit = editable && editing

  return (
    <section className={`atelier-card p-5 ${className}`}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold tracking-tight text-ink">{title}</h2>
          {subtitle ? <p className="mt-1 text-sm text-ink-faint">{subtitle}</p> : null}
        </div>
        {editable ? (
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            aria-pressed={inEdit}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
              inEdit
                ? 'bg-ink/8 text-ink-soft hover:text-ink'
                : 'bg-coral/15 text-coral-deep hover:bg-coral/25'
            }`}
          >
            {inEdit ? (
              doneLabel
            ) : (
              <>
                <svg
                  aria-hidden
                  viewBox="0 0 16 16"
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path
                    d="M11.2 2.3a1.6 1.6 0 0 1 2.3 2.3L5.6 12.5l-3 .8.8-3z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {editLabel}
              </>
            )}
          </button>
        ) : null}
      </div>

      {inEdit ? edit : view}
    </section>
  )
}
