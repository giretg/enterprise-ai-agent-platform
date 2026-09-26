'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  connectAgentMailInboxAction,
  createAgentMailInboxAction,
  saveAgentMailApiKeyAction,
  type AgentMailInboxRow,
  type AgentMailOverview,
} from '@/app/actions/agentmail'
import { assignConnectorToAgent, unassignConnectorFromAgent } from '@/app/actions/provisioning'
import { Badge, Card } from '@/components/ui/shell'

type Access = 'none' | 'read' | 'write'

const ACCESS_OPTIONS: Array<{ value: Access; label: string; hint: string }> = [
  { value: 'none', label: 'Nincs', hint: 'Az agent nem látja ezt a postafiókot.' },
  {
    value: 'read',
    label: 'Olvas',
    hint: 'Elolvashatja a beérkezett leveleket és levélváltásokat, de nem küldhet.',
  },
  {
    value: 'write',
    label: 'Küldhet',
    hint: 'Olvas, és a saját nevében levelet küldhet vagy válaszolhat — minden küldés jóváhagyás után megy ki.',
  },
]

const inputClass =
  'w-full rounded-md border border-ink/15 bg-paper px-3 py-2 text-sm focus:border-coral/50 focus:outline-none'

function Feedback({ error, notice }: { error: string | null; notice?: string | null }) {
  if (error) return <p className="mt-3 text-sm text-coral-deep">{error}</p>
  if (notice) {
    return (
      <p className="mt-3 rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">{notice}</p>
    )
  }
  return null
}

