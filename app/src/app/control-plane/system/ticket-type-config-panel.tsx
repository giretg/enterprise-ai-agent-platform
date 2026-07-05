'use client'

import { useMemo, useState, useTransition } from 'react'
import { adminUpsertTicketType } from '@/app/actions/platform'
import {
  DEFAULT_TICKET_TRANSITIONS,
  TICKET_STATES,
  TRANSITION_ALLOWED_ACTORS,
  type TicketTransitionConfigRule,
  type TicketTypeConfig,
  type TransitionAllowedActor,
} from '@/domain/ticket/ticket-type-config'
import { Badge, Card } from '@/components/ui/shell'
import { TICKET_STATE_LABELS } from '@/lib/ticket-labels'

type TicketType = TicketTypeConfig['type']

const TYPE_LABELS: Record<TicketType, string> = {
  interaction: 'Interakció',
  training: 'Tanítás',
  monitor_alert: 'Monitor-riasztás',
}

const ACTOR_LABELS: Record<TransitionAllowedActor, string> = {
  system: 'Rendszer',
  agent: 'Agent',
  approver: 'Jóváhagyó',
  operator: 'Operátor',
  admin: 'Admin',
  system_or_operator: 'Rendszer vagy operátor',
  creator_or_operator: 'Létrehozó vagy operátor',
}

function cloneRules(rules: TicketTransitionConfigRule[]): TicketTransitionConfigRule[] {
  return rules.map((rule) => ({ ...rule }))
}

function replaceConfig(
  configs: TicketTypeConfig[],
  type: TicketType,
  rules: TicketTransitionConfigRule[],
): TicketTypeConfig[] {
  return configs.map((config) =>
    config.type === type ? { ...config, allowedTransitions: cloneRules(rules) } : config,
  )
}

export function TicketTypeConfigPanel({
  initial,
  canEdit,
}: {
  initial: TicketTypeConfig[]
  canEdit: boolean
}) {
  const [configs, setConfigs] = useState<TicketTypeConfig[]>(initial)
  const [selectedType, setSelectedType] = useState<TicketType>(initial[0]?.type ?? 'interaction')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, startTransition] = useTransition()

  const selected = useMemo(
    () => configs.find((config) => config.type === selectedType) ?? configs[0],
    [configs, selectedType],
  )

  const updateRule = (
    index: number,
    patch: Partial<TicketTransitionConfigRule>,
  ) => {
    if (!selected) return
    const nextRules = selected.allowedTransitions.map((rule, currentIndex) =>
      currentIndex === index ? { ...rule, ...patch } : rule,
    )
    setConfigs((current) => replaceConfig(current, selected.type, nextRules))
    setSaved(false)
  }

  const addRule = () => {
    if (!selected) return
    const addedRule: TicketTransitionConfigRule = { from: 'backlog', to: 'ready', allowed: 'operator' }
    const nextRules = [
      ...selected.allowedTransitions,
      addedRule,
    ]
    setConfigs((current) => replaceConfig(current, selected.type, nextRules))
    setSaved(false)
  }

  const removeRule = (index: number) => {
    if (!selected || selected.allowedTransitions.length <= 1) return
    const nextRules = selected.allowedTransitions.filter((_, currentIndex) => currentIndex !== index)
    setConfigs((current) => replaceConfig(current, selected.type, nextRules))
    setSaved(false)
  }

  const resetDefault = () => {
    if (!selected) return
    setConfigs((current) => replaceConfig(current, selected.type, cloneRules(DEFAULT_TICKET_TRANSITIONS)))
    setSaved(false)
  }

  const save = () => {
    if (!selected) return
    setError(null)
    setSaved(false)
    startTransition(async () => {
      const res = await adminUpsertTicketType({
        type: selected.type,
        allowedTransitions: selected.allowedTransitions,
      })
      if (!res.success) {
        setError(res.error)
        return
      }
      setConfigs(res.data)
      setSaved(true)
    })
  }

  return (
    <Card title="Tickettípus átmenetek">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {configs.map((config) => (
            <button
              key={config.type}
              type="button"
              onClick={() => {
                setSelectedType(config.type)
                setError(null)
                setSaved(false)
              }}
              className={`rounded-full border px-4 py-2 text-sm font-semibold transition ${
                selectedType === config.type
                  ? 'border-coral/45 bg-coral/10 text-coral-deep'
                  : 'border-line text-ink-soft hover:border-coral/30 hover:text-coral'
              }`}
            >
              {TYPE_LABELS[config.type]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selected?.updatedAt ? <Badge tone="neutral">módosítva</Badge> : <Badge>alapértelmezett</Badge>}
          {saved && <Badge tone="success">mentve</Badge>}
        </div>
      </div>

      {selected && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-[0.14em] text-ink-faint">
              <tr>
                <th className="py-2 pr-3 font-semibold">Forrás</th>
                <th className="py-2 pr-3 font-semibold">Cél</th>
                <th className="py-2 pr-3 font-semibold">Kapuszerep</th>
                <th className="py-2 text-right font-semibold">Művelet</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {selected.allowedTransitions.map((rule, index) => (
                <tr key={`${index}:${rule.from}:${rule.to}`}>
                  <td className="py-2 pr-3">
                    <select
                      value={rule.from}
                      disabled={!canEdit}
                      onChange={(event) => updateRule(index, { from: event.target.value as typeof rule.from })}
                      className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm disabled:bg-ink/5"
                    >
                      {TICKET_STATES.map((state) => (
                        <option key={state} value={state}>
                          {TICKET_STATE_LABELS[state]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-3">
                    <select
                      value={rule.to}
                      disabled={!canEdit}
                      onChange={(event) => updateRule(index, { to: event.target.value as typeof rule.to })}
                      className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm disabled:bg-ink/5"
                    >
                      {TICKET_STATES.map((state) => (
                        <option key={state} value={state}>
                          {TICKET_STATE_LABELS[state]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-3">
                    <select
                      value={rule.allowed}
                      disabled={!canEdit}
                      onChange={(event) =>
                        updateRule(index, { allowed: event.target.value as TransitionAllowedActor })
                      }
                      className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm disabled:bg-ink/5"
                    >
                      {TRANSITION_ALLOWED_ACTORS.map((actor) => (
                        <option key={actor} value={actor}>
                          {ACTOR_LABELS[actor]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      disabled={!canEdit || selected.allowedTransitions.length <= 1}
                      onClick={() => removeRule(index)}
                      className="rounded-full border border-line px-3 py-2 text-xs font-semibold text-ink-soft transition hover:border-coral/35 hover:text-coral disabled:opacity-40"
                    >
                      Törlés
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-coral">{error}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!canEdit || pending}
          onClick={addRule}
          className="rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition hover:border-coral/35 hover:text-coral disabled:opacity-40"
        >
          Átmenet hozzáadása
        </button>
        <button
          type="button"
          disabled={!canEdit || pending}
          onClick={resetDefault}
          className="rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition hover:border-coral/35 hover:text-coral disabled:opacity-40"
        >
          Alap visszaállítása
        </button>
        <button
          type="button"
          disabled={!canEdit || pending}
          onClick={save}
          className="rounded-full bg-coral px-5 py-2 text-sm font-semibold text-white transition hover:bg-coral-deep disabled:opacity-40"
        >
          {pending ? 'Mentés…' : 'Mentés'}
        </button>
      </div>
    </Card>
  )
}
