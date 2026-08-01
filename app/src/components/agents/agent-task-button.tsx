'use client'

import { useEffect, useId, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createBoardTicket } from '@/app/actions/platform'
import { getAgentSkillsAction } from '@/app/actions/skills'
import { WorkspaceFileDropzone } from '@/components/workspace/workspace-file-dropzone'
import { useTicketDispatch } from '@/components/tickets/ticket-dispatch-client'
import {
  TicketDispatchPromptModal,
  type DispatchPrompt,
} from '@/components/tickets/ticket-dispatch-prompt-modal'
import { uploadTicketWorkspaceFiles } from '@/lib/ticket-workspace-files-client'

/**
 * Feladatkör-korlátozás (#199) — a chat-gomb helyére lépő feladat-indító.
 *
 * A korlátozott agent felületén nincs szabad szöveges feladatleírás és nincs
 * cím-mező: a bemenetet a skill deklarált paraméterei és — ha a skill engedi — a
 * csatolt fájlok adják. A ticket címét a szerver generálja.
 *
 * Szándékosan KÜLÖN komponens a normál feladat-űrlaptól: az feltételes ágakkal
 * telezsúfolva mindkét út olvashatatlanná és törékennyé válna.
 */

type LaunchableSkill = {
  skillVersionId: string
  name: string
  description: string
  parameters: Array<{ name: string; description: string }>
  allowAttachments: boolean
}

type PendingFile = { id: string; file: File }

function makePendingFile(file: File): PendingFile {
  return { id: `${file.name}-${file.size}-${file.lastModified}`, file }
}

type SkillsState =
  | { status: 'loading' }
  | { status: 'ready'; skills: LaunchableSkill[] }
  | { status: 'error'; message: string }

export function AgentTaskButton({
  agentId,
  className = '',
  compact = false,
}: {
  agentId: string
  className?: string
  compact?: boolean
}) {
  const [skillsState, setSkillsState] = useState<SkillsState>({ status: 'loading' })
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let cancelled = false
    void getAgentSkillsAction(agentId).then((res) => {
      if (cancelled) return
      if (!res.success) {
        setSkillsState({ status: 'error', message: res.error })
        return
      }
      // Csak a ténylegesen futtatható skillek: engedélyezve + minden igényelt
      // eszköz grantolva (`readiness.color === 'green'`). A nem futtatható skill
      // gombja minden kattintásra hibát dobna — jobb letiltva, magyarázattal.
      const bySkill = new Map<string, LaunchableSkill>()
      for (const row of res.data) {
        if (!row.enabled || row.readiness.color !== 'green') continue
        if (bySkill.has(row.skillId)) continue
        bySkill.set(row.skillId, {
          skillVersionId: row.skillVersionId,
          name: row.name,
          description: row.description,
          parameters: row.parameters,
          allowAttachments: row.allowAttachments,
        })
      }
      setSkillsState({ status: 'ready', skills: [...bySkill.values()] })
    })
    return () => {
      cancelled = true
    }
  }, [agentId])

  const skills = skillsState.status === 'ready' ? skillsState.skills : []
  const loading = skillsState.status === 'loading'
  const disabled = loading || skills.length === 0
  const label = loading
    ? 'Betöltés…'
    : skills.length === 1
      ? skills[0].name
      : 'Feladat'
  const disabledReason =
    skillsState.status === 'error'
      ? // Tipikusan jogosultsági ok (a feladat-indítás operátori jogot kér) vagy
        // átmeneti hiba — a nyers üzenetet is megmutatjuk, hogy ne találgasson.
        `A feladat-indítás most nem érhető el: ${skillsState.message}`
      : skillsState.status === 'ready' && skills.length === 0
        ? 'Ehhez az agenthez nincs futtatható skill hozzárendelve — szólj az adminnak.'
        : undefined

  return (
    <>
      {open && (
        <AgentTaskModal
          agentId={agentId}
          skills={skills}
          returnFocusRef={buttonRef}
          onClose={() => setOpen(false)}
        />
      )}
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        title={disabledReason}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen(true)
        }}
        className={
          className ||
          (compact
            ? 'rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/40 hover:text-coral-deep disabled:cursor-not-allowed disabled:opacity-50'
            : 'rounded-full bg-sage px-4 py-2 text-sm font-semibold text-card shadow-[0_8px_20px_-12px_rgba(93,138,79,0.7)] transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0')
        }
      >
        ▶ <span className="truncate">{label}</span>
      </button>
    </>
  )
}

