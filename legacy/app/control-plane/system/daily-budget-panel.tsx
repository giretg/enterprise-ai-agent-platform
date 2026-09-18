'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import {
  createModelBudget,
  deleteModelBudget,
  setGatewayTicketCallCap,
  setTenantDailyBudget,
  updateModelBudget,
  type BudgetLimits,
  type BudgetRuleView,
  type DailyBudgetOverview,
} from '@/app/actions/platform'
import type { GatewayTicketCallCapView } from '@/domain/platform-settings/platform-settings-service'

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

function hu(n: number): string {
  return n.toLocaleString('hu-HU')
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

/**
 * Egy dimenzió (hívás vagy token) kihasználtsága: mennyi fogyott a keretből, és
 * mennyi van hátra. Korlát nélkül is kiírjuk a fogyasztást — enélkül nem derülne ki,
 * hogy mekkora forgalomra kellene a keretet szabni.
 */
function LimitMeter({
  label,
  used,
  limit,
}: {
  label: string
  used: number
  limit: number | null
}) {
  if (limit === null) {
    return (
      <div className="space-y-1">
        <p className="text-xs text-ink-soft">
          <span className="font-medium">{label}:</span> {hu(used)} eddig · nincs korlát
        </p>
      </div>
    )
  }
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0
  const percent = Math.round((limit > 0 ? used / limit : 0) * 100)
  const tone = ratio >= 1 ? 'bg-coral' : ratio >= 0.8 ? 'bg-amber-500' : 'bg-emerald-500'
  const remaining = Math.max(0, limit - used)
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-ink-soft">{label}</span>
        <span className="text-xs text-ink-faint">
          {hu(used)} / {hu(limit)} ({percent}%)
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-line/50">
        <div className={`h-full ${tone}`} style={{ width: `${ratio * 100}%` }} />
      </div>
      <p className={`text-xs ${ratio >= 1 ? 'text-coral' : 'text-ink-faint'}`}>
        {ratio >= 1
          ? 'A keret elfogyott — a munka blokkolva, amíg a keret nem nő vagy le nem telik az időszak.'
          : `${hu(remaining)} maradt`}
      </p>
    </div>
  )
}

/** Hívás + token kihasználtság egy blokkban — ez a „hol tartunk” a kereteknél. */
function UsageMeters({
  usage,
  callLimit,
  tokenLimit,
  note,
}: {
  usage: { calls: number; tokens: number }
  callLimit: number | null
  tokenLimit: number | null
  note?: string
}) {
  return (
    <div className="space-y-2 rounded-lg border border-line/40 bg-panel/20 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Jelenlegi kihasználtság
      </p>
      {note && <p className="text-xs text-ink-faint">{note}</p>}
      <LimitMeter label="Hívás" used={usage.calls} limit={callLimit} />
      <LimitMeter label="Token" used={usage.tokens} limit={tokenLimit} />
    </div>
  )
}

/** Szabad szöveges „mit jelent ez” doboz — a szakszavakat itt fordítjuk le. */
function Explain({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line/40 bg-panel/30 px-3 py-2 text-xs text-ink-soft">
      {children}
    </div>
  )
}

const PERIOD_LABEL: Record<string, string> = {
  day: 'naponta',
  week: 'hetente',
  month: 'havonta',
}

/**
 * Egy keretszabály egy mondatban: kire vonatkozik, milyen időszakra, mennyi a korlát.
 * A UUID sosem kerül a felhasználó elé — a munkatárs a nevén szerepel.
 */
