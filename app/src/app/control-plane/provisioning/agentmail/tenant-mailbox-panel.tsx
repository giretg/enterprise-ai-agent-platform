'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  assignTenantMailboxAction,
  disconnectTenantMailboxAction,
  reconnectTenantMailboxAction,
  setTenantMailboxApprovalAction,
  startTenantMailboxConnectAction,
  type TenantMailboxOverview,
  type TenantMailboxRow,
  type TenantMailboxStatus,
} from '@/app/actions/tenant-mailbox'
import { Badge, Card } from '@/components/ui/shell'

type Access = 'none' | 'read' | 'write'

const inputClass =
  'w-full rounded-md border border-ink/15 bg-paper px-3 py-2 text-sm focus:border-coral/50 focus:outline-none'

const SOURCE_LABEL = { google: 'Google', microsoft: 'Microsoft 365' } as const

const STATUS: Record<TenantMailboxStatus, { label: string; tone: 'success' | 'danger' | 'warning' | 'neutral'; hint: string }> = {
  active: { label: 'Aktív', tone: 'success', hint: 'Az agentek használhatják.' },
  broken: {
    label: 'Megszakadt',
    tone: 'danger',
    hint: 'A Google/Microsoft visszavonta vagy lejárt a hozzáférés. Csatlakoztasd újra ugyanazzal a fiókkal.',
  },
  pending: { label: 'Bekötésre vár', tone: 'warning', hint: 'A bejelentkezés nem fejeződött be.' },
  disconnected: { label: 'Leválasztva', tone: 'neutral', hint: 'A hozzáférést visszavonták.' },
}

function Feedback({ error, notice }: { error: string | null; notice?: string | null }) {
  if (error) return <p className="mt-3 text-sm text-coral-deep">{error}</p>
  if (notice) {
    return <p className="mt-3 rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">{notice}</p>
  }
  return null
}

function ConnectForm({ microsoftBases }: { microsoftBases: TenantMailboxOverview['microsoftBases'] }) {
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState<'google' | 'microsoft'>('google')
  const [baseId, setBaseId] = useState(microsoftBases[0]?.connectorId ?? '')
  const [readOnly, setReadOnly] = useState(false)
  const [requireApproval, setRequireApproval] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const router = useRouter()

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-coral/40 bg-coral/10 px-4 py-2 text-sm font-semibold text-coral hover:bg-coral/15"
      >
        + Közös postafiók bekötése
      </button>
    )
  }

  function connect() {
    start(async () => {
      setError(null)
      const res = await startTenantMailboxConnectAction({
        source,
        readOnly,
        requireApproval,
        ...(source === 'microsoft' ? { microsoftBaseConnectorId: baseId } : {}),
      })
      if (!res.success) return setError(res.error)
      if (res.data.url.startsWith('/')) {
        router.push(res.data.url)
        router.refresh()
        return
      }
      window.location.assign(res.data.url)
    })
  }

  const microsoftMissing = source === 'microsoft' && microsoftBases.length === 0

  return (
    <div className="rounded-xl border border-coral/30 bg-coral/5 p-4">
      <h3 className="text-sm font-semibold">Közös postafiók bekötése</h3>
      <p className="mt-1 text-xs text-ink-soft">
        A következő lépésben a <strong>közös postafiók</strong> fiókjával lépj be (pl. szamlazas@ceg.hu), ne a
        saját fiókoddal. A postafiók a cégé marad akkor is, ha te később kilépsz.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Szolgáltató</span>
          <select value={source} onChange={(e) => setSource(e.target.value as 'google' | 'microsoft')} className={inputClass}>
            <option value="google">Google (Gmail / Google Workspace)</option>
            <option value="microsoft">Microsoft 365 (Outlook)</option>
          </select>
        </label>
        {source === 'microsoft' ? (
          <label className="block text-sm">
            <span className="mb-1 block text-ink-soft">Microsoft-kapcsolat</span>
            {microsoftMissing ? (
              <span className="block text-xs text-coral-deep">
                Előbb aktiváld a Microsoft 365 kapcsolatot a Konnektorok oldalon — annak a bejelentkezését használjuk.
              </span>
            ) : (
              <select value={baseId} onChange={(e) => setBaseId(e.target.value)} className={inputClass}>
                {microsoftBases.map((base) => (
                  <option key={base.connectorId} value={base.connectorId}>
                    {base.name}
                  </option>
                ))}
              </select>
            )}
          </label>
        ) : null}
      </div>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} className="mt-1" />
        <span>
          Csak olvasás
          <span className="block text-xs text-ink-soft">
            Az agentek csak olvashatják a leveleket, küldeni nem tudnak belőle. Később nem bővíthető — ahhoz új bekötés kell.
          </span>
        </span>
      </label>
      {!readOnly ? (
        <label className="mt-2 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={requireApproval}
            onChange={(e) => setRequireApproval(e.target.checked)}
            className="mt-1"
          />
          <span>
            Minden kimenő levél jóváhagyással megy ki
            <span className="block text-xs text-ink-soft">
              Bekapcsolva akkor is jóváhagyást kér, ha az agent egyébként közvetlenül küldhetne.
            </span>
          </span>
        </label>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={connect}
          disabled={pending || microsoftMissing}
          className="rounded-md bg-coral px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {pending ? 'Átirányítás…' : 'Tovább a bejelentkezéshez'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-ink/15 px-4 py-2 text-sm font-semibold text-ink-soft"
        >
          Mégse
        </button>
      </div>
      <Feedback error={error} />
    </div>
  )
}