function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 6.5 8.5 6 8.5-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function OrgKeyCard({ configured }: { configured: boolean }) {
  const router = useRouter()
  const [editing, setEditing] = useState(!configured)
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  function save() {
    start(async () => {
      setError(null)
      const res = await saveAgentMailApiKeyAction({ apiKey })
      if (!res.success) return setError(res.error)
      setApiKey('')
      setEditing(false)
      router.refresh()
    })
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight">1. AgentMail fiók</h2>
          <p className="mt-1 text-sm text-ink-soft">
            A cég saját AgentMail szervezeti kulcsa. A platform titkosítva tárolja, és csak postafiókok
            kezelésére használja — az agentek soha nem kapják meg.
          </p>
        </div>
        {configured ? <Badge tone="success">Csatlakoztatva · EU</Badge> : <Badge tone="warning">Nincs beállítva</Badge>}
      </div>

      {editing ? (
        <div className="mt-4 space-y-2">
          <label className="block text-sm">
            <span className="mb-1 block font-semibold">AgentMail API kulcs</span>
            <input
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className={inputClass}
              placeholder="am_…"
            />
            <span className="mt-1 block text-xs text-ink-soft">
              Az AgentMail konzolban hozd létre, EU régiós (api.agentmail.eu) szervezetben. Mentés előtt
              ellenőrizzük, hogy működik.
            </span>
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={pending || apiKey.trim().length < 10}
              className="rounded-md bg-coral px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {pending ? 'Ellenőrzés…' : 'Kulcs mentése'}
            </button>
            {configured ? (
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-md border border-ink/15 px-4 py-2 text-sm font-semibold text-ink-soft"
              >
                Mégse
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="mt-3 text-xs font-semibold text-coral hover:text-coral-deep"
        >
          Kulcs cseréje
        </button>
      )}
      <Feedback error={error} />
    </Card>
  )
}

function NewInboxForm({ onDone }: { onDone: (notice: string) => void }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [domain, setDomain] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-coral/40 bg-coral/10 px-4 py-2 text-sm font-semibold text-coral hover:bg-coral/15"
      >
        + Új postafiók
      </button>
    )
  }

  function create() {
    start(async () => {
      setError(null)
      const res = await createAgentMailInboxAction({ username, domain, displayName })
      if (!res.success) return setError(res.error)
      setOpen(false)
      setUsername('')
      setDomain('')
      setDisplayName('')
      onDone(`Létrehozva és bekötve: ${res.data.inbox.email}. Most válaszd ki, melyik agent használhatja.`)
      router.refresh()
    })
  }

  const preview = `${username.trim() || 'véletlen-név'}@${domain.trim() || 'agentmail.to'}`

  return (
    <div className="rounded-xl border border-coral/30 bg-coral/5 p-4">
      <h3 className="text-sm font-semibold">Új postafiók</h3>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Megjelenített név</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className={inputClass}
            placeholder="Anna, ügyfélszolgálat"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Felhasználónév</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={inputClass}
            placeholder="anna"
          />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block text-ink-soft">
            Domain <span className="text-xs">(üresen: agentmail.to; saját domain az AgentMailben ellenőrzött legyen)</span>
          </span>
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            className={inputClass}
            placeholder="agentmail.to"
          />
        </label>
      </div>
      <p className="mt-3 text-xs text-ink-soft">
        Cím: <span className="font-mono text-ink">{preview}</span>
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={create}
          disabled={pending}
          className="rounded-md bg-coral px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {pending ? 'Létrehozás…' : 'Létrehozás és bekötés'}
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
  disabled,
  onChange,
}: {
  value: Access
  disabled: boolean
  onChange: (next: Access) => void
}) {
  return (
    <div role="radiogroup" className="inline-flex rounded-lg border border-ink/15 bg-paper p-0.5">
      {ACCESS_OPTIONS.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.hint}
            disabled={disabled}
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

function InboxCard({
  inbox,
  agents,
}: {
  inbox: AgentMailInboxRow
  agents: AgentMailOverview['agents']
}) {
  const router = useRouter()
  const [pendingAgent, setPendingAgent] = useState<string | null>(null)
  const [connecting, startConnect] = useTransition()
  const [, startAccess] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const accessByAgent = new Map(inbox.bindings.map((b) => [b.agentId, b.accessMode as Access]))
  const assigned = agents.filter((agent) => accessByAgent.has(agent.id))

  function connect() {
    startConnect(async () => {
      setError(null)
      const res = await connectAgentMailInboxAction({ inboxId: inbox.inboxId })
      if (!res.success) return setError(res.error)
      router.refresh()
    })
  }

  function setAccess(agentId: string, next: Access) {
    const connectorId = inbox.connectorId
    if (!connectorId) return
    setPendingAgent(agentId)
    startAccess(async () => {
      setError(null)
      const res =
        next === 'none'
          ? await unassignConnectorFromAgent({ connectorId, agentId })
          : await assignConnectorToAgent({ connectorId, agentId, accessMode: next })
      setPendingAgent(null)
      if (!res.success) return setError(res.error)
      router.refresh()
    })
  }

  return (
    <li className="rounded-xl border border-line/70 bg-card p-4">
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-coral/10 text-coral">
          <MailIcon />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink">{inbox.displayName ?? inbox.email}</p>
          <p className="truncate font-mono text-xs text-ink-soft">{inbox.email}</p>
          {assigned.length > 0 ? (
            <p className="mt-1 text-xs text-ink-soft">
              Használja: {assigned.map((agent) => agent.name).join(', ')}
            </p>
          ) : null}
        </div>
        {inbox.missing ? (
          <Badge tone="danger" title="A postafiók már nem létezik az AgentMailben; a kötéseket érdemes levenni.">
            Törölve az AgentMailben
          </Badge>
        ) : inbox.connectorId ? (
          <Badge tone="success">Bekötve</Badge>
        ) : (
          <Badge>Nincs bekötve</Badge>
        )}
      </div>

      {!inbox.connectorId ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line/50 pt-3">
          <button
            type="button"
            onClick={connect}
            disabled={connecting}
            className="rounded-md bg-coral px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {connecting ? 'Bekötés…' : 'Bekötés a platformba'}
          </button>
          <span className="text-xs text-ink-soft">
            Külön, csak erre a postafiókra érvényes kulcs készül (olvasás + küldés).
          </span>
        </div>
      ) : agents.length === 0 ? (
        <p className="mt-3 border-t border-line/50 pt-3 text-sm text-ink-soft">Nincs aktív agent a tenantban.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line/50 border-t border-line/50">
          {agents.map((agent) => (
            <li key={agent.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-sm text-ink">{agent.name}</span>
              <AccessToggle
                value={accessByAgent.get(agent.id) ?? 'none'}
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

export function AgentMailPanel({ overview }: { overview: AgentMailOverview }) {
  const [notice, setNotice] = useState<string | null>(null)
  return (
    <div className="space-y-6">
      <OrgKeyCard configured={overview.configured} />
      {overview.configured ? (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold tracking-tight">2. Postafiókok és agentek</h2>
              <p className="mt-1 text-sm text-ink-soft">
                Egy postafiókot több agent is használhat. „Olvas”: beérkezett levelek; „Küldhet”: a saját
                nevében ír és válaszol, jóváhagyással.
              </p>
            </div>
          </div>
          <div className="mt-4">
            <NewInboxForm onDone={setNotice} />
          </div>
          <Feedback error={overview.loadError} notice={notice} />
          {overview.inboxes.length === 0 && !overview.loadError ? (
            <p className="mt-4 text-sm text-ink-soft">Még nincs postafiók az AgentMail fiókban.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {overview.inboxes.map((inbox) => (
                <InboxCard key={inbox.inboxId} inbox={inbox} agents={overview.agents} />
              ))}
            </ul>
          )}
        </Card>
      ) : null}
    </div>
  )
}