function ruleTitle(
  rule: BudgetRuleView,
  agentNameById: Map<string, string>,
): { who: string; hint: string } {
  if (rule.scope === 'tenant') {
    return {
      who: 'Az egész szervezet együtt',
      hint: 'A szervezet összes AI munkatársának közös fogyasztása.',
    }
  }
  if (rule.scope === 'agent') {
    if (rule.scopeRef) {
      return {
        who: agentNameById.get(rule.scopeRef) ?? `Ismeretlen munkatárs (${rule.scopeRef.slice(0, 8)}…)`,
        hint: 'Csak erre az egy AI munkatársra érvényes.',
      }
    }
    return {
      who: 'Minden AI munkatárs — külön-külön',
      hint: 'Mindegyik munkatársra egyenként érvényes, nem összeadva.',
    }
  }
  return {
    who: `„${rule.scopeRef ?? '—'}” feladattípus`,
    hint: 'Az ilyen típusú feladatokra elszámolt hívásokra érvényes.',
  }
}

/** Mit jelent a mért szám ennél a szabálynál — máshogy mérünk hatókörönként. */
function usageNote(rule: BudgetRuleView): string | undefined {
  const window =
    rule.period === 'day' ? 'az elmúlt 24 órában' : rule.period === 'week' ? 'az elmúlt 7 napban' : 'az elmúlt 30 napban'
  if (rule.usage.peakAgentName) {
    return `A legterheltebb munkatárs (${rule.usage.peakAgentName}) fogyasztása ${window} — ő éri el először a korlátot.`
  }
  if (rule.scope === 'tenant') return `A szervezet együttes fogyasztása ${window}.`
  if (rule.scope === 'ticket_type') return `Az ilyen típusú feladatok fogyasztása ${window}.`
  if (rule.tenantId === null) {
    return `Ebben a szervezetben mérve, ${window} (a szabály a többi szervezetre is érvényes).`
  }
  return `Ennek a munkatársnak a fogyasztása ${window}.`
}

function limitsSentence(rule: { callLimit: number | null; tokenLimit: number | null }): string {
  const parts: string[] = []
  if (rule.callLimit !== null) parts.push(`${hu(rule.callLimit)} hívás`)
  if (rule.tokenLimit !== null) parts.push(`${hu(rule.tokenLimit)} token`)
  return parts.length > 0 ? parts.join(' · ') : 'nincs megadva korlát (nem fog blokkolni)'
}

