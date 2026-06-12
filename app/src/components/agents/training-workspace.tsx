'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import type { Agent, Ticket } from '@prisma/client'
import {
  approveTraining,
  createTrainingTicket,
  rollbackMemory,
} from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'

type TrainingPayload = {
  diff?: { before?: string; after?: string; summary?: string }
  proposedContent?: string
  source?: string
}

function trainingPayload(ticket: Ticket): TrainingPayload {
  if (typeof ticket.payload === 'object' && ticket.payload !== null && !Array.isArray(ticket.payload)) {
    return ticket.payload as TrainingPayload
  }
  return {}
}

export function TrainingWorkspace({
  agents,
  trainingTickets,
  selectedAgentId,
}: {
  agents: Agent[]
  trainingTickets: Ticket[]
  selectedAgentId?: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [agentId, setAgentId] = useState(selectedAgentId ?? agents[0]?.id ?? '')
  const [content, setContent] = useState('')
  const [rollbackTo, setRollbackTo] = useState(1)
  const [message, setMessage] = useState<string | null>(null)

  const selectedAgent = agents.find((a) => a.id === agentId)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-ink-soft">
          Agent:
          <select
            value={agentId}
            onChange={(e) => {
              setAgentId(e.target.value)
              router.push(`/control-plane/training?agentId=${e.target.value}`)
            }}
            className="ml-2 rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        {selectedAgent && (
          <Link
            href={`/control-plane/agents/${selectedAgent.id}`}
            className="text-sm text-sky hover:underline"
          >
            Anatómia →
          </Link>
        )}
      </div>

      <Card title="Új tanítási javaslat">
        <textarea
          className="mb-3 w-full rounded-lg border border-line bg-night-2 p-3 text-sm"
          rows={5}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Javasolt memória tartalom..."
        />
        <button
          type="button"
          disabled={pending || !content.trim() || !agentId}
          className="rounded-full bg-sky/20 px-4 py-2 text-sm font-semibold text-sky disabled:opacity-50"
          onClick={() => {
            startTransition(async () => {
              const res = await createTrainingTicket({
                agentId,
                proposedContent: content,
                source: 'manual',
              })
              setMessage(res.success ? 'Training ticket létrehozva' : res.error)
              if (res.success) {
                setContent('')
                router.refresh()
              }
            })
          }}
        >
          Tanítási ticket létrehozása
        </button>
      </Card>

      <Card title="Függőben lévő tanítási ticketek">
        {trainingTickets.length === 0 ? (
          <p className="text-sm text-ink-faint">Nincs aktív training ticket.</p>
        ) : (
          <ul className="space-y-4">
            {trainingTickets.map((ticket) => {
              const payload = trainingPayload(ticket)
              const diff = payload.diff
              return (
                <li key={ticket.id} className="atelier-soft p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="font-medium">{ticket.title}</span>
                    <Badge tone="warning">{ticket.state}</Badge>
                    <Link
                      href={`/control-plane/tickets/${ticket.id}`}
                      className="text-xs text-sky hover:underline"
                    >
                      Részlet
                    </Link>
                  </div>
                  {diff && (
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <p className="mb-1 text-xs font-semibold text-ink-faint">Előtte</p>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-night-2 p-2 text-xs text-ink-soft">
                          {diff.before || '(üres)'}
                        </pre>
                      </div>
                      <div>
                        <p className="mb-1 text-xs font-semibold text-ink-faint">Utána</p>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-night-2 p-2 text-xs text-ink-soft">
                          {diff.after || payload.proposedContent || '—'}
                        </pre>
                      </div>
                    </div>
                  )}
                  {ticket.state === 'awaiting_human' && (
                    <button
                      type="button"
                      disabled={pending}
                      className="mt-3 rounded-full bg-sage/20 px-4 py-2 text-sm font-semibold text-sage disabled:opacity-50"
                      onClick={() => {
                        startTransition(async () => {
                          const res = await approveTraining({ ticketId: ticket.id })
                          setMessage(res.success ? 'Memória frissítve' : res.error)
                          if (res.success) router.refresh()
                        })
                      }}
                    >
                      Jóváhagyás (approver)
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <Card title="Memória rollback">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            min={1}
            value={rollbackTo}
            onChange={(e) => setRollbackTo(Number(e.target.value))}
            className="w-20 rounded-lg border border-line bg-night-2 px-2 py-2 text-sm"
          />
          <button
            type="button"
            disabled={pending || !agentId}
            className="rounded-full bg-honey/20 px-4 py-2 text-sm font-semibold text-honey disabled:opacity-50"
            onClick={() => {
              startTransition(async () => {
                const res = await rollbackMemory({ agentId, toVersion: rollbackTo })
                setMessage(res.success ? `Rollback v${rollbackTo}` : res.error)
                if (res.success) router.refresh()
              })
            }}
          >
            Visszagörgetés
          </button>
        </div>
      </Card>

      {message && <p className="text-sm text-ink-soft">{message}</p>}
    </div>
  )
}
