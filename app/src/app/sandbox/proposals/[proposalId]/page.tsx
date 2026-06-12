import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTicket } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'

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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="font-display text-2xl font-semibold">Javaslat részlet</h1>
        <Badge>{ticket.state}</Badge>
      </div>

      {proposal ? (
        <Card title="Kinyert mezők + javaslat">
          <dl className="grid gap-4 sm:grid-cols-2">
            {Object.entries(proposal).map(([key, value]) => (
              <div key={key}>
                <dt className="text-xs uppercase tracking-wide text-ink-faint">{key}</dt>
                <dd className="mt-1 font-medium">{String(value)}</dd>
              </div>
            ))}
          </dl>
        </Card>
      ) : (
        <Card>
          <p className="text-ink-soft">Nincs proposal payload</p>
        </Card>
      )}

      <Link
        href={`/control-plane/tickets/${ticket.id}`}
        className="inline-block rounded-full bg-coral/20 px-5 py-2.5 text-sm font-semibold text-coral"
      >
        Küldés jóváhagyásra (Control Plane)
      </Link>
    </div>
  )
}
