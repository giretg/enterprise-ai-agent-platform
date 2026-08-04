'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentConnectorBinding } from '@/app/actions/platform'
import { unassignConnectorFromAgent } from '@/app/actions/provisioning'
import { Badge } from '@/components/ui/shell'
import { connectorAccessLabel } from '@/lib/agent-profile-labels'
import {
  PREAPPROVED_SUGGESTED_WRITE_LIMIT,
  consequenceBoundaryLabel,
  suggestedExpiryIso,
  type ConsequenceBoundary,
  type PreapprovedTrustMode,
  type WriteApprovalMode,
} from '@/domain/tool-broker/write-approval-trust'

type ConnectorItem = {
  connector: {
    id: string
    type: string
    name: string
    scope: string
    secretAlias: string | null
    config: unknown
    authMode?: string
    consequenceBoundary?: ConsequenceBoundary | null
  }
  accessMode: 'read' | 'write'
  /** Per-agent kulcs alias (kötés-szint). Jelenléte = az agentnek saját kulcsa van. */
  agentSecretAlias?: string | null
  writeApproval?: WriteApprovalMode
  preapprovedTrustMode?: PreapprovedTrustMode | null
  preapprovedExpiresAt?: Date | string | null
  preapprovedWriteLimit?: number | null
  dangerPreapproved?: boolean
}

const KEY_STORAGE_NOTE = 'A kulcs titkosítva tárolódik, sosem kerül az adatbázisba.'
const INPUT = 'mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm'

