'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { createBoardTicket } from '@/app/actions/platform'
import { getAgentSkillsAction } from '@/app/actions/skills'
import { AgentAssigneeSelect } from '@/components/agents/agent-assignee-select'
import { WorkspaceFileDropzone } from '@/components/workspace/workspace-file-dropzone'
import { useTicketDispatch } from '@/components/tickets/ticket-dispatch-client'
import {
  TicketDispatchPromptModal,
  type DispatchPrompt,
} from '@/components/tickets/ticket-dispatch-prompt-modal'
import { Badge, Card } from '@/components/ui/shell'
import { personaFor } from '@/lib/agent-persona'
import { uploadTicketWorkspaceFiles } from '@/lib/ticket-workspace-files-client'

type AssigneeOptions = {
  agents: {
    id: string
    name: string
    avatarUrl?: string | null
    personaNickname?: string | null
    personaTrait?: string | null
    status?: string
  }[]
  users: { id: string; name: string; role: string }[]
}

type PendingFile = {
  id: string
  file: File
}

type SkillOption = {
  skillVersionId: string
  name: string
  description: string
  /** #199 — csatolható-e fájl, ha ez a skill van kiválasztva. */
  allowAttachments: boolean
}

function makePendingFile(file: File): PendingFile {
  return { id: `${file.name}-${file.size}-${file.lastModified}`, file }
}

