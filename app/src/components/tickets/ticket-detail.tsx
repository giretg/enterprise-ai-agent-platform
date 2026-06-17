'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { transitionTicket } from '@/app/actions/platform'
import { ProposalCard } from '@/components/tickets/proposal-card'
import { Badge, Card } from '@/components/ui/shell'
import { TICKET_STATE_LABELS, TICKET_STATE_TONE } from '@/lib/ticket-labels'
import { extractTaskDescription, formatTicketDateTime } from '@/lib/ticket-display'

function extractTaskDescriptionFromPayload(payload: Record<string, unknown> | null): string | null {
  return extractTaskDescription(payload)
}

type TicketView = {
  id: string
  title: string
  type: string
  state: string
  payload: unknown
  sourceDocumentId: string | null
  createdAt: string | Date
  updatedAt: string | Date
  assigneeType?: string | null
  assigneeId?: string | null
  agentId?: string | null
  taskDescription?: string | null
  assignee?: {
    type: string | null
    label: string
    detail: string | null
  }
  creator?: {
    id: string
    label: string
  }
  reproduction?: {
    agentVersion: number
    memoryVersion: number | null
    model: unknown
    recipe: { name: string; version: number; status: string } | null
  } | null
}

const REJECTABLE_STATES = new Set(['ready', 'in_progress', 'awaiting_human', 'done'])

function hasWikiAnswer(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'answer' in payload &&
    typeof (payload as { answer?: unknown }).answer === 'string'
  )
}

export function TicketActions({ ticket }: { ticket: TicketView }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const isTrainingTicket = ticket.type === 'training'
  const canApprove = ticket.state === 'awaiting_human'
  const canReject = REJECTABLE_STATES.has(ticket.state)
  const canRerun = ticket.state === 'rejected'
  const hasActions = canApprove || canReject || canRerun
  const isWikiFollowUp = hasWikiAnswer(ticket.payload)

  const act = (toState: string) => {
    if (toState === 'rejected' && isWikiFollowUp && !note.trim()) {
      setError('Pontosító kérdés vagy indoklás megadása kötelező a visszadobáshoz.')
      return
    }

    setError(null)
    startTransition(async () => {
      const res = await transitionTicket({ id: ticket.id, toState, note: note || undefined })
      if (!res.success) {
        setError(res.error)
        return
      }
      setNote('')
      router.refresh()
    })
  }

  if (!hasActions) {
    return (
      <Card title="Műveletek">
        <p className="text-sm text-ink-soft">
          Jelenleg nincs elvégezhető művelet ezen az állapoton ({TICKET_STATE_LABELS[ticket.state] ?? ticket.state}
          ).
        </p>
      </Card>
    )
  }

  return (
    <Card title="Műveletek">
      {error && <p className="mb-3 text-sm text-coral">{error}</p>}
      <textarea
        className="mb-3 w-full rounded-lg border border-line bg-night-2 p-3 text-sm text-ink"
        placeholder={
          isWikiFollowUp && canReject
            ? 'Pontosító kérdés vagy indoklás (visszadobáshoz kötelező)'
            : 'Indoklás vagy pontosító kérdés (opcionális)'
        }
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
      />
      <div className="flex flex-wrap gap-2">
        {canApprove && (
          <button
            type="button"
            disabled={pending}
            onClick={() => act('approved')}
            className="rounded-full bg-sage/20 px-4 py-2 text-sm font-semibold text-sage hover:bg-sage/30 disabled:opacity-50"
          >
            {isTrainingTicket ? 'Tanítás jóváhagyása (write-gate)' : 'Jóváhagyás'}
          </button>
        )}
        {canReject && (
          <button
            type="button"
            disabled={pending}
            onClick={() => act('rejected')}
            className="rounded-full bg-coral/20 px-4 py-2 text-sm font-semibold text-coral hover:bg-coral/30 disabled:opacity-50"
          >
            Visszadobás
          </button>
        )}
        {canRerun && (
          <button
            type="button"
            disabled={pending}
            onClick={() => act('ready')}
            className="rounded-full bg-honey/20 px-4 py-2 text-sm font-semibold text-honey disabled:opacity-50"
          >
            Újra feldolgozás
          </button>
        )}
      </div>
      <p className="mt-3 text-xs text-ink-faint">
        {canApprove &&
          isTrainingTicket &&
          'Tanítási ticket: a jóváhagyás write-gate-en keresztül frissíti az agent memóriáját, majd done állapotba zár. '}
        {canApprove &&
          !isTrainingTicket &&
          'Jóváhagyás után a szerver automatikusan: approved → done. '}
        {canReject &&
          'Visszadobás után az «Újra feldolgozás» gombbal indíthatod újra az agentet — a pontosító kérdés bekerül a kontextusba. '}
        {canRerun && 'Újra feldolgozás után a ticket ready állapotba kerül, és a dispatcher újraindítja az agentet.'}
      </p>
    </Card>
  )
}