function expiryDateValue(raw: Date | string | null | undefined): string {
  if (!raw) return ''
  const d = raw instanceof Date ? raw : new Date(raw)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

/**
 * WP-5 (B4) — KÖTÉS-szerkesztő: az egyetlen biztonságos agent-szintű művelet. Csak a
 * hozzáférést, az írási bizalmat és az opcionális per-agent kulcsot állítja
 * (az `AgentConnector` sort), a connector strukturális configját SOHA nem érinti —
 * kivéve az opcionális `consequenceBoundary` címkét (issue #220).
 */
function BindingEditor({
  agentId,
  item,
  onSaved,
}: {
  agentId: string
  item: ConnectorItem
  onSaved: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [accessMode, setAccessMode] = useState<'read' | 'write'>(item.accessMode)
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [writeApproval, setWriteApproval] = useState<WriteApprovalMode>(
    item.writeApproval === 'preapproved' ? 'preapproved' : 'per_call',
  )
  // Nincs előjelölt default preapproved módban — üres = mentéskor hiba, ha preapproved.
  const [trustMode, setTrustMode] = useState<'' | PreapprovedTrustMode>(
    item.preapprovedTrustMode === 'lax' || item.preapprovedTrustMode === 'strict'
      ? item.preapprovedTrustMode
      : '',
  )
  const [writeLimit, setWriteLimit] = useState(
    String(item.preapprovedWriteLimit ?? PREAPPROVED_SUGGESTED_WRITE_LIMIT),
  )
  const [expiresAt, setExpiresAt] = useState(
    expiryDateValue(item.preapprovedExpiresAt) || suggestedExpiryIso(),
  )
  const [dangerPreapproved, setDangerPreapproved] = useState(Boolean(item.dangerPreapproved))
  const [consequenceBoundary, setConsequenceBoundary] = useState<'' | ConsequenceBoundary>(
    item.connector.consequenceBoundary === 'external_draft' ||
      item.connector.consequenceBoundary === 'platform'
      ? item.connector.consequenceBoundary
      : '',
  )
  const hasPerAgentKey = Boolean(item.agentSecretAlias)
  const isDelegated = item.connector.authMode === 'user_delegated'
  const boundaryHint = consequenceBoundaryLabel(
    consequenceBoundary || item.connector.consequenceBoundary,
  )

  function submit() {
    startTransition(async () => {
      setError(null)
      setDone(null)
      const res = await updateAgentConnectorBinding({
        agentId,
        connectorId: item.connector.id,
        accessMode,
        ...(clearApiKey ? { clearApiKey: true } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        writeApproval: accessMode === 'write' ? writeApproval : 'per_call',
        ...(accessMode === 'write' && writeApproval === 'preapproved'
          ? {
              preapprovedTrustMode: trustMode || null,
              preapprovedExpiresAt: expiresAt || null,
              preapprovedWriteLimit: writeLimit ? Number(writeLimit) : null,
              dangerPreapproved,
            }
          : {
              preapprovedTrustMode: null,
              preapprovedExpiresAt: null,
              preapprovedWriteLimit: null,
              dangerPreapproved: false,
            }),
        consequenceBoundary: consequenceBoundary || null,
      })
      if (res.success) {
        setDone('Kötés mentve.')
        setApiKey('')
        setClearApiKey(false)
        router.refresh()
        onSaved()
      } else {
        setError(res.error)
      }
    })
  }

  return (
    <form
      className="mt-4 space-y-3 rounded-xl border border-line/80 bg-night/40 p-4"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Kötés — csak erre az agentre
      </p>
      <label className="block text-sm">
        <span className="text-ink-soft">Hozzáférés</span>
        <select
          value={accessMode}
          onChange={(event) => setAccessMode(event.target.value as 'read' | 'write')}
          className={INPUT}
        >
          <option value="write">Olvasás + írás</option>
          <option value="read">Csak olvasás</option>
        </select>
      </label>

      {accessMode === 'write' && (
        <fieldset className="space-y-3 rounded-lg border border-line/60 bg-night-2/40 p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Írási bizalom (következmény-kapu)
          </legend>
          <label className="block text-sm">
            <span className="text-ink-soft">Szint</span>
            <select
              value={writeApproval}
              onChange={(event) => setWriteApproval(event.target.value as WriteApprovalMode)}
              className={INPUT}
            >
              <option value="per_call">Hívásonkénti jóváhagyás (alapértelmezett)</option>
              <option value="preapproved">Előzetesen engedélyezve (kapu nélkül, audittal)</option>
            </select>
          </label>

          {writeApproval === 'preapproved' && (
            <>
              <p className="text-xs text-ink-faint">
                Csak allowlistelt write végpontokra érvényes. Ismeretlen path mindig kapu.
                {boundaryHint ? ` ${boundaryHint}.` : ''}
              </p>
              <label className="block text-sm">
                <span className="text-ink-soft">Mód (kötelező választás)</span>
                <select
                  value={trustMode}
                  onChange={(event) => setTrustMode(event.target.value as '' | PreapprovedTrustMode)}
                  className={INPUT}
                  required
                >
                  <option value="">— válassz —</option>
                  <option value="lax">Laza — csak audit</option>
                  <option value="strict">Szigorú — hívásszám-limit + lejárat</option>
                </select>
              </label>

              {trustMode === 'strict' && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block text-sm">
                    <span className="text-ink-soft">Író hívás / agent-futás (max 500)</span>
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={writeLimit}
                      onChange={(event) => setWriteLimit(event.target.value)}
                      className={INPUT}
                      required
                    />
                    <span className="mt-1 block text-xs text-ink-faint">
                      A limit EGY agent-futásra szól. Egy hosszabb feladat több futásból
                      állhat, ilyenkor a keret futásonként újraindul — ez nem a feladat
                      összes írására vonatkozó plafon.
                    </span>
                  </label>
                  <label className="block text-sm">
                    <span className="text-ink-soft">Lejárat</span>
                    <input
                      type="date"
                      value={expiresAt}
                      onChange={(event) => setExpiresAt(event.target.value)}
                      className={INPUT}
                      required
                    />
                  </label>
                </div>
              )}

              {trustMode === 'lax' && (
                <label className="block text-sm">
                  <span className="text-ink-soft">Lejárat (opcionális)</span>
                  <input
                    type="date"
                    value={expiresAt}
                    onChange={(event) => setExpiresAt(event.target.value)}
                    className={INPUT}
                  />
                </label>
              )}

              <label className="flex items-start gap-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={dangerPreapproved}
                  onChange={(event) => setDangerPreapproved(event.target.checked)}
                />
                <span>
                  Danger végpontok is előzetesen engedélyezve
                  <span className="mt-0.5 block text-xs text-ink-faint">
                    Alapból ki. Kapcsoló nélkül a danger mindig hívásonkénti kapu.
                  </span>
                </span>
              </label>
            </>
          )}
        </fieldset>
      )}

      <label className="block text-sm">
        <span className="text-ink-soft">Következmény-határ címke (opcionális)</span>
        <select
          value={consequenceBoundary}
          onChange={(event) =>
            setConsequenceBoundary(event.target.value as '' | ConsequenceBoundary)
          }
          className={INPUT}
        >
          <option value="">Nincs címke</option>
          <option value="external_draft">Külső draft (javaslat: preapproved megfontolható)</option>
          <option value="platform">Platform a határ (maradjon per_call)</option>
        </select>
        <span className="mt-1 block text-xs text-ink-faint">
          Csak UI javaslat — önmagában nem kapcsolja ki a kaput. A tényleges skiphez
          binding-szintű „előzetesen engedélyezve” kell.
        </span>
      </label>

      {isDelegated ? (
        <p className="rounded-lg border border-line/60 bg-night-2/60 px-3 py-2 text-xs text-ink-faint">
          Ez egy automatikus-hozzájárulású (user-delegált) kapcsolat — a hitelesítés
          felhasználónként történik, ezért per-agent kulcs itt nem adható meg.
        </p>
      ) : (
        <label className="block text-sm">
          <span className="text-ink-soft">
            Per-agent API kulcs {hasPerAgentKey ? '(be van állítva)' : '(nincs beállítva)'}
          </span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value)
              if (event.target.value) setClearApiKey(false)
            }}
            placeholder={
              hasPerAgentKey
                ? 'Üresen hagyva marad a jelenlegi'
                : 'Üresen hagyva a közös tenant-kulcs marad'
            }
            autoComplete="off"
            disabled={clearApiKey}
            className={INPUT}
          />
          <span className="mt-1 block text-xs text-ink-faint">
            Csak ehhez az agenthez tartozó kulcs. Üresen hagyva az agent a kapcsolat közös
            tenant-kulcsát használja. {KEY_STORAGE_NOTE}
          </span>
          {hasPerAgentKey && (
            <span className="mt-2 flex items-center gap-2 text-xs text-ink-soft">
              <input
                type="checkbox"
                checked={clearApiKey}
                onChange={(event) => {
                  setClearApiKey(event.target.checked)
                  if (event.target.checked) setApiKey('')
                }}
              />
              Per-agent kulcs törlése (visszaesés a közös tenant-kulcsra)
            </span>
          )}
        </label>
      )}

      {error && <p className="text-sm text-coral">{error}</p>}
      {done && <p className="text-sm text-sage">{done}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
      >
        {pending ? 'Mentés...' : 'Kötés mentése'}
      </button>
    </form>
  )
}

