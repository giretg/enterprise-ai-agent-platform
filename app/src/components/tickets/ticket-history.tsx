import { getTicketTransitions } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'
import { TICKET_STATE_LABELS, TICKET_STATE_TONE } from '@/lib/ticket-labels'

const ACTOR_LABELS: Record<string, string> = {
  human: 'Ember',
  agent: 'Agent',
  system: 'Rendszer',
}

function stateLabel(state: string): string {
  return TICKET_STATE_LABELS[state] ?? state
}

export async function TicketHistory({ ticketId }: { ticketId: string }) {
  const res = await getTicketTransitions({ id: ticketId })
  if (!res.success || res.data.length === 0) return null

  return (
    <Card title="Állapot-előzmények">
      <ol className="space-y-3">
        {res.data.map((transition) => (
          <li key={transition.id} className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={TICKET_STATE_TONE[transition.fromState] ?? 'neutral'}>
              {stateLabel(transition.fromState)}
            </Badge>
            <span className="text-ink-faint">→</span>
            <Badge tone={TICKET_STATE_TONE[transition.toState] ?? 'neutral'}>
              {stateLabel(transition.toState)}
            </Badge>
            <span className="text-ink-soft">
              {ACTOR_LABELS[transition.actorType] ?? transition.actorType}
              {transition.agentVersion != null ? ` · v${transition.agentVersion}` : ''}
            </span>
            <span className="ml-auto text-xs text-ink-faint">
              {new Date(transition.ts).toLocaleString('hu-HU')}
            </span>
            {transition.note && (
              <p className="w-full text-xs italic text-ink-soft">„{transition.note}”</p>
            )}
          </li>
        ))}
      </ol>
    </Card>
  )
}
