'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'
import { createBoardTicket } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'
import { personaFor } from '@/lib/agent-persona'

type AssigneeOptions = {
  agents: { id: string; name: string }[]
  users: { id: string; name: string; role: string }[]
}

export function CreateBoardTicketForm({ assigneeOptions }: { assigneeOptions: AssigneeOptions }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [assigneeType, setAssigneeType] = useState<'agent' | 'human'>('agent')
  const [assigneeId, setAssigneeId] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [lastTicketId, setLastTicketId] = useState<string | null>(null)

  const assigneeChoices = useMemo(() => {
    if (assigneeType === 'agent') {
      return assigneeOptions.agents.map((agent) => ({
        id: agent.id,
        label: personaFor(agent.name).nickname,
        detail: agent.name,
      }))
    }
    return assigneeOptions.users.map((user) => ({
      id: user.id,
      label: user.name,
      detail: user.role,
    }))
  }, [assigneeOptions, assigneeType])

  const resetForm = () => {
    setTitle('')
    setDescription('')
    setAssigneeType('agent')
    setAssigneeId('')
  }

  const handleSubmit = () => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      setMessage('A cím megadása kötelező')
      return
    }
    if (!assigneeId) {
      setMessage('Válassz hozzárendelést')
      return
    }

    startTransition(async () => {
      setMessage(null)
      setLastTicketId(null)
      const res = await createBoardTicket({
        title: trimmedTitle,
        description: description.trim() || undefined,
        assigneeType,
        assigneeId,
      })
      if (!res.success) {
        setMessage(res.error)
        return
      }
      resetForm()
      setOpen(false)
      setLastTicketId(res.data.ticket.id)
      const dispatchWarning =
        'warning' in res.data && typeof res.data.warning === 'string' ? res.data.warning : null
      if (dispatchWarning) {
        setMessage(dispatchWarning)
      }
      router.refresh()
    })
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border border-coral/40 bg-coral/10 px-4 py-2 text-sm font-medium text-coral transition hover:bg-coral/15"
        >
          + Új ticket
        </button>
        {lastTicketId && (
          <p className={`text-sm ${message ? 'text-honey' : 'text-sage'}`}>
            {message ? (
              message
            ) : (
              <>
                Ticket létrehozva —{' '}
                <Link href={`/control-plane/tickets/${lastTicketId}`} className="underline hover:text-ink">
                  megnyitás
                </Link>
              </>
            )}
          </p>
        )}
      </div>
    )
  }

  return (
    <Card title="Új ticket" className="!p-5">
      <div className="space-y-4">
        <div>
          <label htmlFor="board-ticket-title" className="text-sm font-medium text-ink-soft">
            Cím
          </label>
          <input
            id="board-ticket-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            placeholder="Rövid feladatleírás"
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
          />
        </div>

        <div>
          <label htmlFor="board-ticket-description" className="text-sm font-medium text-ink-soft">
            Leírás <span className="font-normal text-ink-faint">(opcionális)</span>
          </label>
          <textarea
            id="board-ticket-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder="Részletek, kontextus, elvárások…"
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
          />
        </div>

        <div className="flex flex-wrap gap-4">
          <fieldset>
            <legend className="text-sm font-medium text-ink-soft">Hozzárendelve</legend>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setAssigneeType('agent')
                  setAssigneeId('')
                }}
                className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                  assigneeType === 'agent'
                    ? 'border-sky/50 bg-sky/10 text-ink'
                    : 'border-line text-ink-soft hover:border-sky/30'
                }`}
              >
                AI agent
              </button>
              <button
                type="button"
                onClick={() => {
                  setAssigneeType('human')
                  setAssigneeId('')
                }}
                className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                  assigneeType === 'human'
                    ? 'border-coral/50 bg-coral/10 text-ink'
                    : 'border-line text-ink-soft hover:border-coral/30'
                }`}
              >
                Ember
              </button>
            </div>
          </fieldset>

          <div className="min-w-[220px] flex-1">
            <label htmlFor="board-ticket-assignee" className="text-sm font-medium text-ink-soft">
              {assigneeType === 'agent' ? 'Agent' : 'Felhasználó'}
            </label>
            <select
              id="board-ticket-assignee"
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
            >
              <option value="">Válassz…</option>
              {assigneeChoices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                  {choice.detail && choice.detail !== choice.label ? ` (${choice.detail})` : ''}
                </option>
              ))}
            </select>
            {assigneeType === 'agent' && assigneeOptions.agents.length === 0 && (
              <p className="mt-1 text-xs text-coral">Nincs aktív agent.</p>
            )}
            {assigneeType === 'human' && assigneeOptions.users.length === 0 && (
              <p className="mt-1 text-xs text-coral">Nincs aktív felhasználó.</p>
            )}
          </div>
        </div>

        {assigneeType === 'agent' && assigneeId && (
          <p className="text-xs text-ink-faint">
            AI-hoz rendelve a ticket feldolgozásra kerül (local dev: azonnal; production: dispatcher
            worker). Ha csak a cím van megadva leírás nélkül, a cím lesz a feladat szövege.
          </p>
        )}
        {assigneeType === 'human' && assigneeId && (
          <p className="text-xs text-ink-faint">
            A ticket az <Badge tone="warning">awaiting_human</Badge> oszlopba kerül — emberi döntésre vár.
          </p>
        )}

        {message && (
          <p
            className={`rounded-lg border px-3 py-2 text-sm ${
              message.includes('létrejött')
                ? 'border-honey/40 bg-honey/10 text-honey'
                : 'border-coral/30 bg-coral/10 text-coral'
            }`}
          >
            {message}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={handleSubmit}
            className="rounded-lg bg-coral px-4 py-2 text-sm font-medium text-white transition hover:bg-coral-deep disabled:opacity-60"
          >
            {pending ? 'Létrehozás…' : 'Ticket létrehozása'}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setOpen(false)
              setMessage(null)
            }}
            className="rounded-lg border border-line px-4 py-2 text-sm text-ink-soft transition hover:bg-night-2"
          >
            Mégse
          </button>
        </div>
      </div>
    </Card>
  )
}