/**
 * A jelvény a KIKAPCSOLT kaput jelzi, nem egy elért állapotot — ezért `warning`,
 * nem `success`: zöld pipával az „előzetesen engedélyezve” azt sugallná, hogy ez
 * az egészségesebb beállítás, holott itt fut írás emberi jóváhagyás nélkül.
 */
function writeApprovalBadge(
  item: ConnectorItem,
): { label: string; tone: 'warning' | 'neutral'; title: string } | null {
  if (item.accessMode !== 'write') return null
  if (item.writeApproval === 'preapproved') {
    const mode = item.preapprovedTrustMode === 'strict' ? 'szigorú' : 'laza'
    return {
      label: `kapu nélkül — előzetesen engedélyezve (${mode})`,
      tone: 'warning',
      title:
        'Az allowlistelt író hívások jóváhagyó kártya nélkül futnak ezen a kapcsolaton. Ismeretlen végpont továbbra is kapu.',
    }
  }
  return {
    label: 'hívásonkénti kapu',
    tone: 'neutral',
    title: 'Minden író hívás külön emberi jóváhagyást kér.',
  }
}

export function ApiConnectorList({
  agentId,
  connectors,
}: {
  agentId: string
  connectors: ConnectorItem[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  if (connectors.length === 0) {
    return <p className="text-sm text-ink-faint">Nincs külső kapcsolat hozzárendelve.</p>
  }

  function unassign(item: ConnectorItem) {
    startTransition(async () => {
      setError(null)
      setDone(null)
      const res = await unassignConnectorFromAgent({
        agentId,
        connectorId: item.connector.id,
        reason: 'Agent detail admin UI',
      })
      if (res.success) {
        setDone(`„${item.connector.name}" leválasztva az agentről.`)
        setConfirmingId(null)
        setEditingId(null)
        router.refresh()
      } else {
        setError(res.error ?? 'Nem sikerült leválasztani a kapcsolatot.')
      }
    })
  }

  return (
    <ul className="space-y-2 text-sm">
      {error && <li className="text-sm text-coral">{error}</li>}
      {done && <li className="text-sm text-sage">{done}</li>}
      {connectors.map((item) => {
        const editing = editingId === item.connector.id
        const confirming = confirmingId === item.connector.id
        const trustBadge = writeApprovalBadge(item)
        const boundary = consequenceBoundaryLabel(item.connector.consequenceBoundary)

        return (
          <li key={item.connector.id} className="atelier-soft p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="font-medium text-ink">{item.connector.name}</span>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={item.accessMode === 'write' ? 'warning' : 'neutral'}>
                  {connectorAccessLabel(item.accessMode)}
                </Badge>
                {trustBadge && (
                  <Badge tone={trustBadge.tone} title={trustBadge.title}>
                    {trustBadge.label}
                  </Badge>
                )}
                <button
                  type="button"
                  onClick={() => setEditingId(editing ? null : item.connector.id)}
                  className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft hover:bg-night-2"
                >
                  {editing ? 'Bezárás' : 'Kötés szerkesztése'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingId(confirming ? null : item.connector.id)}
                  className="rounded-full border border-coral/40 px-3 py-1 text-xs font-semibold text-coral hover:bg-coral/10"
                >
                  {confirming ? 'Mégse' : 'Leválasztás'}
                </button>
              </div>
            </div>
            <p className="mt-1 break-all text-xs text-ink-faint">
              {item.connector.type} · {item.connector.scope}
              {item.connector.secretAlias && ` · ${item.connector.secretAlias}`}
              {boundary && ` · ${boundary}`}
            </p>

            {confirming && (
              <div className="mt-3 rounded-lg border border-coral/30 bg-coral/10 p-3">
                <p className="text-xs text-ink-soft">
                  A kapcsolat az agentről lekerül, de maga a connector és az audit előzmény megmarad.
                </p>
                <button
                  type="button"
                  onClick={() => unassign(item)}
                  disabled={pending}
                  className="mt-3 rounded-full bg-coral/20 px-4 py-1.5 text-xs font-semibold text-coral disabled:opacity-50"
                >
                  {pending ? 'Leválasztás...' : 'Auditált leválasztás'}
                </button>
              </div>
            )}

            {editing && (
              <>
                <BindingEditor
                  agentId={agentId}
                  item={item}
                  onSaved={() => setEditingId(null)}
                />
                <div className="mt-3 rounded-xl border border-honey/30 bg-honey/5 p-3 text-xs">
                  <p className="text-ink-faint">
                    A strukturális konfiguráció (base URL, endpointok) kizárólag a
                    provisioningban módosítható. Az írási bizalom ehhez az agent–connector
                    kötéshez tartozik.
                  </p>
                  <Link
                    href="/control-plane/provisioning"
                    className="mt-2 inline-block font-semibold text-honey hover:underline"
                  >
                    Connector megnyitása a provisioningban →
                  </Link>
                </div>
              </>
            )}
          </li>
        )
      })}
    </ul>
  )
}
