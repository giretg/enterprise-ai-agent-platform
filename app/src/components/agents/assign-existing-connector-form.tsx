'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useId, useMemo, useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { assignConnectorToAgent } from '@/app/actions/provisioning'
import { Card } from '@/components/ui/shell'
import { OpenInNewWindowLink } from '@/components/ui/open-in-new-window-link'
import {
  CREATE_AGENT_WIZARD_EXTERNAL_HREFS,
  matchAssignableConnectorsByName,
} from '@/lib/create-agent-wizard'

export type ConnectorOption = {
  id: string
  type: string
  name: string
  description?: string | null
  baseUrl?: string | null
  tools?: Array<{ method: string; path: string; description?: string | null }>
}

const INPUT = 'mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm'

/** Kiválasztott kapcsolat leírása — a select alatt, és a modálban is ez látszik. */
function ConnectorDescription({ connector }: { connector: ConnectorOption }) {
  const tools = connector.tools ?? []
  return (
    <div className="rounded-lg border border-line/60 bg-night-2/40 px-3 py-2">
      {connector.description ? (
        <p className="text-sm leading-relaxed text-ink-soft">{connector.description}</p>
      ) : (
        <p className="text-sm italic text-ink-faint">Ehhez a kapcsolathoz nincs leírás.</p>
      )}
      <p className="mt-1 text-xs text-ink-faint">
        {connector.type}
        {connector.baseUrl ? ` · ${connector.baseUrl}` : ''}
        {tools.length > 0 ? ` · ${tools.length} művelet` : ''}
      </p>
      {tools.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {tools.slice(0, 6).map((t) => (
            <li key={`${t.method} ${t.path}`} className="text-xs text-ink-soft">
              <span className="font-mono font-semibold">{t.method}</span>{' '}
              <span className="font-mono">{t.path}</span>
              {t.description ? <span className="text-ink-faint"> — {t.description}</span> : null}
            </li>
          ))}
          {tools.length > 6 ? (
            <li className="text-xs text-ink-faint">…és még {tools.length - 6} művelet</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}

export function AssignExistingConnectorForm({
  agentId,
  connectors,
  suggestedConnectorNames,
  bare = false,
  onAssigned,
}: {
  agentId: string
  connectors: ConnectorOption[]
  /** Javaslat: felülre kerül, elő van választva; hozzárendelés külön admin-kattintás. */
  suggestedConnectorNames?: string[]
  bare?: boolean
  onAssigned?: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const suggested = useMemo(
    () => matchAssignableConnectorsByName(connectors, suggestedConnectorNames ?? []),
    [connectors, suggestedConnectorNames],
  )
  const orderedConnectors = useMemo(() => {
    if (suggested.length === 0) return connectors
    const suggestedIds = new Set(suggested.map((connector) => connector.id))
    return [...suggested, ...connectors.filter((connector) => !suggestedIds.has(connector.id))]
  }, [connectors, suggested])
  const [connectorId, setConnectorId] = useState(suggested[0]?.id ?? connectors[0]?.id ?? '')
  const [accessMode, setAccessMode] = useState<'read' | 'write'>('read')
  const [apiKey, setApiKey] = useState('')

  const selected = useMemo(
    () => connectors.find((connector) => connector.id === connectorId),
    [connectorId, connectors],
  )

  function submit() {
    startTransition(async () => {
      setError(null)
      setDone(null)

      const res = await assignConnectorToAgent({
        agentId,
        connectorId,
        accessMode,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })

      if (res.success) {
        setDone(selected ? `„${selected.name}" hozzárendelve.` : 'Kapcsolat hozzárendelve.')
        setApiKey('')
        onAssigned?.()
        router.refresh()
      } else {
        setError(res.error ?? 'Nem sikerült hozzárendelni a kapcsolatot.')
      }
    })
  }

  const form = (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
        {connectors.length === 0 ? (
          <p className="text-sm text-ink-faint">Nincs aktivált provisioning-kapcsolat.</p>
        ) : (
          <>
            {suggested.length > 0 ? (
              <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-ink">
                A javaslat ezeket a kapcsolatokat ajánlja: {suggested.map((c) => c.name).join(', ')}.
                Hozzárendelés csak a gombra történik.
              </p>
            ) : null}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="text-ink-soft">Kapcsolat</span>
                <select
                  value={connectorId}
                  onChange={(e) => setConnectorId(e.target.value)}
                  className={INPUT}
                >
                  {orderedConnectors.map((connector) => (
                    <option key={connector.id} value={connector.id}>
                      {connector.name} · {connector.type}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-ink-soft">Hozzáférés</span>
                <select
                  value={accessMode}
                  onChange={(e) => setAccessMode(e.target.value as 'read' | 'write')}
                  className={INPUT}
                >
                  <option value="read">Csak olvasás</option>
                  <option value="write">Olvasás + írás</option>
                </select>
              </label>
            </div>

            {selected ? <ConnectorDescription connector={selected} /> : null}

            {selected?.type !== 'gmail' ? (
              <label className="block text-sm">
                <span className="text-ink-soft">Per-agent API kulcs</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Üresen hagyva a kapcsolat megosztott kulcsát használja"
                  autoComplete="off"
                  className={INPUT}
                />
              </label>
            ) : null}

            {error && <p className="text-sm text-coral">{error}</p>}
            {done && <p className="text-sm text-sage">{done}</p>}

            <button
              type="submit"
              disabled={pending || !connectorId}
              className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
            >
              {pending ? 'Hozzárendelés...' : 'Hozzárendelés'}
            </button>
          </>
        )}
      </form>
  )

  if (bare) return form
  return <Card title="Meglévő kapcsolat hozzárendelése">{form}</Card>
}

/**
 * „Kapcsolat hozzáadása" gomb + modál. A lista tetejére való: a kiválasztás
 * leírással történik, és a kiválasztott kapcsolat leírása a hozzárendelés
 * előtt látszik — mit csinál valójában.
 */
export function AssignConnectorModal({
  agentId,
  connectors,
  suggestedConnectorNames,
  onAssigned,
}: {
  agentId: string
  connectors: ConnectorOption[]
  suggestedConnectorNames?: string[]
  onAssigned?: () => void
}) {
  const [open, setOpen] = useState(false)
  if (connectors.length === 0) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="rounded-full bg-coral/20 px-4 py-2 text-sm font-semibold text-coral hover:bg-coral/30"
      >
        ＋ Kapcsolat hozzáadása
      </button>
      {open ? (
        <AssignConnectorDialog
          agentId={agentId}
          connectors={connectors}
          suggestedConnectorNames={suggestedConnectorNames}
          onClose={() => setOpen(false)}
          onAssigned={() => {
            onAssigned?.()
            setOpen(false)
          }}
        />
      ) : null}
    </>
  )
}

function AssignConnectorDialog({
  agentId,
  connectors,
  suggestedConnectorNames,
  onClose,
  onAssigned,
}: {
  agentId: string
  connectors: ConnectorOption[]
  suggestedConnectorNames?: string[]
  onClose: () => void
  onAssigned?: () => void
}) {
  const router = useRouter()
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const [mounted, setMounted] = useState(false)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const suggested = useMemo(
    () => matchAssignableConnectorsByName(connectors, suggestedConnectorNames ?? []),
    [connectors, suggestedConnectorNames],
  )
  const suggestedIds = useMemo(() => new Set(suggested.map((c) => c.id)), [suggested])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const ordered = [
      ...suggested,
      ...connectors.filter((c) => !suggestedIds.has(c.id)),
    ]
    if (!q) return ordered
    return ordered.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.type.toLowerCase().includes(q) ||
        (c.description ?? '').toLowerCase().includes(q),
    )
  }, [connectors, suggested, suggestedIds, query])
  const [connectorId, setConnectorId] = useState(suggested[0]?.id ?? connectors[0]?.id ?? '')
  const [accessMode, setAccessMode] = useState<'read' | 'write'>('read')
  const [apiKey, setApiKey] = useState('')
  const selected = connectors.find((c) => c.id === connectorId) ?? null

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client portal mount gate
    setMounted(true)
  }, [])
  useEffect(() => {
    if (!mounted) return
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mounted, onClose])

  function submit() {
    startTransition(async () => {
      setError(null)
      const res = await assignConnectorToAgent({
        agentId,
        connectorId,
        accessMode,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      if (res.success) {
        setApiKey('')
        onAssigned?.()
        router.refresh()
      } else {
        setError(res.error ?? 'Nem sikerült hozzárendelni a kapcsolatot.')
      }
    })
  }

  if (!mounted) return null
  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-ink/50 p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[min(40rem,92vh)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="font-display text-lg font-bold leading-tight text-ink">
              Kapcsolat hozzáadása
            </h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Már aktivált kapcsolat csatolása az agenthez. Új kapcsolatot a{' '}
              <OpenInNewWindowLink href={CREATE_AGENT_WIZARD_EXTERNAL_HREFS.connectors}>
                Kapcsolat-katalógus
              </OpenInNewWindowLink>{' '}
              és a{' '}
              <OpenInNewWindowLink href={CREATE_AGENT_WIZARD_EXTERNAL_HREFS.connections}>
                Provisioning-varázsló
              </OpenInNewWindowLink>{' '}
              oldalon hozhatsz létre.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Bezárás"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-faint hover:bg-night-2 hover:text-ink"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Keresés név, típus vagy leírás alapján…"
            aria-label="Kapcsolat keresése"
            className="w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
          />
          {filtered.length === 0 ? (
            <p className="text-sm italic text-ink-faint">Nincs ilyen kapcsolat.</p>
          ) : (
            <ul className="space-y-2">
              {filtered.map((c) => {
                const active = c.id === connectorId
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setConnectorId(c.id)}
                      aria-pressed={active}
                      className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                        active
                          ? 'border-coral/50 bg-coral/10'
                          : 'border-line hover:bg-night-2'
                      }`}
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-ink">{c.name}</span>
                        <span className="text-xs text-ink-faint">{c.type}</span>
                        {suggestedIds.has(c.id) ? (
                          <span className="rounded-full bg-sage/15 px-2 py-0.5 text-[11px] font-semibold text-sage">
                            javasolt
                          </span>
                        ) : null}
                      </span>
                      {c.description ? (
                        <span className="mt-0.5 block text-xs leading-relaxed text-ink-soft">
                          {c.description}
                        </span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {selected ? (
            <div className="space-y-3 border-t border-line pt-3">
              <ConnectorDescription connector={selected} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="text-ink-soft">Hozzáférés</span>
                  <select
                    value={accessMode}
                    onChange={(e) => setAccessMode(e.target.value as 'read' | 'write')}
                    className={INPUT}
                  >
                    <option value="read">Csak olvasás</option>
                    <option value="write">Olvasás + írás</option>
                  </select>
                </label>
                {selected.type !== 'gmail' ? (
                  <label className="block text-sm">
                    <span className="text-ink-soft">Per-agent API kulcs</span>
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="Üresen hagyva a megosztott kulcs marad"
                      autoComplete="off"
                      className={INPUT}
                    />
                  </label>
                ) : null}
              </div>
            </div>
          ) : null}
          {error && <p className="text-sm text-coral">{error}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink-soft hover:bg-night-2"
          >
            Mégse
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending || !connectorId}
            className="rounded-full bg-coral/20 px-5 py-2 text-sm font-semibold text-coral disabled:opacity-50"
          >
            {pending ? 'Hozzárendelés…' : 'Hozzárendelés'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
