'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import type { ModelRoutingPolicy, ModelBudget } from '@prisma/client'
import {
  createModelRoutingPolicy,
  deleteModelRoutingPolicy,
  createModelBudget,
  deleteModelBudget,
} from '@/app/actions/platform'
import type { ModelCallGovernanceSummary, ModelCallTicketBreakdown } from '@/repositories/interfaces'

type GatewaySummaryData = {
  summary: ModelCallGovernanceSummary
  breakdown: ModelCallTicketBreakdown[]
  sinceHours: number
}

function StatBox({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-line/60 bg-panel/40 p-3 text-center">
      <p className="text-xs text-ink-faint">{label}</p>
      <p className="mt-1 text-lg font-semibold text-ink">{value}</p>
    </div>
  )
}

function RoutingPoliciesSection({
  initial,
  canEdit,
}: {
  initial: ModelRoutingPolicy[]
  canEdit: boolean
}) {
  const [policies, setPolicies] = useState(initial)
  const [pending, startTransition] = useTransition()
  const [newScope, setNewScope] = useState<'global' | 'agent' | 'ticket_type'>('global')
  const [newScopeRef, setNewScopeRef] = useState('')
  const [newProvider, setNewProvider] = useState('chatgpt-oauth')
  const [newModel, setNewModel] = useState('chatgpt-oauth-default')
  const [newPriority, setNewPriority] = useState(100)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function addPolicy() {
    setMsg(null)
    startTransition(async () => {
      const res = await createModelRoutingPolicy({
        scope: newScope,
        scopeRef: newScopeRef.trim() || undefined,
        provider: newProvider,
        model: newModel,
        priority: newPriority,
      })
      if (res.success) {
        setPolicies((prev) => [...prev, res.data].sort((a, b) => a.priority - b.priority))
        setNewScopeRef('')
        setMsg({ tone: 'ok', text: 'Routing policy létrehozva.' })
      } else {
        setMsg({ tone: 'err', text: res.error })
      }
    })
  }

  function removePolicy(id: string) {
    setMsg(null)
    startTransition(async () => {
      const res = await deleteModelRoutingPolicy({ id })
      if (res.success) {
        setPolicies((prev) => prev.filter((p) => p.id !== id))
        setMsg({ tone: 'ok', text: 'Törölve.' })
      } else {
        setMsg({ tone: 'err', text: res.error })
      }
    })
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Routing szabályok</p>
      {policies.length === 0 && (
        <p className="text-sm text-ink-soft">Nincs routing policy — az agentenkénti modelkonfig érvényes.</p>
      )}
      <div className="space-y-2">
        {policies.map((p) => (
          <div
            key={p.id}
            className="flex items-center justify-between rounded-md border border-line/50 bg-night/40 px-3 py-2 text-sm"
          >
            <div>
              <span className="font-medium text-ink">
                [{p.priority}] {p.scope}
                {p.scopeRef ? ` / ${p.scopeRef}` : ''}
              </span>
              <span className="ml-2 text-ink-faint">
                → {p.provider}/{p.model}
              </span>
            </div>
            {canEdit && (
              <button
                type="button"
                disabled={pending}
                onClick={() => removePolicy(p.id)}
                className="text-xs text-coral hover:text-coral-deep disabled:opacity-50"
              >
                Töröl
              </button>
            )}
          </div>
        ))}
      </div>

      {canEdit && (
        <div className="grid grid-cols-2 gap-2 rounded-md border border-line/40 bg-panel/20 p-3 md:grid-cols-4">
          <select
            value={newScope}
            onChange={(e) => setNewScope(e.target.value as typeof newScope)}
            className="rounded border border-line/50 bg-night/60 px-2 py-1 text-xs text-ink"
          >
            <option value="global">global</option>
            <option value="agent">agent</option>
            <option value="ticket_type">ticket_type</option>
          </select>
          <input
            placeholder="scope ref (agent id / típus)"
            value={newScopeRef}
            onChange={(e) => setNewScopeRef(e.target.value)}
            className="rounded border border-line/50 bg-night/60 px-2 py-1 text-xs text-ink placeholder:text-ink-faint"
          />
          <input
            placeholder="provider (chatgpt-oauth)"
            value={newProvider}
            onChange={(e) => setNewProvider(e.target.value)}
            className="rounded border border-line/50 bg-night/60 px-2 py-1 text-xs text-ink placeholder:text-ink-faint"
          />
          <input
            placeholder="model"
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            className="rounded border border-line/50 bg-night/60 px-2 py-1 text-xs text-ink placeholder:text-ink-faint"
          />
          <input
            type="number"
            placeholder="prioritás (100)"
            value={newPriority}
            onChange={(e) => setNewPriority(Number(e.target.value))}
            className="rounded border border-line/50 bg-night/60 px-2 py-1 text-xs text-ink placeholder:text-ink-faint"
          />
          <div className="col-span-2 md:col-span-3" />
          <button
            type="button"
            disabled={pending || !newProvider || !newModel}
            onClick={addPolicy}
            className="rounded-md bg-coral px-3 py-1 text-xs font-medium text-night disabled:opacity-50"
          >
            Hozzáad
          </button>
        </div>
      )}

      {msg && (
        <p className={`text-xs ${msg.tone === 'ok' ? 'text-emerald-400' : 'text-coral'}`}>{msg.text}</p>
      )}
    </div>
  )
}

