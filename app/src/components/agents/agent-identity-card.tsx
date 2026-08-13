'use client'

import { useState, type ReactNode } from 'react'
import { Card } from '@/components/ui/shell'

/**
 * Az agent fejléc-kártyája: EZ a bemutatkozás megjelenítése (arckép, név, üdvözlés,
 * jellemvonás). Korábban ugyanez lent, a „Szerkesztés" menüpontban még egyszer
 * megjelent két külön dobozban (Avatár + Bemutatkozás szerkesztése). Most az admin
 * ugyanitt, a fejléc alatt nyitja ki a szerkesztőt — így nincs két igazság.
 */
export function AgentIdentityCard({
  canEdit,
  header,
  trait,
  actions,
  edit,
}: {
  canEdit: boolean
  header: ReactNode
  trait: ReactNode
  actions: ReactNode
  edit?: ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const editable = canEdit && edit != null

  return (
    <Card className="animate-rise">
      {header}
      <div className="estate-rule my-4" />
      {trait}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {actions}
        {editable ? (
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            aria-pressed={editing}
            className={`ml-auto rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
              editing
                ? 'bg-ink/8 text-ink-soft hover:text-ink'
                : 'bg-coral/15 text-coral-deep hover:bg-coral/25'
            }`}
          >
            {editing ? 'Kész' : 'Arckép és bemutatkozás szerkesztése'}
          </button>
        ) : null}
      </div>
      {editable && editing ? (
        <div className="mt-5 space-y-6 border-t border-line pt-5">{edit}</div>
      ) : null}
    </Card>
  )
}