function AgentTaskModal({
  agentId,
  skills,
  returnFocusRef,
  onClose,
}: {
  agentId: string
  skills: LaunchableSkill[]
  returnFocusRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const router = useRouter()
  const dispatchTicket = useTicketDispatch()
  const titleId = useId()
  const [pending, startTransition] = useTransition()
  const [selectedId, setSelectedId] = useState(skills[0]?.skillVersionId ?? '')
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [dispatchPrompt, setDispatchPrompt] = useState<DispatchPrompt>(null)
  const [dispatchPending, startDispatchTransition] = useTransition()
  const startRef = useRef<HTMLButtonElement>(null)

  const selected = skills.find((s) => s.skillVersionId === selectedId) ?? skills[0]

  useEffect(() => {
    startRef.current?.focus()
  }, [])

  const addPendingFile = (file: File) => {
    setPendingFiles((prev) => {
      const next = makePendingFile(file)
      if (prev.some((item) => item.id === next.id)) return prev
      return [...prev, next]
    })
  }

  const selectSkill = (skillVersionId: string) => {
    setSelectedId(skillVersionId)
    // A paraméter-értékek és a fájlok az ELŐZŐ skillhez tartoztak — skillváltáskor
    // eldobjuk őket, különben ismeretlen paraméter-kulccsal bukna a küldés.
    setParamValues({})
    const next = skills.find((s) => s.skillVersionId === skillVersionId)
    if (next && !next.allowAttachments) setPendingFiles([])
  }

  const handleStart = () => {
    if (!selected) return
    const localFiles = selected.allowAttachments ? pendingFiles.map((item) => item.file) : []
    const values: Record<string, string> = {}
    for (const param of selected.parameters) {
      const raw = paramValues[param.name]
      if (typeof raw === 'string' && raw.trim()) values[param.name] = raw.trim()
    }

    startTransition(async () => {
      setMessage(null)
      try {
        const res = await createBoardTicket({
          // A címet a szerver generálja (`<skill neve> — dátum idő`); ez a mező
          // csak a séma minimumát elégíti ki, az értéke nem érvényesül.
          title: selected.name,
          assigneeType: 'agent',
          assigneeId: agentId,
          skillVersionIds: [selected.skillVersionId],
          deferDispatch: true,
          ...(Object.keys(values).length > 0 ? { skillParameterValues: values } : {}),
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
            router.refresh()
            return
          }
        }

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
      // Figyelmeztetéssel (pl. betelt napi keret) NEM zárunk: különben a
      // modállal együtt eltűnne az üzenet, és a felhasználó azt hinné, minden
      // rendben elindult.
      if (res.warning) {
        setMessage(res.warning)
        return
      }
      setDispatchPrompt(null)
      onClose()
    })
  }

  if (dispatchPrompt) {
    return (
      <TicketDispatchPromptModal
        prompt={dispatchPrompt}
        pending={dispatchPending}
        message={message}
        returnFocusRef={returnFocusRef}
        onStart={startDispatchFromPrompt}
        onLater={() => {
          setDispatchPrompt(null)
          setMessage(null)
          onClose()
        }}
      />
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={() => !pending && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="atelier-card w-full max-w-lg p-5"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !pending) {
            event.preventDefault()
            onClose()
          }
        }}
      >
        <h3 id={titleId} className="font-display text-lg font-semibold">
          {selected ? selected.name : 'Feladat indítása'}
        </h3>
        {selected?.description && (
          <p className="mt-1 text-sm text-ink-soft">{selected.description}</p>
        )}
        <p className="mt-2 text-xs text-ink-faint">
          Ez az agent korlátozott feladatkörű: a feladat leírását nem kell megírnod — a
          munkamenetet a skill tartalmazza.
        </p>

        {skills.length > 1 && (
          <div className="mt-4">
            <label htmlFor="agent-task-skill" className="text-sm font-medium text-ink-soft">
              Melyik feladat?
            </label>
            <select
              id="agent-task-skill"
              value={selected?.skillVersionId ?? ''}
              disabled={pending}
              onChange={(e) => selectSkill(e.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
            >
              {skills.map((skill) => (
                <option key={skill.skillVersionId} value={skill.skillVersionId}>
                  {skill.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {selected && selected.parameters.length > 0 && (
          <div className="mt-4 space-y-3">
            <p className="text-sm font-medium text-ink-soft">
              Kiegészítő adatok <span className="font-normal text-ink-faint">(opcionális)</span>
            </p>
            {selected.parameters.map((param) => (
              <div key={param.name}>
                <label
                  htmlFor={`agent-task-param-${param.name}`}
                  className="text-sm text-ink-soft"
                >
                  {param.name}
                </label>
                {param.description && (
                  <p className="text-xs text-ink-faint">{param.description}</p>
                )}
                <input
                  id={`agent-task-param-${param.name}`}
                  value={paramValues[param.name] ?? ''}
                  disabled={pending}
                  maxLength={2000}
                  onChange={(e) =>
                    setParamValues((prev) => ({ ...prev, [param.name]: e.target.value }))
                  }
                  className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
                />
              </div>
            ))}
          </div>
        )}

        {selected?.allowAttachments && (
          <div className="mt-4">
            <p className="text-sm font-medium text-ink-soft">
              Fájlok <span className="font-normal text-ink-faint">(opcionális)</span>
            </p>
            <div className="mt-2">
              <WorkspaceFileDropzone
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
                      onClick={() =>
                        setPendingFiles((prev) => prev.filter((f) => f.id !== item.id))
                      }
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
        )}

        {message && (
          <p className="mt-4 rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-sm text-coral">
            {message}
          </p>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={onClose}
            className="rounded-lg border border-line px-4 py-2 text-sm text-ink-soft transition hover:bg-night-2 disabled:opacity-50"
          >
            Mégse
          </button>
          <button
            ref={startRef}
            type="button"
            disabled={pending || !selected}
            onClick={handleStart}
            className="rounded-lg bg-coral px-4 py-2 text-sm font-medium text-white transition hover:bg-coral-deep disabled:opacity-60"
          >
            {pending ? 'Indítás…' : 'Indítás'}
          </button>
        </div>
      </div>
    </div>
  )
}
