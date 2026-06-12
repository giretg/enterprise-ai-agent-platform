'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import {
  approveTraining,
  createTrainingTicket,
  listTickets,
  rollbackMemory,
} from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

export function TrainingPanel({
  agentId,
  currentVersion,
}: {
  agentId: string
  currentVersion: number
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [content, setContent] = useState('')
  const [rollbackTo, setRollbackTo] = useState(Math.max(1, currentVersion - 1))
  const [message, setMessage] = useState<string | null>(null)

  return (
    <Card title="Tanítás v1">
      <p className="mb-4 text-sm text-ink-soft">
        Javasolt memória-tartalom → training ticket → approver jóváhagyás
      </p>
      <textarea
        className="mb-3 w-full rounded-lg border border-line bg-night-2 p-3 text-sm"
        rows={5}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Új memória tartalom..."
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending || !content.trim()}
          className="rounded-full bg-sky/20 px-4 py-2 text-sm font-semibold text-sky disabled:opacity-50"
          onClick={() => {
            startTransition(async () => {
              const res = await createTrainingTicket({
                agentId,
                proposedContent: content,
                source: 'manual',
              })
              setMessage(res.success ? 'Training ticket létrehozva' : res.error)
              if (res.success) router.refresh()
            })
          }}
        >
          Tanítási ticket
        </button>
        <button
          type="button"
          disabled={pending}
          className="rounded-full bg-sage/20 px-4 py-2 text-sm font-semibold text-sage disabled:opacity-50"
          onClick={() => {
            startTransition(async () => {
              const ticketsRes = await listTickets()
              if (!ticketsRes.success) {
                setMessage(ticketsRes.error)
                return
              }
              const training = ticketsRes.data.find(
                (t) => t.agentId === agentId && t.type === 'training' && t.state === 'awaiting_human',
              )
              if (!training) {
                setMessage('Nincs awaiting_human training ticket')
                return
              }
              const res = await approveTraining({ ticketId: training.id })
              setMessage(res.success ? 'Memória frissítve' : res.error)
              if (res.success) router.refresh()
            })
          }}
        >
          Jóváhagyás (approver)
        </button>
        <input
          type="number"
          min={1}
          value={rollbackTo}
          onChange={(e) => setRollbackTo(Number(e.target.value))}
          className="w-20 rounded-lg border border-line bg-night-2 px-2 py-2 text-sm"
        />
        <button
          type="button"
          disabled={pending}
          className="rounded-full bg-honey/20 px-4 py-2 text-sm font-semibold text-honey disabled:opacity-50"
          onClick={() => {
            startTransition(async () => {
              const res = await rollbackMemory({ agentId, toVersion: rollbackTo })
              setMessage(res.success ? `Rollback v${rollbackTo}` : res.error)
              if (res.success) router.refresh()
            })
          }}
        >
          Rollback
        </button>
      </div>
      {message && <p className="mt-3 text-sm text-ink-soft">{message}</p>}
    </Card>
  )
}