export function CreateBoardTicketForm({ assigneeOptions }: { assigneeOptions: AssigneeOptions }) {
  const router = useRouter()
  const dispatchTicket = useTicketDispatch()
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [assigneeType, setAssigneeType] = useState<'agent' | 'human'>('agent')
  const [assigneeId, setAssigneeId] = useState('')
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([])
  /** Agenthez kötött cache — a UI ebből vezet le, így assignee váltáskor nincs sync setState az effectben. */
  const [skillsCache, setSkillsCache] = useState<{ agentId: string; skills: SkillOption[] } | null>(
    null,
  )
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [lastTicketId, setLastTicketId] = useState<string | null>(null)
  const [dispatchPrompt, setDispatchPrompt] = useState<DispatchPrompt>(null)
  const [dispatchPending, startDispatchTransition] = useTransition()

  const assigneeChoices = useMemo(() => {
    if (assigneeType === 'agent') {
      return assigneeOptions.agents.map((agent) => ({
        id: agent.id,
        label: personaFor(agent.name, { personaNickname: agent.personaNickname }).nickname,
      }))
    }
    return assigneeOptions.users.map((user) => ({
      id: user.id,
      label: user.name,
      detail: user.role,
    }))
  }, [assigneeOptions, assigneeType])

  const agentSkills =
    assigneeType === 'agent' && assigneeId && skillsCache?.agentId === assigneeId
      ? skillsCache.skills
      : []
  const skillsLoading =
    assigneeType === 'agent' && Boolean(assigneeId) && skillsCache?.agentId !== assigneeId

  useEffect(() => {
    if (assigneeType !== 'agent' || !assigneeId) return
    const agentId = assigneeId
    let cancelled = false
    void getAgentSkillsAction(agentId).then((res) => {
      if (cancelled) return
      if (!res.success) {
        setSkillsCache({ agentId, skills: [] })
        return
      }
      const enabledBySkill = new Map<string, SkillOption>()
      for (const row of res.data) {
        if (!row.enabled || enabledBySkill.has(row.skillId)) continue
        enabledBySkill.set(row.skillId, {
          skillVersionId: row.skillVersionId,
          name: row.name,
          description: row.description,
          allowAttachments: row.allowAttachments,
        })
      }
      setSkillsCache({ agentId, skills: [...enabledBySkill.values()] })
    })
    return () => {
      cancelled = true
    }
  }, [assigneeType, assigneeId])

  const resetForm = () => {
    setTitle('')
    setDescription('')
    setAssigneeType('agent')
    setAssigneeId('')
    setSelectedSkillIds([])
    setSkillsCache(null)
    setPendingFiles([])
  }

  // #199 — csatolmány-kapu az explicit skill-választás mellett. A szerver
  // (createBoardTicket + a workspace-feltöltő endpoint) úgyis elutasítaná a
  // feltöltést; itt azért tüntetjük el a dropzone-t, hogy a felhasználó ne
  // töltsön fel előbb fájlt, és csak utána kapjon hibát.
  const attachmentsBlockedBy = agentSkills
    .filter((skill) => selectedSkillIds.includes(skill.skillVersionId) && !skill.allowAttachments)
    .map((skill) => skill.name)
  const attachmentsAllowed = attachmentsBlockedBy.length === 0

  const toggleSkill = (skillVersionId: string) => {
    const next = selectedSkillIds.includes(skillVersionId)
      ? selectedSkillIds.filter((id) => id !== skillVersionId)
      : [...selectedSkillIds, skillVersionId]
    setSelectedSkillIds(next)
    const blocks = agentSkills.some(
      (skill) => next.includes(skill.skillVersionId) && !skill.allowAttachments,
    )
    // A már kiválasztott fájlokat eldobjuk, különben a felhasználó azt hinné,
    // hogy elmentek — a feltöltésük szerveroldalon 403-mal bukna.
    if (blocks) setPendingFiles([])
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
    const shouldDeferDispatch = assigneeType === 'agent'

    startTransition(async () => {
      setMessage(null)
      setLastTicketId(null)
      try {
        const res = await createBoardTicket({
          title: trimmedTitle,
          description: description.trim() || undefined,
          assigneeType,
          assigneeId,
          skillVersionIds:
            assigneeType === 'agent' && selectedSkillIds.length > 0 ? selectedSkillIds : undefined,
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
                ? `A feladat létrejött, de a fájlok feltöltése sikertelen: ${err.message}`
                : 'A feladat létrejött, de a fájlok feltöltése sikertelen',
            )
            setLastTicketId(ticketId)
            router.refresh()
            return
          }
        }

        resetForm()
        setOpen(false)
        setLastTicketId(ticketId)
        if (assigneeType === 'agent') {
          setDispatchPrompt({ ticketId, title: trimmedTitle })
        }
        router.refresh()
      } catch (err) {
        setMessage(err instanceof Error ? err.message : 'Feladat létrehozása sikertelen')
      }
    })
  }

  const startDispatchFromPrompt = () => {
    if (!dispatchPrompt) return
    startDispatchTransition(async () => {
      setMessage(null)
      const res = await dispatchTicket(dispatchPrompt.ticketId)
      if (!res.success) {
        setMessage(res.error)
        return
      }
      setDispatchPrompt(null)
      if (res.warning) {
        setMessage(res.warning)
      }
    })
  }

  const modal = dispatchPrompt ? (
    <TicketDispatchPromptModal
      prompt={dispatchPrompt}
      pending={dispatchPending}
      message={message}
      returnFocusRef={createButtonRef}
      onStart={startDispatchFromPrompt}
      onLater={() => {
        setDispatchPrompt(null)
        setMessage(null)
      }}
    />
  ) : null

  if (!open) {
    return (
      <>
        {modal}
        <div className="flex flex-wrap items-center gap-3">
        <button
          ref={createButtonRef}
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border border-coral/40 bg-coral/10 px-4 py-2 text-sm font-medium text-coral transition hover:bg-coral/15"
        >
          + Új feladat
        </button>
        {lastTicketId && (
          <p className={`text-sm ${message ? 'text-honey' : 'text-sage'}`}>
            {message ? (
              message
            ) : (
              <>
                Feladat létrehozva —{' '}
                <Link href={`/control-plane/tickets/${lastTicketId}`} className="underline hover:text-ink">
                  megnyitás
                </Link>
              </>
            )}
          </p>
        )}
        </div>
      </>
    )
  }

  return (
    <>
      {modal}
      <Card title="Új feladat" className="!p-5">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-4">
          <fieldset>
            <legend className="text-sm font-medium text-ink-soft">Hozzárendelve</legend>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setAssigneeType('agent')
                  setAssigneeId('')
                  setSelectedSkillIds([])
                }}
                className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                  assigneeType === 'agent'
                    ? 'border-sky/50 bg-sky/10 text-ink'
                    : 'border-line text-ink-soft hover:border-sky/30'
                }`}
              >
                AI munkatárs
              </button>
              <button
                type="button"
                onClick={() => {
                  setAssigneeType('human')
                  setAssigneeId('')
                  setSelectedSkillIds([])
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
              {assigneeType === 'agent' ? 'AI munkatárs' : 'Felhasználó'}
            </label>
            {assigneeType === 'agent' ? (
              <AgentAssigneeSelect
                id="board-ticket-assignee"
                agents={assigneeOptions.agents}
                value={assigneeId}
                disabled={pending}
                onChange={(nextId) => {
                  setAssigneeId(nextId)
                  setSelectedSkillIds([])
                }}
              />
            ) : (
              <select
                id="board-ticket-assignee"
                value={assigneeId}
                onChange={(e) => {
                  setAssigneeId(e.target.value)
                  setSelectedSkillIds([])
                }}
                className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
              >
                <option value="">Válassz…</option>
                {assigneeChoices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                    {'detail' in choice && choice.detail && choice.detail !== choice.label
                      ? ` (${choice.detail})`
                      : ''}
                  </option>
                ))}
              </select>
            )}
            {assigneeType === 'agent' && assigneeOptions.agents.length === 0 && (
              <p className="mt-1 text-xs text-coral">Nincs aktív AI munkatárs.</p>
            )}
            {assigneeType === 'human' && assigneeOptions.users.length === 0 && (
              <p className="mt-1 text-xs text-coral">Nincs aktív felhasználó.</p>
            )}
          </div>
        </div>

        {assigneeType === 'agent' && assigneeId && (
          <p className="text-xs text-ink-faint">
            AI munkatárshoz rendelve a feladat a Ready oszlopba kerül. Létrehozás után megkérdezzük, hogy
            induljon-e a feldolgozás — vagy később a kártyán lévő play gombbal indíthatod.
            {pendingFiles.length > 0
              ? ' Csatolt fájl esetén előbb feltöltjük a workspace-be.'
              : ''}
            Ha csak a cím van megadva leírás nélkül, a cím lesz a feladat szövege.
          </p>
        )}
        {assigneeType === 'human' && assigneeId && (
          <p className="text-xs text-ink-faint">
            A feladat az <Badge tone="warning">awaiting_human</Badge> oszlopba kerül — emberi döntésre vár.
            {pendingFiles.length > 0 ? ' A csatolt fájlok a feladat munkaterületén lesznek elérhetők.' : ''}
          </p>
        )}

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

        {assigneeType === 'agent' && assigneeId && (
          <div>
            <p className="text-sm font-medium text-ink-soft">
              Skillek <span className="font-normal text-ink-faint">(opcionális)</span>
            </p>
            <p className="mt-1 text-xs text-ink-faint">
              A kiválasztott skillek a feldolgozás elején betöltődnek — az AI munkatárs ezeket követi.
            </p>
            {skillsLoading ? (
              <p className="mt-2 text-sm text-ink-faint">Skillek betöltése…</p>
            ) : agentSkills.length === 0 ? (
              <p className="mt-2 text-sm text-ink-faint">Ehhez az AI munkatárshoz nincs engedélyezett skill.</p>
            ) : (
              <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
                {agentSkills.map((skill) => {
                  const checked = selectedSkillIds.includes(skill.skillVersionId)
                  return (
                    <li key={skill.skillVersionId}>
                      <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-night-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSkill(skill.skillVersionId)}
                          className="mt-0.5"
                        />
                        <span className="min-w-0">
                          <span className="block text-sm text-ink">{skill.name}</span>
                          {skill.description ? (
                            <span className="block truncate text-xs text-ink-faint" title={skill.description}>
                              {skill.description}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}

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
          {attachmentsAllowed ? (
            <>
              <p className="mt-1 text-xs text-ink-faint">
                A csatolt fájlok a feladat munkaterületére kerülnek — az AI munkatárs a feldolgozás során
                eléri őket (file_list, file_read, xlsx_read_sheet, pptx_create, stb.).
              </p>
              <div className="mt-2">
                <WorkspaceFileDropzone
                  disabled={pending}
                  uploading={pending}
                  onFileSelected={addPendingFile}
                />
              </div>
            </>
          ) : (
            <p className="mt-2 rounded-lg border border-honey/40 bg-honey/10 px-3 py-2 text-sm text-honey">
              A kiválasztott skill ({attachmentsBlockedBy.join(', ')}) nem enged fájlcsatolást — ehhez
              a feladathoz nem tölthetsz fel fájlt.
            </p>
          )}
          {attachmentsAllowed && pendingFiles.length > 0 ? (
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
          ) : attachmentsAllowed ? (
            <p className="mt-2 text-sm text-ink-faint">Még nincs csatolt fájl.</p>
          ) : null}
        </div>

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
            {pending ? 'Létrehozás…' : 'Feladat létrehozása'}
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
    </>
  )
}
