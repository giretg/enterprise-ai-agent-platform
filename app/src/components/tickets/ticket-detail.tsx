'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { transitionTicket } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'

type TicketView = {
  id: string
  title: string
  type: string
  state: string
  payload: unknown
  sourceDocumentId: string | null
}

export function TicketActions({ ticket }: { ticket: TicketView }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const act = (toState: string) => {
    setError(null)
    startTransition(async () => {
      const res = await transitionTicket({ id: ticket.id, toState, note: note || undefined })
      if (!res.success) {
        setError(res.error)
        return
      }
      router.refresh()
    })
  }

  return (
    <Card title="Műveletek">
      {error && <p className="mb-3 text-sm text-coral">{error}</p>}
      <textarea
        className="mb-3 w-full rounded-lg border border-line bg-night-2 p-3 text-sm text-ink"
        placeholder="Indoklás (opcionális)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
      />
      <div className="flex flex-wrap gap-2">
        {ticket.state === 'awaiting_human' && (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => act('approved')}
              className="rounded-full bg-sage/20 px-4 py-2 text-sm font-semibold text-sage hover:bg-sage/30 disabled:opacity-50"
            >
              Jóváhagyás
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => act('rejected')}
              className="rounded-full bg-coral/20 px-4 py-2 text-sm font-semibold text-coral hover:bg-coral/30 disabled:opacity-50"
            >
              Visszadobás
            </button>
          </>
        )}
        {ticket.state === 'rejected' && (
          <button
            type="button"
            disabled={pending}
            onClick={() => act('in_review')}
            className="rounded-full bg-honey/20 px-4 py-2 text-sm font-semibold text-honey disabled:opacity-50"
          >
            Újra review
          </button>
        )}
      </div>
      <p className="mt-3 text-xs text-ink-faint">
        Jóváhagyás után a szerver automatikusan: approved → in_progress → done
      </p>
    </Card>
  )
}

export function TicketMeta({ ticket }: { ticket: TicketView }) {
  const payload = ticket.payload as Record<string, unknown> | null
  const proposal = payload?.proposal as Record<string, unknown> | undefined
  const diff = payload?.diff as Record<string, unknown> | undefined

  return (
    <>
      <div className="flex items-center gap-3">
        <h1 className="font-display text-2xl font-semibold">{ticket.title}</h1>
        <Badge>{ticket.state}</Badge>
        <Badge tone="neutral">{ticket.type}</Badge>
      </div>

      {proposal && (
        <Card title="Könyvelési javaslat" className="mt-6">
          <dl className="grid gap-3 sm:grid-cols-2 text-sm">
            {Object.entries(proposal).map(([key, value]) => (
              <div key={key}>
                <dt className="text-ink-faint">{key}</dt>
                <dd className="font-medium">{String(value)}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      {diff && (
        <Card title="Tanítási diff" className="mt-6">
          <pre className="overflow-x-auto text-xs text-ink-soft">{JSON.stringify(diff, null, 2)}</pre>
        </Card>
      )}

      <Card title="Payload (raw)" className="mt-6">
        <pre className="overflow-x-auto text-xs text-ink-soft">{JSON.stringify(payload, null, 2)}</pre>
      </Card>
    </>
  )
}
