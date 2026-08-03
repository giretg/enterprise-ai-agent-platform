'use client'

import { useEffect, useId, useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { createBoardTicket } from '@/app/actions/platform'
import { getAgentSkillsAction } from '@/app/actions/skills'
import {
  filterLaunchableSkills,
  TaskOnlyLaunchForm,
  type LaunchableSkill,
} from '@/components/agents/task-only-launch-form'
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
      setSkillsState({ status: 'ready', skills: filterLaunchableSkills(res.data) })
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
      ? `A feladat-indítás most nem érhető el: ${skillsState.message}`
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
  const [message, setMessage] = useState<string | null>(null)
  const [dispatchPrompt, setDispatchPrompt] = useState<DispatchPrompt>(null)
  const [dispatchPending, startDispatchTransition] = useTransition()
  const [mounted, setMounted] = useState(false)
  const [modalSkill, setModalSkill] = useState<LaunchableSkill | undefined>(skills[0])
  const startRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client portal mount gate
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) return
    const returnFocusTarget = returnFocusRef.current
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !pending) {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      returnFocusTarget?.focus()
    }
  }, [mounted, pending, onClose, returnFocusRef])

  const handleStart = ({
    skillVersionId,
    skillParameterValues,
    files: localFiles,
  }: {
    skillVersionId: string
    skillParameterValues: Record<string, string>
    files: File[]
  }) => {
    const skill = skills.find((s) => s.skillVersionId === skillVersionId)
    if (!skill) return

    startTransition(async () => {
      setMessage(null)
      try {
        const res = await createBoardTicket({
          title: skill.name,
          assigneeType: 'agent',
          assigneeId: agentId,
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

  if (!mounted) return null

  return createPortal(
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
      >
        <h3 id={titleId} className="font-display text-lg font-semibold">
          {modalSkill ? modalSkill.name : 'Feladat indítása'}
        </h3>

        <div className="mt-4">
          <TaskOnlyLaunchForm
            skills={skills}
            pending={pending}
            message={message}
            submitLabel="Indítás"
            pendingLabel="Indítás…"
            onCancel={onClose}
            onSubmit={handleStart}
            onSelectedSkillChange={setModalSkill}
            initialFocusRef={startRef}
          />
        </div>
      </div>
    </div>,
    document.body,
  )
}
