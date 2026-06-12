import { notFound } from 'next/navigation'
import { getTicket } from '@/app/actions/platform'
import { TicketActions, TicketMeta } from '@/components/tickets/ticket-detail'

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ ticketId: string }>
}) {
  const { ticketId } = await params
  const res = await getTicket({ id: ticketId })
  if (!res.success) notFound()

  const ticket = res.data

  return (
    <div className="space-y-6">
      <TicketMeta ticket={ticket} />
      <TicketActions ticket={ticket} />
    </div>
  )
}