function AccessToggle({
  value,
  readOnly,
  disabled,
  onChange,
}: {
  value: Access
  readOnly: boolean
  disabled: boolean
  onChange: (next: Access) => void
}) {
  const options: Array<{ value: Access; label: string; hint: string }> = [
    { value: 'none', label: 'Nincs', hint: 'Az agent nem látja ezt a postafiókot.' },
    { value: 'read', label: 'Olvas', hint: 'Elolvashatja a leveleket, de nem küldhet.' },
    {
      value: 'write',
      label: 'Küldhet',
      hint: readOnly
        ? 'Ez a postafiók csak olvasásra van bekötve.'
        : 'Olvas, és a postafiók nevében küldhet — jóváhagyás után.',
    },
  ]
  return (
    <div role="radiogroup" className="inline-flex rounded-lg border border-ink/15 bg-paper p-0.5">
      {options.map((option) => {
        const active = option.value === value
        const blocked = option.value === 'write' && readOnly
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.hint}
            disabled={disabled || blocked}
            onClick={() => !active && onChange(option.value)}
            className={`rounded-md px-3 py-1 text-xs font-semibold transition disabled:opacity-50 ${
              active
                ? option.value === 'write'
                  ? 'bg-coral text-white'
                  : option.value === 'read'
                    ? 'bg-sage text-white'
                    : 'bg-ink/10 text-ink'
                : 'text-ink-soft hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

function MailboxCard({
  mailbox,
  agents,
  assignWarning,
}: {
  mailbox: TenantMailboxRow
  agents: TenantMailboxOverview['agents']
  assignWarning: string
}) {
  const router = useRouter()
  const [pendingAgent, setPendingAgent] = useState<string | null>(null)
  const [busy, startBusy] = useTransition()
  const [, startAccess] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const accessByAgent = new Map(mailbox.bindings.map((b) => [b.agentId, b.accessMode as Access]))
  const status = STATUS[mailbox.status]
  const title = mailbox.address ?? 'Cím még nem ismert'

  function setAccess(agentId: string, next: Access) {
    const current = accessByAgent.get(agentId) ?? 'none'
    const confirmed = next === 'none' || current !== 'none' || window.confirm(assignWarning)
    if (!confirmed) return
    setPendingAgent(agentId)
    startAccess(async () => {
      setError(null)
      const res = await assignTenantMailboxAction({ connectorId: mailbox.connectorId, agentId, access: next, confirmed })
      setPendingAgent(null)
      if (!res.success) return setError(res.error)
      router.refresh()
    })
  }

  function reconnect() {
    startBusy(async () => {
      setError(null)
      const res = await reconnectTenantMailboxAction({ connectorId: mailbox.connectorId })
      if (!res.success) return setError(res.error)
      if (res.data.url.startsWith('/')) return router.refresh()
      window.location.assign(res.data.url)
    })
  }

  function disconnect() {
    if (!window.confirm(`Leválasztod a(z) ${title} postafiókot? Az agentek azonnal elveszítik a hozzáférést.`)) return
    startBusy(async () => {
      setError(null)
      const res = await disconnectTenantMailboxAction({ connectorId: mailbox.connectorId })
      if (!res.success) return setError(res.error)
      router.refresh()
    })
  }

  function toggleApproval(requireApproval: boolean) {
    startBusy(async () => {
      setError(null)
      const res = await setTenantMailboxApprovalAction({ connectorId: mailbox.connectorId, requireApproval })
      if (!res.success) return setError(res.error)
      router.refresh()
    })
  }

  return (
    <li className={`rounded-xl border bg-card p-4 ${mailbox.status === 'broken' ? 'border-coral/50' : 'border-line/70'}`}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-ink">{title}</p>
          <p className="text-xs text-ink-soft">
            {SOURCE_LABEL[mailbox.source]} · {mailbox.readOnly ? 'csak olvasás' : 'olvasás + küldés'}
          </p>
        </div>
        <Badge tone={status.tone} title={status.hint}>
          {status.label}
        </Badge>
      </div>

      {mailbox.status === 'broken' ? (
        <p className="mt-3 rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral-deep">
          A postafiók kapcsolata megszakadt, az agentek most nem érik el. {status.hint}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line/50 pt-3">
        {mailbox.status !== 'active' ? (
          <button
            type="button"
            onClick={reconnect}
            disabled={busy}
            className="rounded-md bg-coral px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
          >
            Újracsatlakoztatás
          </button>
        ) : null}
        <button
          type="button"
          onClick={disconnect}
          disabled={busy}
          className="rounded-md border border-ink/15 px-3 py-1.5 text-xs font-semibold text-ink-soft disabled:opacity-60"
        >
          Leválasztás
        </button>
        {!mailbox.readOnly ? (
          <label className="ml-auto flex items-center gap-2 text-xs text-ink-soft" title="Bekapcsolva az agent írási módja sem küldhet jóváhagyás nélkül.">
            <input
              type="checkbox"
              checked={mailbox.requireApproval}
              disabled={busy}
              onChange={(e) => toggleApproval(e.target.checked)}
            />
            Küldés mindig jóváhagyással
          </label>
        ) : null}
      </div>

      {mailbox.status === 'pending' ? null : agents.length === 0 ? (
        <p className="mt-3 border-t border-line/50 pt-3 text-sm text-ink-soft">Nincs aktív agent a tenantban.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line/50 border-t border-line/50">
          {agents.map((agent) => (
            <li key={agent.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-sm text-ink">{agent.name}</span>
              <AccessToggle
                value={accessByAgent.get(agent.id) ?? 'none'}
                readOnly={mailbox.readOnly}
                disabled={pendingAgent !== null}
                onChange={(next) => setAccess(agent.id, next)}
              />
            </li>
          ))}
        </ul>
      )}
      <Feedback error={error} />
    </li>
  )
}

export function TenantMailboxPanel({
  overview,
  returnError,
  connected,
}: {
  overview: TenantMailboxOverview
  returnError: string | null
  connected: boolean
}) {
  return (
    <Card>
      <div>
        <h2 className="font-display text-lg font-semibold tracking-tight">Közös céges postafiókok</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Egy meglévő céges cím (pl. ugyfelszolgalat@ceg.hu) Google- vagy Microsoft-fiókját egyszer bekötöd, és
          bármelyik agenthez hozzárendelheted. Nem kell, hogy a munkatársak a saját fiókjukat kössék be, és a
          postafiók akkor is működik, ha a bekötő kilép a cégből.
        </p>
      </div>
      <div className="mt-4">
        <ConnectForm microsoftBases={overview.microsoftBases} />
      </div>
      <Feedback error={returnError} notice={connected ? 'A postafiók bekötve. Most válaszd ki, melyik agent használhatja.' : null} />
      {overview.mailboxes.length === 0 ? (
        <p className="mt-4 text-sm text-ink-soft">Még nincs bekötött közös postafiók.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {overview.mailboxes.map((mailbox) => (
            <MailboxCard
              key={mailbox.connectorId}
              mailbox={mailbox}
              agents={overview.agents}
              assignWarning={overview.assignWarning}
            />
          ))}
        </ul>
      )}
    </Card>
  )
}