export function TicketMeta({ ticket, isAdmin = false }: { ticket: TicketView; isAdmin?: boolean }) {
  const payload = ticket.payload as Record<string, unknown> | null
  const proposal = payload?.proposal as Record<string, unknown> | undefined
  const diff = payload?.diff as Record<string, unknown> | undefined
  const answer = typeof payload?.answer === 'string' ? payload.answer : null
  const rationale = typeof payload?.rationale === 'string' ? payload.rationale : null
  const confidence = typeof payload?.confidence === 'string' ? payload.confidence : null
  const sources = Array.isArray(payload?.sources) ? payload.sources : []
  const followUpNotes = Array.isArray(payload?.followUpNotes)
    ? payload.followUpNotes.filter((note): note is string => typeof note === 'string' && note.trim().length > 0)
    : []
  const transitionNote = typeof payload?.transitionNote === 'string' ? payload.transitionNote : null
  const assignee = ticket.assignee
  const taskDescription = ticket.taskDescription ?? extractTaskDescriptionFromPayload(payload)

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-2xl font-semibold">{ticket.title}</h1>
        <Badge tone={TICKET_STATE_TONE[ticket.state] ?? 'neutral'}>
          {TICKET_STATE_LABELS[ticket.state] ?? ticket.state}
        </Badge>
        <Badge tone="neutral">{ticket.type === 'training' ? 'Tanítás' : 'Interakció'}</Badge>
      </div>

      <Card title="Metaadatok" className="mt-4">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {ticket.creator && (
            <>
              <dt className="text-ink-faint">Létrehozta</dt>
              <dd className="text-ink">{ticket.creator.label}</dd>
            </>
          )}
          <dt className="text-ink-faint">Létrehozva</dt>
          <dd className="text-ink">{formatTicketDateTime(ticket.createdAt)}</dd>
          <dt className="text-ink-faint">Utolsó módosítás</dt>
          <dd className="text-ink">{formatTicketDateTime(ticket.updatedAt)}</dd>
        </dl>
      </Card>

      <Card title="Hozzárendelve" className="mt-6">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-lg font-semibold text-ink">
            {assignee?.label ?? 'Nincs hozzárendelve'}
          </span>
          {assignee?.type === 'agent' && <Badge tone="neutral">AI agent</Badge>}
          {assignee?.type === 'human' && <Badge tone="warning">Ember</Badge>}
        </div>
        {assignee?.detail && (
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">{assignee.detail}</p>
        )}
      </Card>

      {taskDescription && (
        <Card title="Feladat" className="mt-6">
          <p className="text-base leading-relaxed text-ink whitespace-pre-wrap">{taskDescription}</p>
        </Card>
      )}

      {proposal && <ProposalCard proposal={proposal} className="mt-6" />}

      {followUpNotes.length > 0 && (
        <Card title="Pontosító kérések" className="mt-6">
          <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-ink-soft">
            {followUpNotes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ol>
          {transitionNote && transitionNote !== followUpNotes.at(-1) && (
            <p className="mt-3 text-xs text-ink-faint">Legutóbbi indoklás: {transitionNote}</p>
          )}
        </Card>
      )}

      {answer && (
        <Card title="Wiki-válasz" className="mt-6">
          <p className="text-base leading-relaxed text-ink">{answer}</p>
          {rationale && <p className="mt-4 text-sm leading-relaxed text-ink-soft">{rationale}</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            {confidence && <Badge tone={confidence === 'high' ? 'success' : 'warning'}>{confidence}</Badge>}
            {sources.map((source, index) => (
              <Badge key={index} tone="neutral">
                {typeof source === 'object' && source !== null
                  ? `${'docId' in source ? String(source.docId) : 'source'} · ${
                      'sectionRef' in source ? String(source.sectionRef) : index + 1
                    }`
                  : String(source)}
              </Badge>
            ))}
          </div>
        </Card>
      )}

      {diff && (
        <Card title="Tanítási diff" className="mt-6">
          <pre className="overflow-x-auto text-xs text-ink-soft">{JSON.stringify(diff, null, 2)}</pre>
        </Card>
      )}

      {(payload?.agentVersion != null ||
        payload?.memoryVersion != null ||
        payload?.model != null ||
        payload?.recipeName != null ||
        payload?.recipeVersion != null ||
        ticket.reproduction?.recipe) && (
        <Card title="Agent anatómia (reprodukálhatóság)" className="mt-6">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            {(payload?.agentVersion != null || ticket.reproduction?.agentVersion != null) && (
              <>
                <dt className="text-ink-faint">Agent verzió</dt>
                <dd className="col-span-1 font-mono text-ink sm:col-span-2">
                  v{String(payload?.agentVersion ?? ticket.reproduction?.agentVersion)}
                </dd>
              </>
            )}
            {(payload?.memoryVersion != null || ticket.reproduction?.memoryVersion != null) && (
              <>
                <dt className="text-ink-faint">Memória verzió</dt>
                <dd className="col-span-1 font-mono text-ink sm:col-span-2">
                  v{String(payload?.memoryVersion ?? ticket.reproduction?.memoryVersion)}
                </dd>
              </>
            )}
            {(payload?.recipeName != null || ticket.reproduction?.recipe?.name) && (
              <>
                <dt className="text-ink-faint">Recipe</dt>
                <dd className="col-span-1 font-mono text-ink sm:col-span-2">
                  {String(payload?.recipeName ?? ticket.reproduction?.recipe?.name)} v
                  {String(payload?.recipeVersion ?? ticket.reproduction?.recipe?.version)}
                </dd>
              </>
            )}
            {payload?.model != null && (
              <>
                <dt className="text-ink-faint">Modell</dt>
                <dd className="col-span-1 font-mono text-ink sm:col-span-2">
                  {String(payload.model as string)}
                </dd>
              </>
            )}
          </dl>
        </Card>
      )}

      {isAdmin && (
        <Card title="Payload (debug)" className="mt-6">
          <details>
            <summary className="cursor-pointer text-xs text-ink-faint">Raw JSON megjelenítése</summary>
            <pre className="mt-3 overflow-x-auto text-xs text-ink-soft">{JSON.stringify(payload, null, 2)}</pre>
          </details>
        </Card>
      )}
    </>
  )
}
