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
import { OpenInNewWindowLink } from '@/components/ui/open-in-new-window-link'
import {
  CREATE_AGENT_WIZARD_EXTERNAL_HREFS,
  matchAssignableSkillsByName,
} from '@/lib/create-agent-wizard'
import type { SkillReadinessColor } from '@/lib/skill/skill-readiness'
import { skillDisplayLabel } from '@/lib/skill/skill-name'
import { formatToolUiName } from '@/lib/tool-ui-labels'

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
  suggestedSkillNames,
  canEdit = true,
  bare = false,
  onChanged,
}: {
  agentId: string
  assigned: AgentSkillRow[]
  assignable: AssignableSkill[]
  /** Javaslat: csak megjelenik; hozzárendelés külön admin-kattintás. */
  suggestedSkillNames?: string[]
  /** Operátor a listát látja; az admin ugyanitt rendel / tilt / leszerel. */
  canEdit?: boolean
  /** A hívó már adott keretet (címsor + doboz) — ne rajzoljunk másodikat. */
  bare?: boolean
  onChanged?: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const suggestedAssignable = matchAssignableSkillsByName(
    assignable,
    suggestedSkillNames ?? [],
  )
  const [selected, setSelected] = useState('')
  const selectedSkill = assignable.find((s) => s.activeVersionId === selected) ?? null

  function run(fn: () => Promise<{ success: boolean; error?: string }>) {
    startTransition(async () => {
      setError(null)
      const res = await fn()
      if (res.success) {
        onChanged?.()
        router.refresh()
      } else {
        setError(res.error ?? 'Ismeretlen hiba.')
      }
    })
  }

  const body = (
    <>
      {assigned.length === 0 ? (
        <p className="text-sm text-ink-faint">Nincs hozzárendelt skill.</p>
      ) : (
        <ul className="space-y-3">
          {assigned.map((s) => (
            <li key={s.skillVersionId} className="atelier-soft p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-medium text-ink">{skillDisplayLabel(s)}</span>
                  {s.displayName?.trim() && s.displayName.trim() !== s.name ? (
                    <span className="ml-2 font-mono text-[11px] text-ink-faint">{s.name}</span>
                  ) : null}
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
                      <span className="text-ink-soft">{formatToolUiName(item.toolName)}</span>
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

              {canEdit ? (
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
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canEdit && suggestedAssignable.length > 0 ? (
        <div className="mt-4 rounded-lg border border-sage/30 bg-sage/10 px-3 py-3">
          <p className="text-xs font-medium text-ink">
            Javasolt skillek — csak akkor kerülnek rá, ha hozzárendeled.
          </p>
          <ul className="mt-2 space-y-2">
            {suggestedAssignable.map((s) => (
              <li key={s.activeVersionId} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-ink">{skillDisplayLabel(s)}</span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(() => assignSkillAction({ agentId, skillVersionId: s.activeVersionId }))
                  }
                  className="rounded-full bg-coral/20 px-3 py-1 text-xs font-semibold text-coral disabled:opacity-50"
                >
                  Hozzárendelés
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canEdit ? (
      <div className="mt-5 border-t border-ink-faint/15 pt-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
          Skill hozzárendelése
        </p>
        {assignable.length === 0 ? (
          <p className="text-xs text-ink-faint">
            Nincs több hozzárendelhető aktív skill a katalógusban.{' '}
            <OpenInNewWindowLink href={CREATE_AGENT_WIZARD_EXTERNAL_HREFS.skills}>
              Új skill létrehozása
            </OpenInNewWindowLink>
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <select
                value={selectedSkill?.activeVersionId ?? ''}
                onChange={(e) => setSelected(e.target.value)}
                className="min-w-[12rem] flex-1 rounded-lg border border-ink-faint/30 bg-transparent px-3 py-2 text-sm"
              >
                <option value="">nincs kiválasztva</option>
                {assignable.map((s) => (
                  <option key={s.activeVersionId} value={s.activeVersionId}>
                    {skillDisplayLabel(s)} (v{s.version}, {s.riskTier})
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={pending || !selectedSkill}
                onClick={() =>
                  run(() =>
                    assignSkillAction({
                      agentId,
                      skillVersionId: selectedSkill!.activeVersionId,
                    }),
                  )
                }
                className="rounded-full bg-coral/20 px-4 py-2 text-sm font-semibold text-coral disabled:opacity-50"
              >
                {pending ? 'Folyamatban...' : 'Hozzárendelés'}
              </button>
              <OpenInNewWindowLink
                href={CREATE_AGENT_WIZARD_EXTERNAL_HREFS.skills}
                className="text-xs font-medium text-coral hover:text-coral-deep"
              >
                Új skill
              </OpenInNewWindowLink>
            </div>
            {selectedSkill ? (
              <div className="atelier-soft p-3">
                <p className="text-sm font-medium text-ink">{skillDisplayLabel(selectedSkill)}</p>
                <p className="mt-1 text-sm leading-relaxed text-ink-soft">
                  {selectedSkill.description}
                </p>
              </div>
            ) : null}
          </div>
        )}
      </div>
      ) : null}

      {error && <p className="mt-4 text-sm text-coral">{error}</p>}
    </>
  )

  if (bare) return body
  return <Card title="Skillek (előre meghatározott feladatleírás)">{body}</Card>
}
