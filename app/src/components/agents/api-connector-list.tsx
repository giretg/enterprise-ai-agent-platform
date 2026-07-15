'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { updateAgentConnectorBinding } from '@/app/actions/platform'
import { unassignConnectorFromAgent } from '@/app/actions/provisioning'
import { Badge } from '@/components/ui/shell'
import { connectorAccessLabel } from '@/lib/agent-profile-labels'

type ConnectorItem = {
  connector: {
    id: string
    type: string
    name: string
    scope: string
    secretAlias: string | null
    config: unknown
    authMode?: string
  }
  accessMode: 'read' | 'write'
  /** Per-agent kulcs alias (kötés-szint). Jelenléte = az agentnek saját kulcsa van. */
  agentSecretAlias?: string | null
}

const KEY_STORAGE_NOTE = 'A kulcs titkosítva tárolódik, sosem kerül az adatbázisba.'
const INPUT = 'mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm'

/**
 * WP-5 (B4) — KÖTÉS-szerkesztő: az egyetlen biztonságos agent-szintű művelet. Csak a
 * hozzáférést és az opcionális per-agent kulcsot állítja (az `AgentConnector` sort), a
 * connector strukturális configját SOHA nem érinti.
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
  const hasPerAgentKey = Boolean(item.agentSecretAlias)
  const isDelegated = item.connector.authMode === 'user_delegated'

  function submit() {
    startTransition(async () => {
      setError(null)
      setDone(null)
      const res = await updateAgentConnectorBinding({
        agentId,
        connectorId: item.connector.id,
        accessMode,
        ...(clearApiKey ? { clearApiKey: true } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
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

        return (
          <li key={item.connector.id} className="atelier-soft p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="font-medium text-ink">{item.connector.name}</span>
              <div className="flex items-center gap-2">
                <Badge tone={item.accessMode === 'write' ? 'warning' : 'neutral'}>
                  {connectorAccessLabel(item.accessMode)}
                </Badge>
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
                    Ez a beállítás a connector egészére, az egész tenantra vonatkozik — a
                    strukturális konfiguráció kizárólag a provisioningban módosítható.
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
