'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'
import { createBoardTicket, dispatchBoardTicket } from '@/app/actions/platform'
import { TicketWorkspaceFileDropzone } from '@/components/tickets/ticket-workspace-file-dropzone'
import { Badge, Card } from '@/components/ui/shell'
import { personaFor } from '@/lib/agent-persona'
import { uploadTicketWorkspaceFiles } from '@/lib/ticket-workspace-files-client'

type AssigneeOptions = {
  agents: { id: string; name: string }[]
  users: { id: string; name: string; role: string }[]
}

type PendingFile = {
  id: string
  file: File
}

function makePendingFile(file: File): PendingFile {
  return { id: `${file.name}-${file.size}-${file.lastModified}`, file }
}

export function CreateBoardTicketForm({ assigneeOptions }: { assigneeOptions: AssigneeOptions }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [assigneeType, setAssigneeType] = useState<'agent' | 'human'>('agent')
  const [assigneeId, setAssigneeId] = useState('')
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
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
    setPendingFiles([])
  }

  const addPendingFile = (file: File) => {
    setPendingFiles((prev) => {
      const next = makePendingFile(file)
      if (prev.some((item) => item.id === next.id)) return prev
      return [...prev, next]
    })
  }

  const removePendingFile = (id: string) => {
    setPendingFiles((prev) => prev.filter((item) => item.id !== id))
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

    const localFiles = pendingFiles.map((item) => item.file)
    const shouldDeferDispatch = assigneeType === 'agent' && localFiles.length > 0

    startTransition(async () => {
      setMessage(null)
      setLastTicketId(null)
      try {
        const res = await createBoardTicket({
          title: trimmedTitle,
          description: description.trim() || undefined,
          assigneeType,
          assigneeId,
          deferDispatch: shouldDeferDispatch,
        })
        if (!res.success) {
          setMessage(res.error)
          return
        }

        const ticketId = res.data.ticket.id

        if (localFiles.length > 0) {
          try {
            await uploadTicketWorkspaceFiles(ticketId, localFiles)
          } catch (err) {
            setMessage(
              err instanceof Error
                ? `Ticket létrejött, de a fájlok feltöltése sikertelen: ${err.message}`
                : 'Ticket létrejött, de a fájlok feltöltése sikertelen',
            )
            setLastTicketId(ticketId)
            router.refresh()
            return
          }
        }

        let dispatchWarning =
          'warning' in res.data && typeof res.data.warning === 'string' ? res.data.warning : null

        if (shouldDeferDispatch) {
          const dispatchRes = await dispatchBoardTicket({ ticketId })
          if (!dispatchRes.success) {
            setMessage(
              dispatchRes.error ??
                'Ticket és fájlok létrejöttek, de a feldolgozás nem indult el.',
            )
            setLastTicketId(ticketId)
            router.refresh()
            return
          }
          dispatchWarning =
            'warning' in dispatchRes.data && typeof dispatchRes.data.warning === 'string'
              ? dispatchRes.data.warning
              : null
        }

        resetForm()
        setOpen(false)
        setLastTicketId(ticketId)
        if (dispatchWarning) {
          setMessage(dispatchWarning)
        }
        router.refresh()
      } catch (err) {
        setMessage(err instanceof Error ? err.message : 'Ticket létrehozása sikertelen')
      }
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

        <div>
          <p className="text-sm font-medium text-ink-soft">
            Fájlok <span className="font-normal text-ink-faint">(opcionális)</span>
          </p>
          <p className="mt-1 text-xs text-ink-faint">
            A csatolt fájlok a ticket workspace-ébe kerülnek — az agent a feldolgozás során
            eléri őket (file_list, file_read, xlsx_read_sheet, pptx_create, stb.).
          </p>
          <div className="mt-2">
            <TicketWorkspaceFileDropzone
              disabled={pending}
              uploading={pending}
              onFileSelected={addPendingFile}
            />
          </div>
          {pendingFiles.length > 0 ? (
            <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
              {pendingFiles.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="truncate text-sm text-ink" title={item.file.name}>
                    {item.file.name}
                  </span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => removePendingFile(item.id)}
                    className="shrink-0 text-sm text-coral hover:underline disabled:opacity-50"
                  >
                    Eltávolítás
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-ink-faint">Még nincs csatolt fájl.</p>
          )}
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
            {pendingFiles.length > 0
              ? ' Csatolt fájl esetén előbb feltöltjük a workspace-be, utána indul a feldolgozás.'
              : ''}
          </p>
        )}
        {assigneeType === 'human' && assigneeId && (
          <p className="text-xs text-ink-faint">
            A ticket az <Badge tone="warning">awaiting_human</Badge> oszlopba kerül — emberi döntésre vár.
            {pendingFiles.length > 0 ? ' A csatolt fájlok a ticket workspace-ében lesznek elérhetők.' : ''}
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
              setPendingFiles([])
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
