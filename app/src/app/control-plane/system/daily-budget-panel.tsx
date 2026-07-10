'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import {
  setTenantDailyBudget,
  type BudgetLimits,
  type DailyBudgetOverview,
} from '@/app/actions/platform'

/** Üres mező = korlátlan. A `0` érvénytelen (azonnal mindent blokkolna), ezért nem engedjük. */
function parseLimit(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n)
}

function formatLimit(limit: number | null): string {
  return limit === null ? '' : String(limit)
}

type BudgetLimitDraft = { [K in keyof BudgetLimits]: string }
type DailyBudgetDraft = { tenant: BudgetLimitDraft; perAgent: BudgetLimitDraft }

function toDraft(limits: BudgetLimits): BudgetLimitDraft {
  return {
    callLimit: formatLimit(limits.callLimit),
    tokenLimit: formatLimit(limits.tokenLimit),
  }
}

function fromDraft(draft: BudgetLimitDraft): BudgetLimits {
  return {
    callLimit: parseLimit(draft.callLimit),
    tokenLimit: parseLimit(draft.tokenLimit),
  }
}

function UsageBar({ used, limit }: { used: number; limit: number | null }) {
  if (limit === null) {
    return <p className="text-xs text-ink-faint">{used.toLocaleString('hu-HU')} felhasználva · nincs limit</p>
  }
  const ratio = Math.min(1, used / limit)
  const tone = ratio >= 1 ? 'bg-coral' : ratio >= 0.8 ? 'bg-amber-500' : 'bg-emerald-500'
  return (
    <div className="space-y-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-line/50">
        <div className={`h-full ${tone}`} style={{ width: `${ratio * 100}%` }} />
      </div>
      <p className="text-xs text-ink-faint">
        {used.toLocaleString('hu-HU')} / {limit.toLocaleString('hu-HU')}
        {ratio >= 1 ? ' — a keret elfogyott, az agent-indítás blokkolva' : ''}
      </p>
    </div>
  )
}

/**
 * Napi model-keret: a tenant összesített kerete és a minden agentre külön-külön érvényes
 * per-agent keret, a gördülő 24 órás ablakon mért tényleges fogyasztással. Ha egyik sincs
 * beállítva, az env-mentsvár dönt — ezt külön kiírjuk, mert ilyenkor a felületen megadott
 * „nincs limit" félrevezető lenne.
 */
