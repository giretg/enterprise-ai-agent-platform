'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import type { ScheduledTaskRecurrence, ScheduledTaskStatus } from '@prisma/client'
import { revokeScheduledTask } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'
import { agentDisplayName } from '@/lib/agent-persona'

export type ScheduledTaskView = {
  id: string
  title: string
  status: ScheduledTaskStatus
  agentId: string
  nextRunAt: string
  recurrence: ScheduledTaskRecurrence
  runCount: number
  maxRuns: number | null
  runAsUserId: string | null
  materializedTicketId: string | null
  payload: unknown
}

export type ScheduledTaskAgentView = {
  id: string
  name: string
  personaNickname?: string | null
}

const statusLabel: Record<ScheduledTaskStatus, string> = {
  active: 'aktív',
  materializing: 'materializálás alatt',
  materialized: 'feladat készült',
  revoked: 'visszavonva',
}

const statusTone: Record<ScheduledTaskStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  active: 'warning',
  materializing: 'warning',
  materialized: 'success',
  revoked: 'danger',
}

const recurrenceLabel: Record<ScheduledTaskRecurrence, string> = {
  none: 'egyszer',
  daily: 'naponta',
  weekly: 'hetente',
  monthly: 'havonta',
  hourly: 'óránként',
}

function formatDate(date: Date | string): string {
  return new Intl.DateTimeFormat('hu-HU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(date))
}

function payloadQuestion(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return ''
  const value = (payload as Record<string, unknown>).question
  return typeof value === 'string' ? value : ''
}

function displayStatus(task: ScheduledTaskView): { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' } {
  if (task.status === 'active' && task.recurrence !== 'none' && task.runCount > 0) {
    return { label: 'aktív (ismétlődik)', tone: 'warning' }
  }
  return { label: statusLabel[task.status], tone: statusTone[task.status] }
}

export function ScheduledTaskList({
  tasks,
  agents,
}: {
  tasks: ScheduledTaskView[]
  agents: ScheduledTaskAgentView[]
}) {
  const router = useRouter()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const agentLabels = new Map(
    agents.map((agent) => [agent.id, agentDisplayName(agent.name, agent)]),
  )

  const revoke = (id: string) => {
    setPendingId(id)
    setMessage(null)
    startTransition(async () => {
      const res = await revokeScheduledTask({ id })
      if (!res.success) {
        setMessage(res.error)
        setPendingId(null)
        return
      }
      setMessage('Ütemezett task visszavonva.')
      setPendingId(null)
      router.refresh()
    })
  }

  if (tasks.length === 0) {
    return (
      <Card>
        <p className="text-sm text-ink-faint">
          Nincs ütemezett task. A feladat-modálban vagy az agent chatből tudsz időzítést megadni.
        </p>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {message && (
        <p className="rounded-lg border border-line bg-card px-4 py-2 text-sm text-ink-soft">
          {message}
        </p>
      )}

      <div className="grid gap-4">
        {tasks.map((task) => {
          const question = payloadQuestion(task.payload)
          const status = displayStatus(task)
          return (
            <Card key={task.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-display text-xl font-semibold text-ink">{task.title}</h2>
                    <Badge tone={status.tone}>{status.label}</Badge>
                    <Badge tone="neutral">{recurrenceLabel[task.recurrence]}</Badge>
                    {task.runAsUserId && <Badge tone="success">run-as</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-ink-faint">
                    {agentLabels.get(task.agentId) ?? task.agentId} · következő futás:{' '}
                    {formatDate(task.nextRunAt)}
                    {task.recurrence !== 'none' && (
                      <>
                        {' '}
                        · futások: {task.runCount}
                        {task.maxRuns ? `/${task.maxRuns}` : ''}
                      </>
                    )}
                  </p>
                  {question && (
                    <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-ink-soft">
                      {question}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {task.materializedTicketId && (
                    <Link
                      href={`/control-plane/tickets/${task.materializedTicketId}`}
                      className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-coral/45 hover:text-coral-deep"
                    >
                      Ticket
                    </Link>
                  )}
                  {(task.status === 'active' || task.status === 'materialized') && (
                    <button
                      type="button"
                      onClick={() => revoke(task.id)}
                      disabled={isPending && pendingId === task.id}
                      className="rounded-full border border-coral/30 px-3 py-1.5 text-xs font-semibold text-coral transition-colors hover:bg-coral/10 disabled:opacity-50"
                    >
                      {isPending && pendingId === task.id ? '...' : 'Visszavonás'}
                    </button>
                  )}
                </div>
              </div>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
