import { notFound } from 'next/navigation'
import { getTicket } from '@/app/actions/platform'
import { getCurrentUser } from '@/auth'
import { hasMinimumRole } from '@/auth/types'
import { TicketActions, TicketMeta } from '@/components/tickets/ticket-detail'
import { TicketHistory } from '@/components/tickets/ticket-history'

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ ticketId: string }>
}) {
  const { ticketId } = await params
  const [res, user] = await Promise.all([getTicket({ id: ticketId }), getCurrentUser()])
  if (!res.success) notFound()

  const ticket = res.data
  const isAdmin = user ? hasMinimumRole(user.role, 'admin') : false

  return (
    <div className="space-y-6">
      <TicketMeta ticket={ticket} isAdmin={isAdmin} />
      <TicketActions ticket={ticket} />
      <TicketHistory ticketId={ticket.id} />
    </div>
  )
}