export function DailyBudgetPanel({
  overview,
  canEdit,
}: {
  overview: DailyBudgetOverview
  canEdit: boolean
}) {
  const [draft, setDraft] = useState<DailyBudgetDraft>({
    tenant: toDraft(overview.tenant),
    perAgent: toDraft(overview.perAgent),
  })
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const nothingConfigured = !overview.tenant.configured && !overview.perAgent.configured
  const effectivePerAgentTokens = overview.perAgent.configured
    ? overview.perAgent.tokenLimit
    : overview.envFallback.maxTokensPerDay
  const effectivePerAgentCalls = overview.perAgent.configured
    ? overview.perAgent.callLimit
    : overview.envFallback.maxCallsPerDay

  function updateDraft(
    scope: keyof DailyBudgetDraft,
    field: keyof BudgetLimitDraft,
    value: string,
  ) {
    setDraft((current) => ({
      ...current,
      [scope]: { ...current[scope], [field]: value },
    }))
  }

  function save() {
    startTransition(async () => {
      const res = await setTenantDailyBudget({
        tenant: fromDraft(draft.tenant),
        perAgent: fromDraft(draft.perAgent),
      })
      setMessage(
        res.success
          ? { tone: 'ok', text: 'Napi keret mentve. A következő agent-indításnál már ez érvényes.' }
          : { tone: 'err', text: res.error },
      )
    })
  }

  return (
    <Card>
      <div className="space-y-6">
        <div>
          <h2 className="font-display text-xl font-semibold">Napi model-keret</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Ha egy agent aznapi fogyasztása átlépi a keretet, a dispatcher nem indítja el a
            ticketjeit — a ticket <span className="font-mono text-xs">ready</span> állapotban vár.
            A fogyasztás gördülő 24 órás ablakon számol, nem éjfélkor nullázódik. Üres mező =
            nincs limit az adott dimenzióban.
          </p>
        </div>

        {nothingConfigured && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-ink">
            Nincs beállított keret, ezért a beépített alapértelmezés érvényes:{' '}
            <span className="font-mono text-xs">
              {overview.envFallback.maxCallsPerDay} hívás / {overview.envFallback.maxTokensPerDay.toLocaleString('hu-HU')} token
            </span>{' '}
            agentenként, naponta. Ez blokkolja az agent-indítást, amint egy agent átlépi.
          </div>
        )}

        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-ink">Tenant összesített keret</h3>
            <p className="text-xs text-ink-faint">
              A tenant összes agentjének együttes napi fogyasztása. Ez a valódi költség-plafon.
            </p>
          </div>
          <UsageBar used={overview.usage.tenant.tokens} limit={overview.tenant.tokenLimit} />
          <div className="flex flex-wrap gap-3">
            <label className="text-xs text-ink-soft">
              Hívás / nap
              <input
                type="number"
                min={1}
                value={draft.tenant.callLimit}
                onChange={(e) => updateDraft('tenant', 'callLimit', e.target.value)}
                disabled={!canEdit || pending}
                placeholder="nincs limit"
                className="mt-1 block w-40 rounded-md border border-line/60 bg-panel/40 px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-ink-soft">
              Token / nap
              <input
                type="number"
                min={1}
                value={draft.tenant.tokenLimit}
                onChange={(e) => updateDraft('tenant', 'tokenLimit', e.target.value)}
                disabled={!canEdit || pending}
                placeholder="nincs limit"
                className="mt-1 block w-40 rounded-md border border-line/60 bg-panel/40 px-2 py-1 text-sm"
              />
            </label>
          </div>
        </section>

        <section className="space-y-3 border-t border-line/40 pt-5">
          <div>
            <h3 className="text-sm font-semibold text-ink">Per-agent keret</h3>
            <p className="text-xs text-ink-faint">
              Minden agentre külön-külön érvényes. Ez akadályozza meg, hogy egyetlen elszaladt
              agent megegye a tenant egész keretét.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <label className="text-xs text-ink-soft">
              Hívás / nap / agent
              <input
                type="number"
                min={1}
                value={draft.perAgent.callLimit}
                onChange={(e) => updateDraft('perAgent', 'callLimit', e.target.value)}
                disabled={!canEdit || pending}
                placeholder="nincs limit"
                className="mt-1 block w-40 rounded-md border border-line/60 bg-panel/40 px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-ink-soft">
              Token / nap / agent
              <input
                type="number"
                min={1}
                value={draft.perAgent.tokenLimit}
                onChange={(e) => updateDraft('perAgent', 'tokenLimit', e.target.value)}
                disabled={!canEdit || pending}
                placeholder="nincs limit"
                className="mt-1 block w-40 rounded-md border border-line/60 bg-panel/40 px-2 py-1 text-sm"
              />
            </label>
          </div>

          {overview.usage.agents.length === 0 ? (
            <p className="text-xs text-ink-faint">Ma még egyetlen agent sem hívott modellt.</p>
          ) : (
            <ul className="space-y-2">
              {overview.usage.agents.map((agent) => (
                <li key={agent.agentId} className="rounded-lg border border-line/40 bg-panel/30 p-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium text-ink">{agent.name}</span>
                    <span className="text-xs text-ink-faint">
                      {agent.calls.toLocaleString('hu-HU')} hívás
                      {effectivePerAgentCalls !== null && ` / ${effectivePerAgentCalls.toLocaleString('hu-HU')}`}
                    </span>
                  </div>
                  <div className="mt-2">
                    <UsageBar used={agent.tokens} limit={effectivePerAgentTokens} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {canEdit && (
          <div className="flex items-center gap-3 border-t border-line/40 pt-4">
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className="rounded-md bg-coral px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? 'Mentés…' : 'Keret mentése'}
            </button>
            {message && (
              <span className={`text-xs ${message.tone === 'ok' ? 'text-emerald-600' : 'text-coral'}`}>
                {message.text}
              </span>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}
