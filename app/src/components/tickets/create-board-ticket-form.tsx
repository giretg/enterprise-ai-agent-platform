'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { createBoardTicket } from '@/app/actions/platform'
import { getAgentSkillsAction } from '@/app/actions/skills'
import { AgentAssigneeSelect } from '@/components/agents/agent-assignee-select'
import {
  filterLaunchableSkills,
  TaskOnlyLaunchForm,
  type LaunchableSkill,
} from '@/components/agents/task-only-launch-form'
import { WorkspaceFileDropzone } from '@/components/workspace/workspace-file-dropzone'
import { useTicketDispatch } from '@/components/tickets/ticket-dispatch-client'
import {
  TicketDispatchPromptModal,
  type DispatchPrompt,
} from '@/components/tickets/ticket-dispatch-prompt-modal'
import { Badge, Card } from '@/components/ui/shell'
import { personaFor } from '@/lib/agent-persona'
import { uploadTicketWorkspaceFiles } from '@/lib/ticket-workspace-files-client'
import { skillDisplayLabel } from '@/lib/skill/skill-name'

type AssigneeOptions = {
  agents: {
    id: string
    name: string
    avatarUrl?: string | null
    personaNickname?: string | null
    personaTrait?: string | null
    status?: string
    taskOnly?: boolean
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
  displayName?: string | null
  description: string
  /** #199 — csatolható-e fájl, ha ez a skill van kiválasztva. */
  allowAttachments: boolean
  /** Várt csatolmány leírása — a fájlfeltöltés fölött jelenik meg. */
  attachmentDescription?: string
}

function makePendingFile(file: File): PendingFile {
  return { id: `${file.name}-${file.size}-${file.lastModified}`, file }
}

type CreateBoardTicketFormProps = {
  assigneeOptions: AssigneeOptions
  /** Agent kártyáról: a felelős mező előre kitöltve. */
  initialAgentId?: string
  /** `dialog`: portal modál (pl. dashboard kártya); `inline`: a táblán (alapértelmezett). */
  presentation?: 'inline' | 'dialog'
  trigger?: {
    label: string
    compact?: boolean
    className?: string
    title?: string
  }
}

export function CreateBoardTicketForm({
  assigneeOptions,
  initialAgentId,
  presentation = 'inline',
  trigger,
}: CreateBoardTicketFormProps) {
  const router = useRouter()
  const dispatchTicket = useTicketDispatch()
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [assigneeType, setAssigneeType] = useState<'agent' | 'human'>('agent')
  const [assigneeId, setAssigneeId] = useState(initialAgentId ?? '')
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([])
  /** Agenthez kötött cache — a UI ebből vezet le, így assignee váltáskor nincs sync setState az effectben. */
  const [skillsCache, setSkillsCache] = useState<{
    agentId: string
    skills: SkillOption[]
    launchableSkills: LaunchableSkill[]
  } | null>(null)
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
  const launchableSkills =
    assigneeType === 'agent' && assigneeId && skillsCache?.agentId === assigneeId
      ? skillsCache.launchableSkills
      : []
  const skillsLoading =
    assigneeType === 'agent' && Boolean(assigneeId) && skillsCache?.agentId !== assigneeId
  const selectedAgent = useMemo(
    () => assigneeOptions.agents.find((agent) => agent.id === assigneeId),
    [assigneeOptions.agents, assigneeId],
  )
  const isTaskOnlyMode =
    assigneeType === 'agent' && Boolean(assigneeId && selectedAgent?.taskOnly)

  useEffect(() => {
    if (assigneeType !== 'agent' || !assigneeId) return
    const agentId = assigneeId
    let cancelled = false
    void getAgentSkillsAction(agentId).then((res) => {
      if (cancelled) return
      if (!res.success) {
        setSkillsCache({ agentId, skills: [], launchableSkills: [] })
        return
      }
      const enabledBySkill = new Map<string, SkillOption>()
      for (const row of res.data) {
        if (!row.enabled || enabledBySkill.has(row.skillId)) continue
        enabledBySkill.set(row.skillId, {
          skillVersionId: row.skillVersionId,
          name: row.name,
          displayName: row.displayName,
          description: row.description,
          allowAttachments: row.allowAttachments,
          attachmentDescription: row.attachmentDescription,
        })
      }
      setSkillsCache({
        agentId,
        skills: [...enabledBySkill.values()],
        launchableSkills: filterLaunchableSkills(res.data),
      })
    })
    return () => {
      cancelled = true
    }
  }, [assigneeType, assigneeId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client portal mount gate
    setMounted(true)
  }, [])

  useEffect(() => {
    if (presentation !== 'dialog' || !open || !mounted) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !pending) {
        event.preventDefault()
        setOpen(false)
        setMessage(null)
        setPendingFiles([])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [presentation, open, mounted, pending])

  const openForm = () => {
    if (initialAgentId) {
      setAssigneeType('agent')
      setAssigneeId(initialAgentId)
    }
    setOpen(true)
  }

  const resetForm = () => {
    setTitle('')
    setDescription('')
    setAssigneeType('agent')
    setAssigneeId(initialAgentId ?? '')
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
    .map((skill) => skillDisplayLabel(skill))
  const attachmentsAllowed = attachmentsBlockedBy.length === 0
  const attachmentGuidance = agentSkills.filter(
    (skill) =>
      selectedSkillIds.includes(skill.skillVersionId) &&
      skill.allowAttachments &&
      skill.attachmentDescription,
  )

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

  const handleTaskOnlySubmit = ({
    skillVersionId,
    skillParameterValues,
    files: localFiles,
  }: {
    skillVersionId: string
    skillParameterValues: Record<string, string>
    files: File[]
  }) => {
    if (!assigneeId) return
    const skill = launchableSkills.find((row) => row.skillVersionId === skillVersionId)

    startTransition(async () => {
      setMessage(null)
      setLastTicketId(null)
      try {
        const res = await createBoardTicket({
          title: skill ? skillDisplayLabel(skill) : 'Feladat',
          assigneeType: 'agent',
          assigneeId,
          skillVersionIds: [skillVersionId],
          deferDispatch: true,
          ...(Object.keys(skillParameterValues).length > 0
            ? { skillParameterValues }
            : {}),
        })
        if (!res.success) {
          setMessage(res.error)
          return
        }

        const ticket = res.data.ticket
        if (localFiles.length > 0) {
          try {
            await uploadTicketWorkspaceFiles(ticket.id, localFiles)
          } catch (err) {
            setMessage(
              err instanceof Error
                ? `A feladat létrejött, de a fájlok feltöltése sikertelen: ${err.message}`
                : 'A feladat létrejött, de a fájlok feltöltése sikertelen',
            )
            setLastTicketId(ticket.id)
            router.refresh()
            return
          }
        }

        resetForm()
        setOpen(false)
        setLastTicketId(ticket.id)
        setDispatchPrompt({ ticketId: ticket.id, title: ticket.title })
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

  const triggerButton = (
    <button
      ref={createButtonRef}
      type="button"
      title={trigger?.title}
      onClick={(e) => {
        if (presentation === 'dialog') {
          e.preventDefault()
          e.stopPropagation()
        }
        openForm()
      }}
      className={
        trigger?.className ||
        (trigger?.compact
          ? 'rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep'
          : 'rounded-lg border border-coral/40 bg-coral/10 px-4 py-2 text-sm font-medium text-coral transition hover:bg-coral/15')
      }
    >
      {trigger?.label ?? '+ Új feladat létrehozása'}
    </button>
  )

  const closeForm = () => {
    setOpen(false)
    setMessage(null)
    setPendingFiles([])
  }

  const formBody = (
    <div className="space-y-4">
        <div className="flex flex-wrap gap-4">
          <fieldset>
            <legend className="text-sm font-medium text-ink-soft">Hozzárendelve</legend>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setAssigneeType('agent')
                  setAssigneeId(initialAgentId ?? '')
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
              Kinek kell végeznie a feladatot
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
                  setMessage(null)
                }}
              />
            ) : (
              <select
                id="board-ticket-assignee"
                value={assigneeId}
                onChange={(e) => {
                  setAssigneeId(e.target.value)
                  setSelectedSkillIds([])
                  setMessage(null)
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

        {isTaskOnlyMode ? (
          assigneeId ? (
            skillsLoading ? (
              <p className="text-sm text-ink-faint">Skillek betöltése…</p>
            ) : (
              <TaskOnlyLaunchForm
                skills={launchableSkills}
                pending={pending}
                message={message}
                submitLabel="Feladat létrehozása"
                onCancel={closeForm}
                onSubmit={handleTaskOnlySubmit}
              />
            )
          ) : null
        ) : (
          <>
            {assigneeType === 'agent' && assigneeId && (
              <p className="text-xs text-ink-faint">
                AI munkatárshoz rendelve a feladat a „Végrehajtásra vár” oszlopba kerül. Létrehozás után
                megkérdezzük, hogy induljon-e a feldolgozás — vagy később a kártyán lévő play gombbal
                indíthatod.
                {pendingFiles.length > 0
                  ? ' Csatolt fájl esetén előbb feltöltjük a workspace-be.'
                  : ''}
                Ha csak a cím van megadva leírás nélkül, a cím lesz a feladat szövege.
              </p>
            )}
            {assigneeType === 'human' && assigneeId && (
              <p className="text-xs text-ink-faint">
                A feladat az <Badge tone="warning">awaiting_human</Badge> oszlopba kerül — emberi
                döntésre vár.
                {pendingFiles.length > 0
                  ? ' A csatolt fájlok a feladat munkaterületén lesznek elérhetők.'
                  : ''}
              </p>
            )}

            <div>
              <label htmlFor="board-ticket-title" className="text-sm font-medium text-ink-soft">
                A feladat címe
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
                  A kiválasztott skillek a feldolgozás elején betöltődnek — az AI munkatárs ezeket
                  követi.
                </p>
                {skillsLoading ? (
                  <p className="mt-2 text-sm text-ink-faint">Skillek betöltése…</p>
                ) : agentSkills.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-faint">
                    Ehhez az AI munkatárshoz nincs engedélyezett skill.
                  </p>
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
                              <span className="block text-sm text-ink">
                                {skillDisplayLabel(skill)}
                              </span>
                              {skill.displayName?.trim() && skill.displayName.trim() !== skill.name ? (
                                <span className="block font-mono text-[11px] text-ink-faint">
                                  {skill.name}
                                </span>
                              ) : null}
                              {skill.description ? (
                                <span
                                  className="block truncate text-xs text-ink-faint"
                                  title={skill.description}
                                >
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
                Mi a feladat, amit el kell végezni
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
                Csatold a fájlt, ami a munka elvégzéséhez szükséges
              </p>
              {attachmentsAllowed && attachmentGuidance.length > 0 && (
                <div className="mt-2 space-y-2">
                  {attachmentGuidance.map((skill) => (
                    <p key={skill.skillVersionId} className="text-sm text-ink-soft">
                      {attachmentGuidance.length > 1 ? (
                        <>
                          <span className="font-medium">{skillDisplayLabel(skill)}:</span>{' '}
                          {skill.attachmentDescription}
                        </>
                      ) : (
                        skill.attachmentDescription
                      )}
                    </p>
                  ))}
                </div>
              )}
              {attachmentsAllowed ? (
                <div className="mt-2">
                  <WorkspaceFileDropzone
                    disabled={pending}
                    uploading={pending}
                    onFileSelected={addPendingFile}
                  />
                </div>
              ) : (
                <p className="mt-2 rounded-lg border border-honey/40 bg-honey/10 px-3 py-2 text-sm text-honey">
                  A kiválasztott skill ({attachmentsBlockedBy.join(', ')}) nem enged fájlcsatolást —
                  ehhez a feladathoz nem tölthetsz fel fájlt.
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
                onClick={closeForm}
                className="rounded-lg border border-line px-4 py-2 text-sm text-ink-soft transition hover:bg-night-2"
              >
                Mégse
              </button>
            </div>
          </>
        )}
    </div>
  )

  const formCard = (
    <Card title="Új feladat létrehozása" className="!p-5">
      {formBody}
    </Card>
  )

  if (!open) {
    if (presentation === 'dialog') {
      return (
        <>
          {modal}
          {triggerButton}
        </>
      )
    }

    return (
      <>
        {modal}
        <div className="flex flex-wrap items-center gap-3">
          {triggerButton}
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

  if (presentation === 'dialog' && mounted) {
    return (
      <>
        {modal}
        {triggerButton}
        {createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
            onClick={() => !pending && closeForm()}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="board-ticket-create-title"
              className="max-h-[90vh] w-full max-w-2xl overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div id="board-ticket-create-title" className="sr-only">
                Új feladat létrehozása
              </div>
              {formCard}
            </div>
          </div>,
          document.body,
        )}
      </>
    )
  }

  return (
    <>
      {modal}
      {formCard}
    </>
  )
}
