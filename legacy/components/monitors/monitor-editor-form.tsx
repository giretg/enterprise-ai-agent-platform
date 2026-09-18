'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createMonitor, updateMonitor } from '@/app/actions/monitor'

const KIND_OPTIONS = [
  { value: 'deadline', label: 'Határidő — közelgő due_by (e-mail TODO, nem nyit ticketet)' },
  { value: 'board_backlog', label: 'Board elakadás — awaiting_human / ready > N óra' },
  { value: 'connector_count', label: 'Connector-számlálás — postafiók-darabszám' },
]

type AgentOption = { id: string; name: string }

export type MonitorFormValues = {
  id?: string
  kind: string
  title: string
  description: string
  intervalSeconds: number
  collectorConfig: string
  filterConfig: string
  cooldownSeconds: number
  dedupKeyTemplate: string
  escalateAgentId: string
  perRunBudgetUsd: string
  notifyChannel: string
}

function defaultForm(initial?: Partial<MonitorFormValues>): MonitorFormValues {
  return {
    kind: initial?.kind ?? 'deadline',
    title: initial?.title ?? '',
    description: initial?.description ?? '',
    intervalSeconds: initial?.intervalSeconds ?? 3600,
    collectorConfig: initial?.collectorConfig ?? '{}',
    filterConfig: initial?.filterConfig ?? '{"op":"and","rules":[{"field":"severity","cmp":">=","value":60}]}',
    cooldownSeconds: initial?.cooldownSeconds ?? 86400,
    dedupKeyTemplate: initial?.dedupKeyTemplate ?? '',
    escalateAgentId: initial?.escalateAgentId ?? '',
    perRunBudgetUsd: initial?.perRunBudgetUsd ?? '',
    notifyChannel: initial?.notifyChannel ?? '',
    ...initial,
  }
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    const val = JSON.parse(s)
    return typeof val === 'object' && val !== null && !Array.isArray(val) ? val : null
  } catch {
    return null
  }
}