function BudgetsSection({
  initial,
  canEdit,
}: {
  initial: ModelBudget[]
  canEdit: boolean
}) {
  const [budgets, setBudgets] = useState(initial)
  const [pending, startTransition] = useTransition()
  const [newScope, setNewScope] = useState<'tenant' | 'agent' | 'ticket_type'>('tenant')
  const [newScopeRef, setNewScopeRef] = useState('')
  const [newPeriod, setNewPeriod] = useState<'day' | 'week' | 'month'>('week')
  const [newCallLimit, setNewCallLimit] = useState('')
  const [newTokenLimit, setNewTokenLimit] = useState('')
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function addBudget() {
    setMsg(null)
    startTransition(async () => {
      const res = await createModelBudget({
        scope: newScope,
        scopeRef: newScopeRef.trim() || undefined,
        period: newPeriod,
        callLimit: newCallLimit ? Number(newCallLimit) : undefined,
        tokenLimit: newTokenLimit ? Number(newTokenLimit) : undefined,
        hardCap: true,
      })
      if (res.success) {
        setBudgets((prev) => [...prev, res.data])
        setNewScopeRef('')
        setNewCallLimit('')
        setNewTokenLimit('')
        setMsg({ tone: 'ok', text: 'Budget létrehozva.' })
      } else {
        setMsg({ tone: 'err', text: res.error })
      }
    })
  }

  function removeBudget(id: string) {
    setMsg(null)
    startTransition(async () => {
      const res = await deleteModelBudget({ id })
      if (res.success) {
        setBudgets((prev) => prev.filter((b) => b.id !== id))
        setMsg({ tone: 'ok', text: 'Törölve.' })
      } else {
        setMsg({ tone: 'err', text: res.error })
      }
    })
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Budget szabályok</p>
      {budgets.length === 0 && (
        <p className="text-sm text-ink-soft">Nincs budget korlát — csak a ticket-szintű guardrail aktív.</p>
      )}
      <div className="space-y-2">
        {budgets.map((b) => (
          <div
            key={b.id}
            className="flex items-center justify-between rounded-md border border-line/50 bg-night/40 px-3 py-2 text-sm"
          >
            <div>
              <span className="font-medium text-ink">
                {b.scope}
                {b.scopeRef ? ` / ${b.scopeRef}` : ''}
              </span>
              <span className="ml-2 text-ink-faint">
                {b.period}
                {b.callLimit != null ? ` · ${b.callLimit} hívás` : ''}
                {b.tokenLimit != null ? ` · ${b.tokenLimit} token` : ''}
                {b.hardCap ? ' · hard cap' : ' · soft cap'}
              </span>
            </div>
            {canEdit && (
              <button
                type="button"
                disabled={pending}
                onClick={() => removeBudget(b.id)}
                className="text-xs text-coral hover:text-coral-deep disabled:opacity-50"
              >
                Töröl
              </button>
            )}
          </div>
        ))}
      </div>

      {canEdit && (
        <div className="grid grid-cols-2 gap-2 rounded-md border border-line/40 bg-panel/20 p-3 md:grid-cols-4">
          <select
            value={newScope}
            onChange={(e) => setNewScope(e.target.value as typeof newScope)}
            className="rounded border border-line/50 bg-night/60 px-2 py-1 text-xs text-ink"
          >
            <option value="tenant">tenant</option>
            <option value="agent">agent</option>
            <option value="ticket_type">ticket_type</option>
          </select>
          <select
            value={newPeriod}
            onChange={(e) => setNewPeriod(e.target.value as typeof newPeriod)}
            className="rounded border border-line/50 bg-night/60 px-2 py-1 text-xs text-ink"
          >
            <option value="day">nap</option>
            <option value="week">hét</option>
            <option value="month">hónap</option>
          </select>
          <input
            placeholder="scope ref (opcionális)"
            value={newScopeRef}
            onChange={(e) => setNewScopeRef(e.target.value)}
            className="rounded border border-line/50 bg-night/60 px-2 py-1 text-xs text-ink placeholder:text-ink-faint"
          />
          <input
            type="number"
            placeholder="hívás korlát"
            value={newCallLimit}
            onChange={(e) => setNewCallLimit(e.target.value)}
            className="rounded border border-line/50 bg-night/60 px-2 py-1 text-xs text-ink placeholder:text-ink-faint"
          />
          <input
            type="number"
            placeholder="token korlát"
            value={newTokenLimit}
            onChange={(e) => setNewTokenLimit(e.target.value)}
            className="rounded border border-line/50 bg-night/60 px-2 py-1 text-xs text-ink placeholder:text-ink-faint"
          />
          <div className="col-span-2 md:col-span-2" />
          <button
            type="button"
            disabled={pending || (!newCallLimit && !newTokenLimit)}
            onClick={addBudget}
            className="rounded-md bg-coral px-3 py-1 text-xs font-medium text-night disabled:opacity-50"
          >
            Hozzáad
          </button>
        </div>
      )}

      {msg && (
        <p className={`text-xs ${msg.tone === 'ok' ? 'text-emerald-400' : 'text-coral'}`}>{msg.text}</p>
      )}
    </div>
  )
}

