'use client'

import { useEffect, useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import type { ModelRoutingPolicy, ModelBudget } from '@prisma/client'
import {
  createModelRoutingPolicy,
  deleteModelRoutingPolicy,
  createModelBudget,
  deleteModelBudget,
  getFallbackChain,
  setFallbackChain,
  previewEffectiveFallbackChain,
  getModelPricingView,
  setManualModelPrice,
  clearManualModelPrice,
  listAgents,
} from '@/app/actions/platform'
import type { ModelCallGovernanceSummary, ModelCallTicketBreakdown } from '@/repositories/interfaces'
import { MODEL_PROVIDERS } from '@/lib/model-providers'

type GatewaySummaryData = {
  summary: ModelCallGovernanceSummary
  breakdown: ModelCallTicketBreakdown[]
  sinceHours: number
}

type FallbackCandidate = { provider: string; model: string }

function StatBox({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-line/60 bg-panel/40 p-3 text-center">
      <p className="text-xs text-ink-faint">{label}</p>
      <p className="mt-1 text-lg font-semibold text-ink">{value}</p>
    </div>
  )
}

function ExplainBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-line/40 bg-panel/30 px-3 py-2 text-xs text-ink-soft space-y-1">
      {children}
    </div>
  )
}

function isLocalProvider(provider: string): boolean {
  return provider === 'ollama'
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

function FallbackChainSection({ canEdit }: { canEdit: boolean }) {
  const [chain, setChain] = useState<FallbackCandidate[]>([])
  const [loaded, setLoaded] = useState(false)
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [newProvider, setNewProvider] = useState(MODEL_PROVIDERS[0]?.value ?? 'chatgpt-oauth')
  const [newModel, setNewModel] = useState(MODEL_PROVIDERS[0]?.defaultModel ?? '')
  const [agents, setAgents] = useState<Array<{ id: string; name: string; modelConfig: unknown }>>([])
  const [previewAgentId, setPreviewAgentId] = useState('')
  const [previewSensitive, setPreviewSensitive] = useState(false)
  const [preview, setPreview] = useState<{
    chain: FallbackCandidate[]
    sensitiveBranch: boolean
  } | null>(null)

  useEffect(() => {
    void (async () => {
      const [chainRes, agentsRes] = await Promise.all([getFallbackChain(), listAgents()])
      if (chainRes.success) setChain(chainRes.data)
      if (agentsRes.success) {
        setAgents(
          agentsRes.data.map((a: { id: string; name: string; modelConfig: unknown }) => ({
            id: a.id,
            name: a.name,
            modelConfig: a.modelConfig,
          })),
        )
      }
      setLoaded(true)
    })()
  }, [])

  function move(index: number, dir: -1 | 1) {
    const next = [...chain]
    const j = index + dir
    if (j < 0 || j >= next.length) return
    ;[next[index], next[j]] = [next[j]!, next[index]!]
    setChain(next)
  }

  function save() {
    setMsg(null)
    startTransition(async () => {
      const res = await setFallbackChain({ chain })
      if (res.success) {
        setChain(res.data)
        setMsg({ tone: 'ok', text: 'Tartalék-lánc mentve.' })
      } else {
        setMsg({ tone: 'err', text: res.error })
      }
    })
  }

  function runPreview() {
    setMsg(null)
    startTransition(async () => {
      const agent = agents.find((a) => a.id === previewAgentId)
      const cfg = (agent?.modelConfig ?? {}) as { provider?: string; model?: string }
      const res = await previewEffectiveFallbackChain({
        agentId: previewAgentId || undefined,
        provider: cfg.provider || 'chatgpt-oauth',
        model: cfg.model || 'chatgpt-oauth-default',
        simulateSensitive: previewSensitive,
      })
      if (res.success) {
        setPreview(res.data)
      } else {
        setMsg({ tone: 'err', text: res.error })
      }
    })
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Tartalék-lánc (kiesés-védelem)</p>
      <ExplainBox>
        <p>
          Ha az elsődleges modell-szolgáltató nem elérhető, rate-limitel, auth hibát ad, vagy a modell eltűnt,
          a Gateway a lista következő jelöltjére vált. A próbálkozások száma felülről korlátozott
          (GATEWAY_FALLBACK_MAX_ATTEMPTS, alapértelmezés: 3).
        </p>
        <p>
          <strong>Vált:</strong> szolgáltató kiesés, 429, auth (401/403), ismeretlen modell.
          <br />
          <strong>Nem vált:</strong> keret kimerülés, érzékenységi blokk, tartalmi hiba (pl. túl hosszú kontextus).
        </p>
        <p>Érzékeny kérésnél a lánc csak helyi jelölteket tartalmazhat — adat nem hagyhatja el a platformot.</p>
      </ExplainBox>

      {!loaded ? (
        <p className="text-sm text-ink-faint">Betöltés…</p>
      ) : chain.length === 0 ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          Nincs beállítva tartalék-lista — szolgáltatói kieséskor a hívás hibára fut (nincs automatikus kitérő).
        </p>
      ) : (
        <div className="space-y-2">
          {chain.map((c, i) => (
            <div
              key={`${c.provider}/${c.model}/${i}`}
              className="flex items-center justify-between rounded-md border border-line/50 bg-night/40 px-3 py-2 text-sm"
            >
              <div>
                <span className="font-medium text-ink">
                  {i + 1}. {c.provider}/{c.model}
                </span>
                <span
                  className={`ml-2 rounded px-1.5 py-0.5 text-[10px] uppercase ${
                    isLocalProvider(c.provider)
                      ? 'bg-sage/20 text-sage'
                      : 'bg-coral/15 text-coral'
                  }`}
                >
                  {isLocalProvider(c.provider) ? 'helyi' : 'külső'}
                </span>
              </div>
              {canEdit && (
                <div className="flex gap-2">
                  <button type="button" disabled={pending || i === 0} onClick={() => move(i, -1)} className="text-xs text-ink-soft disabled:opacity-30">
                    ↑
                  </button>
                  <button type="button" disabled={pending || i === chain.length - 1} onClick={() => move(i, 1)} className="text-xs text-ink-soft disabled:opacity-30">
                    ↓
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => setChain((prev) => prev.filter((_, j) => j !== i))}
                    className="text-xs text-coral"
                  >
                    Töröl
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {canEdit && (
        <div className="grid grid-cols-2 gap-2 rounded-md border border-line/40 bg-panel/20 p-3 md:grid-cols-4">
          <select
            value={newProvider}
            onChange={(e) => {
              const p = MODEL_PROVIDERS.find((x) => x.value === e.target.value)
              setNewProvider(e.target.value)
              if (p) setNewModel(p.defaultModel)
            }}
            className="rounded border border-line/50 bg-night/60 px-2 py-1 text-xs text-ink"
          >
            {MODEL_PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <input
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            placeholder="model"
            className="rounded border border-line/50 bg-night/60 px-2 py-1 text-xs text-ink"
          />
          <button
            type="button"
            disabled={pending || !newModel}
            onClick={() => setChain((prev) => [...prev, { provider: newProvider, model: newModel.trim() }])}
            className="rounded-md border border-line/50 px-3 py-1 text-xs text-ink disabled:opacity-50"
          >
            Hozzáad
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={save}
            className="rounded-md bg-coral px-3 py-1 text-xs font-medium text-night disabled:opacity-50"
          >
            Mentés
          </button>
        </div>
      )}

      <div className="space-y-2 rounded-md border border-line/40 bg-panel/20 p-3">
        <p className="text-xs font-medium text-ink">Effektív előnézet</p>
        <div className="flex flex-wrap gap-2">
          <select
            value={previewAgentId}
            onChange={(e) => setPreviewAgentId(e.target.value)}
            className="rounded border border-line/50 bg-night/60 px-2 py-1 text-xs text-ink"
          >
            <option value="">— agent nélkül (csak globális) —</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-xs text-ink-soft">
            <input
              type="checkbox"
              checked={previewSensitive}
              onChange={(e) => setPreviewSensitive(e.target.checked)}
            />
            érzékeny ág
          </label>
          <button
            type="button"
            disabled={pending}
            onClick={runPreview}
            className="rounded-md border border-line/50 px-3 py-1 text-xs text-ink"
          >
            Előnézet
          </button>
        </div>
        {preview && (
          <ol className="list-decimal space-y-1 pl-4 text-xs text-ink">
            {preview.chain.map((c, i) => (
              <li key={`${c.provider}/${c.model}/${i}`}>
                {c.provider}/{c.model}
                {preview.sensitiveBranch ? ' · érzékeny (helyi)' : ''}
                <span className="ml-1 text-ink-faint">
                  ({isLocalProvider(c.provider) ? 'helyi' : 'külső'})
                </span>
              </li>
            ))}
            {preview.chain.length === 0 && <li className="list-none text-coral">Üres lánc — a hívás elbukik.</li>}
          </ol>
        )}
      </div>

      {msg && (
        <p className={`text-xs ${msg.tone === 'ok' ? 'text-emerald-400' : 'text-coral'}`}>{msg.text}</p>
      )}
    </div>
  )
}

function PricingSection({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<
    Array<{ model: string; price: { inputPerMTokens: number; outputPerMTokens: number }; source: string }>
  >([])
  const [syncMeta, setSyncMeta] = useState<{
    lastSyncedAt: string
    sourceFingerprint: string
    sourceLabel?: string
    eurPerUsd: number
    rateAsOf: string
  } | null>(null)
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [editModel, setEditModel] = useState('')
  const [editIn, setEditIn] = useState('')
  const [editOut, setEditOut] = useState('')

  function reload() {
    startTransition(async () => {
      const res = await getModelPricingView()
      if (res.success) {
        setRows(res.data.rows)
        setSyncMeta(res.data.syncMeta)
      }
    })
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sourceLabel: Record<string, string> = {
    builtin: 'alap',
    synced: 'szinkronizált',
    manual: 'kézi',
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">Modell-árazás (€ / 1M token)</p>
      <ExplainBox>
        <p>
          Három réteg: beépített alap → szinkronizált (CLI) → kézi felülírás. A felső réteg mindig nyer.
          A szinkron parancssorból fut (<code className="text-ink">npx tsx scripts/sync-model-pricing.ts</code>),
          innen csak a státusz látszik — böngészőből nincs indító gomb.
        </p>
      </ExplainBox>

      <div className="rounded-md border border-line/40 bg-night/40 px-3 py-2 text-xs text-ink-soft">
        {syncMeta ? (
          <>
            Utolsó szinkron: {new Date(syncMeta.lastSyncedAt).toLocaleString('hu-HU')} · forrás:{' '}
            {syncMeta.sourceLabel ?? syncMeta.sourceFingerprint} · árfolyam: {syncMeta.eurPerUsd} EUR/USD (
            {syncMeta.rateAsOf})
          </>
        ) : (
          <>Még nem futott szinkron — a beépített / kézi tarifák érvényesek.</>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-ink-faint">
              <th className="pb-1 pr-3">Modell</th>
              <th className="pb-1 pr-3">Input €</th>
              <th className="pb-1 pr-3">Output €</th>
              <th className="pb-1 pr-3">Réteg</th>
              {canEdit && <th className="pb-1">Művelet</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.model} className="border-t border-line/30">
                <td className="py-1 pr-3 font-mono text-ink">{row.model}</td>
                <td className="py-1 pr-3 text-ink">{row.price.inputPerMTokens}</td>
                <td className="py-1 pr-3 text-ink">{row.price.outputPerMTokens}</td>
                <td className="py-1 pr-3 text-ink-faint">{sourceLabel[row.source] ?? row.source}</td>
                {canEdit && (
                  <td className="py-1">
                    {row.source === 'manual' && (
                      <button
                        type="button"
                        disabled={pending}
                        className="text-xs text-coral"
                        onClick={() => {
                          setMsg(null)
                          startTransition(async () => {
                            const res = await clearManualModelPrice({ model: row.model })
                            if (res.success) {
                              setMsg({ tone: 'ok', text: 'Visszaállítva a szinkronizált/alap értékre.' })
                              reload()
                            } else setMsg({ tone: 'err', text: res.error })
                          })
                        }}
                      >
                        Visszaállítás
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canEdit && (
        <div className="grid grid-cols-2 gap-2 rounded-md border border-line/40 bg-panel/20 p-3 md:grid-cols-5">
          <input
            placeholder="modell kulcs"
            value={editModel}
            onChange={(e) => setEditModel(e.target.value)}
            className="rounded border border-line/50 bg-night/60 px-2 py-1 text-xs text-ink"
          />
          <input
            type="number"
            step="0.01"
            placeholder="input €/1M"
            value={editIn}
            onChange={(e) => setEditIn(e.target.value)}
            className="rounded border border-line/50 bg-night/60 px-2 py-1 text-xs text-ink"
          />
          <input
            type="number"
            step="0.01"
            placeholder="output €/1M"
            value={editOut}
            onChange={(e) => setEditOut(e.target.value)}
            className="rounded border border-line/50 bg-night/60 px-2 py-1 text-xs text-ink"
          />
          <button
            type="button"
            disabled={pending || !editModel || !editIn || !editOut}
            className="rounded-md bg-coral px-3 py-1 text-xs font-medium text-night disabled:opacity-50"
            onClick={() => {
              setMsg(null)
              startTransition(async () => {
                const res = await setManualModelPrice({
                  model: editModel.trim(),
                  inputPerMTokens: Number(editIn),
                  outputPerMTokens: Number(editOut),
                })
                if (res.success) {
                  setMsg({ tone: 'ok', text: 'Kézi tarifa mentve.' })
                  setEditModel('')
                  setEditIn('')
                  setEditOut('')
                  reload()
                } else setMsg({ tone: 'err', text: res.error })
              })
            }}
          >
            Kézi mentés
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
        <div>
          <p className="mb-3 text-xs text-ink-soft">
            Utolsó {sinceHours >= 24 ? `${Math.round(sinceHours / 24)} nap` : `${sinceHours} óra`}
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatBox label="Összes hívás" value={summary.calls} />
            <StatBox label="Sikeres" value={summary.okCalls} />
            <StatBox label="Hiba" value={summary.errorCalls} />
            <StatBox label="Rate limited" value={summary.rateLimitedCalls} />
            <StatBox label="Tartalék-váltás" value={summary.fallbackSwitches ?? 0} />
            <StatBox label="Tokenek (becsült)" value={summary.tokens.toLocaleString('hu-HU')} />
            <StatBox label="Avg latency (ms)" value={summary.avgLatencyMs} />
            <StatBox label="Becsült költség (€)" value={summary.cost.toFixed(4)} />
            <StatBox
              label="Sikerráta"
              value={summary.calls > 0 ? `${Math.round((summary.okCalls / summary.calls) * 100)}%` : '—'}
            />
          </div>
        </div>

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
        <FallbackChainSection canEdit={canEdit} />
        <hr className="border-line/40" />
        <PricingSection canEdit={canEdit} />
        <hr className="border-line/40" />
        <RoutingPoliciesSection initial={routingPolicies} canEdit={canEdit} />
        <hr className="border-line/40" />
        <BudgetsSection initial={budgets} canEdit={canEdit} />
      </div>
    </Card>
  )
}