export function MonitorEditorForm({
  initial,
  agents,
}: {
  initial?: Partial<MonitorFormValues>
  agents: AgentOption[]
}) {
  const router = useRouter()
  const [form, setForm] = useState<MonitorFormValues>(defaultForm(initial))
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [filterJsonError, setFilterJsonError] = useState<string | null>(null)
  const [collectorJsonError, setCollectorJsonError] = useState<string | null>(null)

  const isEdit = Boolean(initial?.id)

  function set(key: keyof MonitorFormValues, value: string | number) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function submit() {
    setError(null)
    const filterParsed = safeJson(form.filterConfig)
    if (!filterParsed) { setFilterJsonError('Érvénytelen JSON'); return }
    setFilterJsonError(null)
    const collectorParsed = safeJson(form.collectorConfig)
    if (!collectorParsed) { setCollectorJsonError('Érvénytelen JSON'); return }
    setCollectorJsonError(null)

    startTransition(async () => {
      const payload = {
        ...(isEdit ? { id: initial!.id } : {}),
        kind: form.kind as 'deadline' | 'board_backlog' | 'connector_count' | 'composite',
        title: form.title,
        description: form.description || undefined,
        intervalSeconds: Number(form.intervalSeconds),
        collectorConfig: collectorParsed,
        filterConfig: filterParsed,
        cooldownSeconds: Number(form.cooldownSeconds),
        dedupKeyTemplate: form.dedupKeyTemplate || undefined,
        escalateAgentId: form.escalateAgentId || null,
        perRunBudgetUsd: form.perRunBudgetUsd ? Number(form.perRunBudgetUsd) : null,
        notifyChannel: form.notifyChannel || null,
      }

      const action = isEdit ? updateMonitor : createMonitor
      const res = await action(payload)
      if (res.success) {
        router.push(`/control-plane/monitors/${res.data.id}`)
        router.refresh()
      } else {
        setError(res.error)
      }
    })
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="block text-sm font-medium mb-1">Típus (kind)</label>
          <select
            value={form.kind}
            disabled={isEdit}
            onChange={(e) => set('kind', e.target.value)}
            className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink disabled:opacity-50"
          >
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {isEdit && <p className="mt-1 text-xs text-ink-soft">A kind módosítása szerkesztéskor nem lehetséges.</p>}
        </div>

        <div className="sm:col-span-2">
          <label className="block text-sm font-medium mb-1">Cím *</label>
          <input
            type="text"
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="pl. Elakadt tickets napi riasztás"
            className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink"
          />
        </div>

        <div className="sm:col-span-2">
          <label className="block text-sm font-medium mb-1">Leírás</label>
          <textarea
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            rows={2}
            className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Söprés-intervallum (mp)</label>
          <input
            type="number"
            min={60}
            max={86400}
            value={form.intervalSeconds}
            onChange={(e) => set('intervalSeconds', Number(e.target.value))}
            className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink"
          />
          <p className="mt-1 text-xs text-ink-soft">60–86400 mp (1 perc – 24 óra)</p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Cooldown (mp)</label>
          <input
            type="number"
            min={0}
            max={604800}
            value={form.cooldownSeconds}
            onChange={(e) => set('cooldownSeconds', Number(e.target.value))}
            className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink"
          />
          <p className="mt-1 text-xs text-ink-soft">Ugyanaz a jel ennyit vár az újra-eszkaláció előtt (alapért. 86400 = 24h)</p>
        </div>

        <div className="sm:col-span-2">
          <label className="block text-sm font-medium mb-1">Collector konfiguráció (JSON)</label>
          <textarea
            value={form.collectorConfig}
            onChange={(e) => set('collectorConfig', e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-xs text-ink"
          />
          {collectorJsonError ? (
            <p className="mt-1 text-xs text-red-400">{collectorJsonError}</p>
          ) : (
            <p className="mt-1 text-xs text-ink-soft">
              deadline: {'{'}&quot;windowHours&quot;: 24{'}'} · board_backlog: {'{'}&quot;staleHours&quot;: 4{'}'}
            </p>
          )}
        </div>

        <div className="sm:col-span-2">
          <label className="block text-sm font-medium mb-1">Szűrő konfiguráció (JSON DSL)</label>
          <textarea
            value={form.filterConfig}
            onChange={(e) => set('filterConfig', e.target.value)}
            rows={5}
            className="w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-xs text-ink"
          />
          {filterJsonError ? (
            <p className="mt-1 text-xs text-red-400">{filterJsonError}</p>
          ) : (
            <p className="mt-1 text-xs text-ink-soft">
              AND/OR fa · field: severity, hoursUntilDue, businessHours, payload.* · cmp: &gt;=, &gt;, &lt;=, &lt;, ==, !=, between, in
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Dedup-kulcs sablon</label>
          <input
            type="text"
            value={form.dedupKeyTemplate}
            onChange={(e) => set('dedupKeyTemplate', e.target.value)}
            placeholder="pl. deadline:{ticketId}"
            className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Eszkaláló agent (opcionális)</label>
          <select
            value={form.escalateAgentId}
            onChange={(e) => set('escalateAgentId', e.target.value)}
            className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink"
          >
            <option value="">— LLM nélkül (csak ticket-nyitás)</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Per-futás budget (USD)</label>
          <input
            type="number"
            min={0}
            max={100}
            step={0.01}
            value={form.perRunBudgetUsd}
            onChange={(e) => set('perRunBudgetUsd', e.target.value)}
            placeholder="pl. 0.10"
            className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink"
          />
          <p className="mt-1 text-xs text-ink-soft">Csak ha van eszkaláló agent (2. lépcső LLM)</p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Értesítési csatorna (opcionális)</label>
          <input
            type="text"
            value={form.notifyChannel}
            onChange={(e) => set('notifyChannel', e.target.value)}
            placeholder="pl. chat:ops vagy email:ops@example.com"
            className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink"
          />
          <p className="mt-1 text-xs text-slate-400">
            <code>chat:&lt;kulcs&gt;</code> → szerveroldali allowlistolt webhook (Slack/Teams/Google Chat,{' '}
            <code>MONITOR_NOTIFY_WEBHOOK_&lt;KULCS&gt;</code> env). Más csatorna csak auditba kerül. Az
            értesítés best-effort figyelemfelhívás a board-ticketre.
          </p>
        </div>
      </div>

      {error ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </p>
      ) : null}

      <div className="flex gap-3">
        <button
          type="button"
          disabled={pending || !form.title.trim()}
          onClick={submit}
          className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {pending ? 'Mentés...' : isEdit ? 'Frissítés' : 'Létrehozás'}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-lg border border-line/60 px-4 py-2 text-sm text-ink-soft hover:text-ink"
        >
          Mégse
        </button>
      </div>
    </div>
  )
}