export function ModelGatewayPanel({
  stats,
  routingPolicies,
  budgets,
  canEdit,
}: {
  stats: GatewaySummaryData
  routingPolicies: ModelRoutingPolicy[]
  budgets: ModelBudget[]
  canEdit: boolean
}) {
  const { summary, breakdown, sinceHours } = stats

  return (
    <Card title="Model Gateway — megfigyelhetőség és routing">
      <div className="space-y-6">
        {/* Observability summary */}
        <div>
          <p className="mb-3 text-xs text-ink-soft">
            Utolsó {sinceHours >= 24 ? `${Math.round(sinceHours / 24)} nap` : `${sinceHours} óra`}
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatBox label="Összes hívás" value={summary.calls} />
            <StatBox label="Sikeres" value={summary.okCalls} />
            <StatBox label="Hiba" value={summary.errorCalls} />
            <StatBox label="Rate limited" value={summary.rateLimitedCalls} />
            <StatBox label="Tokenek (becsült)" value={summary.tokens.toLocaleString('hu-HU')} />
            <StatBox label="Avg latency (ms)" value={summary.avgLatencyMs} />
            <StatBox label="Becsült költség ($)" value={summary.cost.toFixed(4)} />
            <StatBox
              label="Sikerráta"
              value={summary.calls > 0 ? `${Math.round((summary.okCalls / summary.calls) * 100)}%` : '—'}
            />
          </div>
        </div>

        {/* Per-ticket breakdown */}
        {breakdown.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">
              Top ticket felhasználás
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-ink-faint">
                    <th className="pb-1 pr-4">Ticket ID</th>
                    <th className="pb-1 pr-4">Hívások</th>
                    <th className="pb-1 pr-4">Tokenek</th>
                    <th className="pb-1">Avg latency</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.map((row) => (
                    <tr key={row.ticketId} className="border-t border-line/30">
                      <td className="py-1 pr-4 font-mono text-ink-faint">{row.ticketId.slice(0, 8)}…</td>
                      <td className="py-1 pr-4 text-ink">{row.calls}</td>
                      <td className="py-1 pr-4 text-ink">{row.tokens.toLocaleString('hu-HU')}</td>
                      <td className="py-1 text-ink">{row.avgLatencyMs} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <hr className="border-line/40" />

        {/* Routing policies */}
        <RoutingPoliciesSection initial={routingPolicies} canEdit={canEdit} />

        <hr className="border-line/40" />

        {/* Budgets */}
        <BudgetsSection initial={budgets} canEdit={canEdit} />
      </div>
    </Card>
  )
}
