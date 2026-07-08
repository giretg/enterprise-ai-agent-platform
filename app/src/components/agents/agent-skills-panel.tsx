'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import {
  assignSkillAction,
  unassignSkillAction,
  setSkillEnabledAction,
  type AgentSkillRow,
  type AssignableSkill,
} from '@/app/actions/skills'
import { Badge, Card } from '@/components/ui/shell'
import type { SkillReadinessColor } from '@/lib/skill/skill-readiness'

const READINESS_TONE: Record<SkillReadinessColor, 'success' | 'warning' | 'danger'> = {
  green: 'success',
  yellow: 'warning',
  red: 'danger',
}

const READINESS_LABEL: Record<SkillReadinessColor, string> = {
  green: 'működőképes',
  yellow: 'hiányos jog',
  red: 'nincs connector',
}

const STATUS_LABEL: Record<string, string> = {
  satisfied: 'engedélyezett',
  grantable: 'nincs engedélyezve (grantelhető)',
  unavailable: 'nincs connector',
}

/**
 * Agent-detail skill-panel (skill-catalog-spec.md WP-4). A hozzárendelt skillek
 * readiness-jelzéssel (zöld/sárga/piros), enable-kapcsolóval és leszereléssel, plusz
 * a katalógusból hozzárendelhető aktív skillek. A readiness CSAK jelez — jogot nem ad
 * (D10 kemény padló): a hiányzó capability-t külön, magasabb jogú admin-aktus grantolja.
 */
export function AgentSkillsPanel({
  agentId,
  assigned,
  assignable,
}: {
  agentId: string
  assigned: AgentSkillRow[]
  assignable: AssignableSkill[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string>(assignable[0]?.activeVersionId ?? '')

  function run(fn: () => Promise<{ success: boolean; error?: string }>) {
    startTransition(async () => {
      setError(null)
      const res = await fn()
      if (res.success) {
        router.refresh()
      } else {
        setError(res.error ?? 'Ismeretlen hiba.')
      }
    })
  }

  return (
    <Card title="Skillek (progresszív betöltés)">
      <p className="mb-4 text-xs text-ink-faint">
        A hozzárendelt skillek Level-0 indexe a promptba kerül; a teljes instrukciót az
        agent a <code>load_skill</code> toollal, auditáltan húzza be. A readiness csak
        jelez — a hiányzó eszközjogot külön kell grantolni.
      </p>

      {assigned.length === 0 ? (
        <p className="text-sm text-ink-faint">Nincs hozzárendelt skill.</p>
      ) : (
        <ul className="space-y-3">
          {assigned.map((s) => (
            <li key={s.skillVersionId} className="atelier-soft p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-medium text-ink">{s.name}</span>
                  <span className="ml-2 text-xs text-ink-faint">v{s.version}</span>
                  <span className="ml-2 text-xs uppercase text-ink-faint">{s.riskTier}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={READINESS_TONE[s.readiness.color]}>
                    {READINESS_LABEL[s.readiness.color]}
                  </Badge>
                  {!s.enabled && <Badge tone="neutral">letiltva</Badge>}
                </div>
              </div>
              <p className="mt-1 text-xs text-ink-soft">{s.description}</p>

              {s.requires.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {s.readiness.items.map((item) => (
                    <li key={item.toolName} className="flex items-center justify-between text-xs">
                      <span className="font-mono text-ink-soft">{item.toolName}</span>
                      <Badge
                        tone={
                          item.status === 'satisfied'
                            ? 'success'
                            : item.status === 'grantable'
                              ? 'warning'
                              : 'danger'
                        }
                      >
                        {STATUS_LABEL[item.status] ?? item.status}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-3 flex items-center gap-3">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(() =>
                      setSkillEnabledAction({
                        agentId,
                        skillVersionId: s.skillVersionId,
                        enabled: !s.enabled,
                      }),
                    )
                  }
                  className="rounded-full border border-ink-faint/30 px-3 py-1 text-xs font-medium text-ink-soft disabled:opacity-50"
                >
                  {s.enabled ? 'Letiltás' : 'Engedélyezés'}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(() => unassignSkillAction({ agentId, skillVersionId: s.skillVersionId }))
                  }
                  className="rounded-full px-3 py-1 text-xs font-medium text-coral disabled:opacity-50"
                >
                  Leszerelés
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5 border-t border-ink-faint/15 pt-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
          Skill hozzárendelése
        </p>
        {assignable.length === 0 ? (
          <p className="text-xs text-ink-faint">
            Nincs több hozzárendelhető aktív skill a katalógusban.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 text-sm"
            >
              {assignable.map((s) => (
                <option key={s.activeVersionId} value={s.activeVersionId}>
                  {s.name} (v{s.version}, {s.riskTier})
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={pending || !selected}
              onClick={() =>
                run(() => assignSkillAction({ agentId, skillVersionId: selected }))
              }
              className="rounded-full bg-coral/20 px-4 py-2 text-sm font-semibold text-coral disabled:opacity-50"
            >
              {pending ? 'Folyamatban...' : 'Hozzárendelés'}
            </button>
          </div>
        )}
      </div>

      {error && <p className="mt-4 text-sm text-coral">{error}</p>}
    </Card>
  )
}
