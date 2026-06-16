import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTicket } from '@/app/actions/platform'
import { ProposalCard } from '@/components/tickets/proposal-card'
import { Badge, Card } from '@/components/ui/shell'
import { TICKET_STATE_LABELS, TICKET_STATE_TONE } from '@/lib/ticket-labels'

export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ proposalId: string }>
}) {
  const { proposalId } = await params
  const res = await getTicket({ id: proposalId })
  if (!res.success) notFound()

  const ticket = res.data
  const payload = ticket.payload as Record<string, unknown>
  const proposal = payload.proposal as Record<string, unknown> | undefined
  const answer = typeof payload.answer === 'string' ? payload.answer : null
  const sources = Array.isArray(payload.sources) ? payload.sources : []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-2xl font-semibold">Javaslat részlet</h1>
        <Badge tone={TICKET_STATE_TONE[ticket.state] ?? 'neutral'}>
          {TICKET_STATE_LABELS[ticket.state] ?? ticket.state}
        </Badge>
      </div>

      {answer ? (
        <Card title="Wiki-válasz">
          <p className="text-base leading-relaxed text-ink">{answer}</p>
          {typeof payload.rationale === 'string' && (
            <p className="mt-4 text-sm leading-relaxed text-ink-soft">{payload.rationale}</p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
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
      ) : proposal ? (
        <ProposalCard proposal={proposal} title="Kinyert mezők + javaslat" />
      ) : (
        <p className="text-ink-soft">Nincs megjeleníthető válasz payload</p>
      )}

      {typeof payload.reasoning === 'string' && (
        <p className="text-sm leading-relaxed text-ink-soft">{payload.reasoning}</p>
      )}

      <Link
        href={`/control-plane/tickets/${ticket.id}`}
        className="inline-block rounded-full bg-coral/20 px-5 py-2.5 text-sm font-semibold text-coral hover:bg-coral/30"
      >
        Megnyitás a Control Plane-ben
      </Link>
    </div>
  )
}