/** Egy szerkeszthető keretszabály-sor. */
function RuleRow({
  rule,
  ownTenantId,
  agentNameById,
  canEdit,
  onChanged,
  onDeleted,
}: {
  rule: BudgetRuleView
  ownTenantId: string
  agentNameById: Map<string, string>
  canEdit: boolean
  onChanged: (next: BudgetRuleView) => void
  onDeleted: (id: string) => void
}) {
  const [draft, setDraft] = useState({
    callLimit: formatLimit(rule.callLimit),
    tokenLimit: formatLimit(rule.tokenLimit),
    hardCap: rule.hardCap,
  })
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const router = useRouter()
  const { who, hint } = ruleTitle(rule, agentNameById)
  const platformWide = rule.tenantId === null
  const dirty =
    draft.callLimit !== formatLimit(rule.callLimit) ||
    draft.tokenLimit !== formatLimit(rule.tokenLimit) ||
    draft.hardCap !== rule.hardCap

  function save() {
    setMsg(null)
    startTransition(async () => {
      const res = await updateModelBudget({
        id: rule.id,
        callLimit: parseLimit(draft.callLimit),
        tokenLimit: parseLimit(draft.tokenLimit),
        hardCap: draft.hardCap,
      })
      if (res.success) {
        onChanged(res.data)
        // A kihasználtsági mérők a szerverről jönnek — a mentett korláthoz tartozó
        // friss százalék csak újratöltés után pontos.
        router.refresh()
        setMsg({ tone: 'ok', text: 'Mentve — a következő agent-indítástól ez érvényes.' })
      } else {
        setMsg({ tone: 'err', text: res.error })
      }
    })
  }

  function remove() {
    setMsg(null)
    startTransition(async () => {
      const res = await deleteModelBudget({ id: rule.id })
      if (res.success) {
        onDeleted(rule.id)
        router.refresh()
      } else setMsg({ tone: 'err', text: res.error })
    })
  }

  return (
    <li className="rounded-lg border border-line/40 bg-panel/30 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-ink">
            {who}
            <span className="ml-2 font-normal text-ink-faint">
              {PERIOD_LABEL[rule.period] ?? rule.period}
            </span>
          </p>
          <p className="text-xs text-ink-faint">{hint}</p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] ${
            platformWide
              ? 'border border-amber-500/40 bg-amber-500/10 text-ink'
              : 'border border-line/50 text-ink-faint'
          }`}
          title={
            platformWide
              ? 'Ez a szabály MINDEN szervezetre érvényes, nem csak erre.'
              : 'Csak ebben a szervezetben érvényes.'
          }
        >
          {platformWide ? 'Minden szervezetre' : 'Ez a szervezet'}
        </span>
      </div>

      <p className="mt-2 text-xs text-ink-soft">
        Jelenlegi korlát: <span className="font-medium text-ink">{limitsSentence(rule)}</span>
        {' · '}
        {rule.hardCap ? 'elérésekor leáll' : 'elérésekor csak figyelmeztet'}
      </p>

      <div className="mt-3">
        <UsageMeters
          usage={rule.usage}
          callLimit={rule.callLimit}
          tokenLimit={rule.tokenLimit}
          note={usageNote(rule)}
        />
      </div>

      {canEdit && (
        <>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-xs text-ink-soft">
              Hívás / időszak
              <input
                type="number"
                min={1}
                value={draft.callLimit}
                disabled={pending}
                onChange={(e) => setDraft((d) => ({ ...d, callLimit: e.target.value }))}
                placeholder="nincs korlát"
                className="mt-1 block w-40 rounded-md border border-line/60 bg-panel/40 px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-ink-soft">
              Token / időszak
              <input
                type="number"
                min={1}
                value={draft.tokenLimit}
                disabled={pending}
                onChange={(e) => setDraft((d) => ({ ...d, tokenLimit: e.target.value }))}
                placeholder="nincs korlát"
                className="mt-1 block w-44 rounded-md border border-line/60 bg-panel/40 px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-ink-soft">
              Ha eléri
              <select
                value={draft.hardCap ? 'hard' : 'soft'}
                disabled={pending}
                onChange={(e) => setDraft((d) => ({ ...d, hardCap: e.target.value === 'hard' }))}
                className="mt-1 block w-56 rounded-md border border-line/60 bg-panel/40 px-2 py-1 text-sm"
              >
                <option value="hard">Leállítja a munkát (blokkol)</option>
                <option value="soft">Csak figyelmeztet, tovább fut</option>
              </select>
            </label>
            <button
              type="button"
              onClick={save}
              disabled={pending || !dirty}
              className="rounded-md bg-coral px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              {pending ? 'Mentés…' : 'Mentés'}
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={pending}
              className="text-xs text-coral hover:underline disabled:opacity-50"
            >
              Szabály törlése
            </button>
          </div>
          {rule.tenantId !== null && rule.tenantId !== ownTenantId && (
            <p className="mt-2 text-xs text-ink-faint">
              Másik szervezet szabálya — csak ott szerkeszthető.
            </p>
          )}
        </>
      )}

      {msg && (
        <p className={`mt-2 text-xs ${msg.tone === 'ok' ? 'text-emerald-600' : 'text-coral'}`}>
          {msg.text}
        </p>
      )}
    </li>
  )
}

/** Új egyedi keretszabály — a hatókör választása vezetett, UUID-t nem kell ismerni. */
function NewRuleForm({
  agents,
  onCreated,
}: {
  agents: Array<{ id: string; name: string }>
  onCreated: (rule: BudgetRuleView) => void
}) {
  const [scope, setScope] = useState<'tenant' | 'agent' | 'ticket_type'>('agent')
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '')
  const [ticketType, setTicketType] = useState('')
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('day')
  const [callLimit, setCallLimit] = useState('')
  const [tokenLimit, setTokenLimit] = useState('')
  const [appliesTo, setAppliesTo] = useState<'tenant' | 'platform'>('tenant')
  const [hardCap, setHardCap] = useState(true)
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const router = useRouter()

  const scopeRef = scope === 'agent' ? agentId : scope === 'ticket_type' ? ticketType.trim() : ''
  const missingScopeRef =
    (scope === 'agent' && !agentId) || (scope === 'ticket_type' && !ticketType.trim())
  const noLimits = !parseLimit(callLimit) && !parseLimit(tokenLimit)

  function add() {
    setMsg(null)
    startTransition(async () => {
      const res = await createModelBudget({
        scope,
        ...(scopeRef ? { scopeRef } : {}),
        period,
        ...(parseLimit(callLimit) ? { callLimit: parseLimit(callLimit)! } : {}),
        ...(parseLimit(tokenLimit) ? { tokenLimit: parseLimit(tokenLimit)! } : {}),
        hardCap,
        appliesTo,
      })
      if (res.success) {
        onCreated(res.data)
        router.refresh()
        setCallLimit('')
        setTokenLimit('')
        setTicketType('')
        setMsg({ tone: 'ok', text: 'Szabály létrehozva.' })
      } else {
        setMsg({ tone: 'err', text: res.error })
      }
    })
  }

  return (
    <div className="space-y-3 rounded-lg border border-line/40 bg-panel/20 p-3">
      <p className="text-sm font-medium text-ink">Új keretszabály</p>

      <div className="flex flex-wrap gap-3">
        <label className="text-xs text-ink-soft">
          Kire vonatkozzon?
          <select
            value={scope}
            disabled={pending}
            onChange={(e) => setScope(e.target.value as typeof scope)}
            className="mt-1 block w-64 rounded-md border border-line/60 bg-panel/40 px-2 py-1 text-sm"
          >
            <option value="agent">Egy adott AI munkatársra</option>
            <option value="tenant">Az egész szervezetre (összesítve)</option>
            <option value="ticket_type">Egy feladattípusra</option>
          </select>
        </label>

        {scope === 'agent' && (
          <label className="text-xs text-ink-soft">
            Melyik munkatársra?
            <select
              value={agentId}
              disabled={pending || agents.length === 0}
              onChange={(e) => setAgentId(e.target.value)}
              className="mt-1 block w-56 rounded-md border border-line/60 bg-panel/40 px-2 py-1 text-sm"
            >
              {agents.length === 0 && <option value="">Nincs AI munkatárs</option>}
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {scope === 'ticket_type' && (
          <label className="text-xs text-ink-soft">
            Melyik feladattípusra?
            <input
              value={ticketType}
              disabled={pending}
              onChange={(e) => setTicketType(e.target.value)}
              placeholder="pl. interaction"
              className="mt-1 block w-56 rounded-md border border-line/60 bg-panel/40 px-2 py-1 text-sm"
            />
          </label>
        )}

        <label className="text-xs text-ink-soft">
          Milyen időszakra?
          <select
            value={period}
            disabled={pending}
            onChange={(e) => setPeriod(e.target.value as typeof period)}
            className="mt-1 block w-40 rounded-md border border-line/60 bg-panel/40 px-2 py-1 text-sm"
          >
            <option value="day">Naponta</option>
            <option value="week">Hetente</option>
            <option value="month">Havonta</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-3">
        <label className="text-xs text-ink-soft">
          Hívás korlát <span className="text-ink-faint">(üres = nincs)</span>
          <input
            type="number"
            min={1}
            value={callLimit}
            disabled={pending}
            onChange={(e) => setCallLimit(e.target.value)}
            placeholder="nincs korlát"
            className="mt-1 block w-40 rounded-md border border-line/60 bg-panel/40 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-ink-soft">
          Token korlát <span className="text-ink-faint">(üres = nincs)</span>
          <input
            type="number"
            min={1}
            value={tokenLimit}
            disabled={pending}
            onChange={(e) => setTokenLimit(e.target.value)}
            placeholder="nincs korlát"
            className="mt-1 block w-44 rounded-md border border-line/60 bg-panel/40 px-2 py-1 text-sm"
          />
          {parseLimit(tokenLimit) !== null && (
            <span className="mt-1 block text-[11px] text-ink-faint">= {hu(parseLimit(tokenLimit)!)}</span>
          )}
        </label>
        <label className="text-xs text-ink-soft">
          Ha eléri
          <select
            value={hardCap ? 'hard' : 'soft'}
            disabled={pending}
            onChange={(e) => setHardCap(e.target.value === 'hard')}
            className="mt-1 block w-56 rounded-md border border-line/60 bg-panel/40 px-2 py-1 text-sm"
          >
            <option value="hard">Leállítja a munkát (blokkol)</option>
            <option value="soft">Csak figyelmeztet, tovább fut</option>
          </select>
        </label>
        <label className="text-xs text-ink-soft">
          Hatálya
          <select
            value={appliesTo}
            disabled={pending}
            onChange={(e) => setAppliesTo(e.target.value as typeof appliesTo)}
            className="mt-1 block w-56 rounded-md border border-line/60 bg-panel/40 px-2 py-1 text-sm"
          >
            <option value="tenant">Csak ez a szervezet</option>
            <option value="platform">Minden szervezet</option>
          </select>
        </label>
      </div>

      {appliesTo === 'platform' && (
        <p className="text-xs text-amber-600">
          Figyelem: ez a szabály az ÖSSZES szervezet AI munkatársaira érvényes lesz.
        </p>
      )}
      {noLimits && (
        <p className="text-xs text-ink-faint">
          Adj meg legalább egy korlátot — korlát nélkül a szabály nem csinál semmit.
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={add}
          disabled={pending || missingScopeRef || noLimits}
          className="rounded-md bg-coral px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {pending ? 'Létrehozás…' : 'Szabály hozzáadása'}
        </button>
        {msg && (
          <span className={`text-xs ${msg.tone === 'ok' ? 'text-emerald-600' : 'text-coral'}`}>
            {msg.text}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Model-keretek egy helyen: a napi alapkeretek (szervezeti + minden munkatársra
 * érvényes alapértelmezés), a mai tényleges fogyasztás, és az ezektől eltérő
 * egyedi keretszabályok.
 *
 * Korábban ez két külön fül volt („Napi model-keret" és „Budget szabályok"), és a
 * második nyers adatbázis-mezőket mutatott (scope / scopeRef / hard cap, UUID-vel) —
 * abból nem derült ki, mire vonatkozik a korlát, és a sorokat csak törölni lehetett.
 */
export function DailyBudgetPanel({
  overview,
  canEdit,
  rules: initialRules,
  canEditRules,
  ticketCallCap,
  canEditTicketCallCap = false,
}: {
  overview: DailyBudgetOverview
  canEdit: boolean
  /** Az összes ide tartozó keretsor (saját szervezet + platform-szintű). */
  rules: BudgetRuleView[]
  /** Egyedi szabályt csak platform-superadmin szerkeszthet. */
  canEditRules: boolean
  ticketCallCap?: GatewayTicketCallCapView | null
  /** Platform-szintű feladat-ticket plafon — csak superadmin. */
  canEditTicketCallCap?: boolean
}) {
  const [draft, setDraft] = useState<DailyBudgetDraft>({
    tenant: toDraft(overview.tenant),
    perAgent: toDraft(overview.perAgent),
  })
  const [ticketCallCapDraft, setTicketCallCapDraft] = useState(
    ticketCallCap ? String(ticketCallCap.maxCallsPerTicket) : '',
  )
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [rules, setRules] = useState(initialRules)
  const router = useRouter()

  const nothingConfigured = !overview.tenant.configured && !overview.perAgent.configured
  const effectivePerAgentTokens = overview.perAgent.configured
    ? overview.perAgent.tokenLimit
    : overview.envFallback.maxTokensPerDay
  const effectivePerAgentCalls = overview.perAgent.configured
    ? overview.perAgent.callLimit
    : overview.envFallback.maxCallsPerDay

  const agentNameById = new Map(overview.agents.map((a) => [a.id, a.name]))

  // Akinek saját napi kerete van ebben a szervezetben, arra NEM az alapértelmezés
  // vonatkozik — a kihasználtságát is a saját keretéhez mérjük. (A platform-szintű
  // nevesített szabály nem váltja ki a szervezeti alapértelmezést, ezért nem kerül ide.)
  const ruleByAgentId = new Map(
    rules
      .filter(
        (rule) =>
          rule.scope === 'agent' &&
          rule.scopeRef !== null &&
          rule.period === 'day' &&
          rule.tenantId === overview.tenantId,
      )
      .map((rule) => [rule.scopeRef as string, rule]),
  )

  // A két napi alapkeret-sort a felső szekció szerkeszti — ne jelenjen meg
  // ugyanaz kétszer, más szóhasználattal.
  const extraRules = rules.filter(
    (rule) =>
      !(
        rule.tenantId === overview.tenantId &&
        rule.period === 'day' &&
        rule.scopeRef === null &&
        (rule.scope === 'tenant' || rule.scope === 'agent')
      ),
  )

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

  function saveTicketCallCap() {
    const parsed = parseLimit(ticketCallCapDraft)
    if (parsed === null) {
      setMessage({ tone: 'err', text: 'A feladat-ticket plafon pozitív egész szám kell legyen.' })
      return
    }
    startTransition(async () => {
      const res = await setGatewayTicketCallCap({ maxCallsPerTicket: parsed })
      if (res.success) router.refresh()
      setMessage(
        res.success
          ? { tone: 'ok', text: 'Feladat-ticket modellhívás-plafon mentve.' }
          : { tone: 'err', text: res.error },
      )
    })
  }

  function save() {
    startTransition(async () => {
      const res = await setTenantDailyBudget({
        tenant: fromDraft(draft.tenant),
        perAgent: fromDraft(draft.perAgent),
      })
      // Refresh nélkül a mentett keret és a hozzá tartozó kihasználtság csak a
      // következő oldalbetöltésnél jelenne meg — a „nincs beállított keret”
      // figyelmeztetés bent ragadna a mentés után.
      if (res.success) router.refresh()
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
          <h2 className="font-display text-xl font-semibold">Model-keretek</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Itt szabod meg, mennyit dolgozhatnak egy nap alatt az AI munkatársak. A keret két
            dolgot mér: hány <em>hívást</em> indítanak a nyelvi modell felé, és mennyi{' '}
            <em>tokent</em> fogyasztanak (a token a szöveg mértékegysége — ebből jön ki a
            költség).
          </p>
        </div>

        <Explain>
          <p>
            <strong>Ha egy keret elfogy:</strong> az érintett AI munkatárs feladatai a{' '}
            <span className="font-mono text-[11px]">„Végrehajtásra vár”</span> oszlopban maradnak, és
            a chat is hibát ad. Nem vész el semmi — a keret emelése vagy a 24 óra letelte után
            magától folytatódik.
          </p>
          <p className="mt-1">
            <strong>A fogyasztás gördülő 24 órás ablakon</strong> számol, nem éjfélkor nullázódik.
            Üres mező = nincs korlát az adott dimenzióban.
          </p>
        </Explain>

        {ticketCallCap && (
          <section className="space-y-3 rounded-lg border border-line/50 bg-panel/20 p-4">
            <div>
              <h3 className="text-sm font-semibold text-ink">Feladat-ticket modellhívás-plafon</h3>
              <p className="text-xs text-ink-faint">
                Egy feladat-ticket élettartamára szól — nem napi keret, és nem nullázódik éjfélkor.
                Ha a ticket eléri a plafont, nem indítható újra; új ticket vagy magasabb plafon kell.
              </p>
            </div>
            <p className="text-sm text-ink-soft">
              Jelenlegi érvényes plafon:{' '}
              <span className="font-mono text-xs">{hu(ticketCallCap.maxCallsPerTicket)}</span> modellhívás
              / ticket
              {!ticketCallCap.configuredInPlatform && (
                <>
                  {' '}
                  (nincs UI-ban mentve —{' '}
                  <span className="font-mono text-[11px]">
                    GATEWAY_MAX_CALLS_PER_TICKET={ticketCallCap.envFallback}
                  </span>{' '}
                  vagy alapértelmezés {hu(ticketCallCap.defaultLimit)})
                </>
              )}
            </p>
            {canEditTicketCallCap ? (
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-xs text-ink-soft">
                  Modellhívás / ticket
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={ticketCallCapDraft}
                    onChange={(e) => setTicketCallCapDraft(e.target.value)}
                    disabled={pending}
                    className="mt-1 block w-40 rounded-md border border-line/60 bg-panel/40 px-2 py-1 text-sm"
                  />
                </label>
                <button
                  type="button"
                  onClick={saveTicketCallCap}
                  disabled={pending}
                  className="rounded-md bg-coral px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  Plafon mentése
                </button>
              </div>
            ) : (
              <p className="text-xs text-ink-faint">
                A plafon módosítása platform-superadmin jogosultságot igényel.
              </p>
            )}
          </section>
        )}

        {message && (
          <p className={`text-sm ${message.tone === 'ok' ? 'text-emerald-600' : 'text-coral'}`}>
            {message.text}
          </p>
        )}

        {nothingConfigured && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-ink">
            Nincs beállított keret, ezért a beépített alapértelmezés érvényes:{' '}
            <span className="font-mono text-xs">
              {hu(overview.envFallback.maxCallsPerDay)} hívás /{' '}
              {hu(overview.envFallback.maxTokensPerDay)} token
            </span>{' '}
            munkatársanként, naponta. Ez blokkolja az agent-indítást, amint egy munkatárs átlépi.
          </div>
        )}

        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-ink">1. Szervezeti napi keret</h3>
            <p className="text-xs text-ink-faint">
              A szervezet összes AI munkatársának együttes napi fogyasztása. Ez a valódi
              költség-plafon.
            </p>
          </div>
          <UsageMeters
            usage={overview.usage.tenant}
            callLimit={overview.tenant.callLimit}
            tokenLimit={overview.tenant.tokenLimit}
            note="A szervezet összes AI munkatársa együtt, az elmúlt 24 órában."
          />
          <div className="flex flex-wrap gap-3">
            <label className="text-xs text-ink-soft">
              Hívás / nap
              <input
                type="number"
                min={1}
                value={draft.tenant.callLimit}
                onChange={(e) => updateDraft('tenant', 'callLimit', e.target.value)}
                disabled={!canEdit || pending}
                placeholder="nincs korlát"
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
                placeholder="nincs korlát"
                className="mt-1 block w-44 rounded-md border border-line/60 bg-panel/40 px-2 py-1 text-sm"
              />
            </label>
          </div>
        </section>

        <section className="space-y-3 border-t border-line/40 pt-5">
          <div>
            <h3 className="text-sm font-semibold text-ink">
              2. Alapértelmezett keret munkatársanként
            </h3>
            <p className="text-xs text-ink-faint">
              Minden AI munkatársra külön-külön érvényes (nem összeadva). Ez akadályozza meg, hogy
              egyetlen elszaladt munkatárs megegye a szervezet egész keretét. Egy-egy munkatársnak
              adhatsz ettől eltérő, saját keretet lentebb — az felülírja ezt az alapértelmezést.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <label className="text-xs text-ink-soft">
              Hívás / nap / munkatárs
              <input
                type="number"
                min={1}
                value={draft.perAgent.callLimit}
                onChange={(e) => updateDraft('perAgent', 'callLimit', e.target.value)}
                disabled={!canEdit || pending}
                placeholder="nincs korlát"
                className="mt-1 block w-44 rounded-md border border-line/60 bg-panel/40 px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-ink-soft">
              Token / nap / munkatárs
              <input
                type="number"
                min={1}
                value={draft.perAgent.tokenLimit}
                onChange={(e) => updateDraft('perAgent', 'tokenLimit', e.target.value)}
                disabled={!canEdit || pending}
                placeholder="nincs korlát"
                className="mt-1 block w-48 rounded-md border border-line/60 bg-panel/40 px-2 py-1 text-sm"
              />
            </label>
          </div>

          <div>
            <p className="text-xs font-medium text-ink-soft">
              Kihasználtság munkatársanként{' '}
              <span className="font-normal text-ink-faint">(elmúlt 24 óra)</span>
            </p>
            {overview.usage.agents.length === 0 ? (
              <p className="mt-1 text-xs text-ink-faint">
                Ma még egyetlen AI munkatárs sem hívott modellt.
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {overview.usage.agents.map((agent) => {
                  const ownRule = ruleByAgentId.get(agent.agentId)
                  return (
                    <li key={agent.agentId} className="rounded-lg border border-line/40 bg-panel/30 p-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-sm font-medium text-ink">{agent.name}</span>
                        {ownRule && (
                          <span className="rounded-full border border-line/50 px-2 py-0.5 text-[11px] text-ink-faint">
                            saját keret érvényes rá
                          </span>
                        )}
                      </div>
                      <div className="mt-2 space-y-2">
                        <LimitMeter
                          label="Hívás"
                          used={agent.calls}
                          limit={ownRule ? ownRule.callLimit : effectivePerAgentCalls}
                        />
                        <LimitMeter
                          label="Token"
                          used={agent.tokens}
                          limit={ownRule ? ownRule.tokenLimit : effectivePerAgentTokens}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </section>

        {canEdit && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className="rounded-md bg-coral px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? 'Mentés…' : 'Napi keretek mentése'}
            </button>
          </div>
        )}

        <section className="space-y-3 border-t border-line/40 pt-5">
          <div>
            <h3 className="text-sm font-semibold text-ink">3. Egyedi keretszabályok</h3>
            <p className="text-xs text-ink-faint">
              Kivételek a fenti alapértelmezéshez: egy adott munkatársnak több (vagy kevesebb)
              keret, heti/havi korlát, vagy feladattípusra szabott plafon.
            </p>
          </div>

          <Explain>
            <p>
              <strong>Melyik szabály nyer?</strong> Ha egy AI munkatársra van saját szabály, az
              lép a „minden munkatársra” alapértelmezés helyébe. A szervezeti összkeret ettől
              függetlenül mindig érvényes.
            </p>
            <p className="mt-1">
              A <strong>„Minden szervezetre”</strong> jelölésű szabály a platform összes
              szervezetére vonatkozik — ilyet csak akkor adj meg, ha tényleg mindenkire szánod.
            </p>
          </Explain>

          {extraRules.length === 0 ? (
            <p className="text-sm text-ink-soft">
              Nincs egyedi szabály — mindenkire a fenti napi keretek érvényesek.
            </p>
          ) : (
            <ul className="space-y-2">
              {extraRules.map((rule) => (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  ownTenantId={overview.tenantId}
                  agentNameById={agentNameById}
                  canEdit={canEditRules}
                  onChanged={(next) =>
                    setRules((prev) => prev.map((r) => (r.id === next.id ? next : r)))
                  }
                  onDeleted={(id) => setRules((prev) => prev.filter((r) => r.id !== id))}
                />
              ))}
            </ul>
          )}

          {canEditRules ? (
            <NewRuleForm
              agents={overview.agents}
              onCreated={(rule) => setRules((prev) => [...prev, rule])}
            />
          ) : (
            <p className="text-xs text-ink-faint">
              Egyedi szabályt platform-adminisztrátor vehet fel.
            </p>
          )}
        </section>
      </div>
    </Card>
  )
}
