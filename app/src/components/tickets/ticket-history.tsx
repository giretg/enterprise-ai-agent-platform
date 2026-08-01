'use client'

import { Badge, Card } from '@/components/ui/shell'
import { TICKET_STATE_LABELS, TICKET_STATE_TONE } from '@/lib/ticket-labels'
import { formatTicketDateTime } from '@/lib/ticket-display'

const ACTOR_LABELS: Record<string, string> = {
  human: 'Ember',
  agent: 'AI munkatárs',
  system: 'Rendszer',
}

function stateLabel(state: string): string {
  return TICKET_STATE_LABELS[state] ?? state
}

export type TicketTransitionEntry = {
  id: string
  fromState: string
  toState: string
  ts: string | Date
  actorType: string
  agentVersion: number | null
  note: string | null
}

export function TicketHistory({ transitions }: { transitions: TicketTransitionEntry[] }) {
  if (transitions.length === 0) return null

  return (
    <Card title="Állapot-előzmények">
      <ol className="space-y-4">
        {transitions.map((transition) => (
          <li key={transition.id} className="border-b border-line pb-4 last:border-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={TICKET_STATE_TONE[transition.fromState] ?? 'neutral'}>
                {stateLabel(transition.fromState)}
              </Badge>
              <span className="text-ink-faint">→</span>
              <Badge tone={TICKET_STATE_TONE[transition.toState] ?? 'neutral'}>
                {stateLabel(transition.toState)}
              </Badge>
            </div>
            <p className="mt-1.5 text-xs text-ink-soft">
              <time dateTime={new Date(transition.ts).toISOString()}>
                {formatTicketDateTime(transition.ts)}
              </time>
              {' · '}
              {ACTOR_LABELS[transition.actorType] ?? transition.actorType}
              {transition.agentVersion != null ? ` · v${transition.agentVersion}` : ''}
            </p>
            {transition.note && (
              <p className="mt-1 text-xs italic text-ink-soft">„{transition.note}”</p>
            )}
          </li>
        ))}
      </ol>
    </Card>
  )
}
