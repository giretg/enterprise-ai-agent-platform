import { notFound } from 'next/navigation'
import { getTicket, listTicketComments } from '@/app/actions/platform'
import { listProcessDefinitions } from '@/app/actions/process'
import { getCurrentUser } from '@/auth'
import { hasMinimumRole } from '@/auth/types'
import {
  TicketActions,
  TicketMeta,
  TicketProcessStartPanel,
  TicketRunAsAuthorization,
  type TicketStartableProcessDefinition,
} from '@/components/tickets/ticket-detail'
import { TicketThread } from '@/components/tickets/ticket-thread'
import { TicketFilesPanel } from '@/components/tickets/ticket-files-panel'
import { TicketHistory } from '@/components/tickets/ticket-history'

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ ticketId: string }>
}) {
  const { ticketId } = await params
  const [res, commentsRes, user, definitionsRes] = await Promise.all([
    getTicket({ id: ticketId }),
    listTicketComments({ ticketId }),
    getCurrentUser(),
    listProcessDefinitions({ status: 'active' }),
  ])
  if (!res.success) notFound()

  const ticket = res.data
  const isAdmin = user ? hasMinimumRole(user.role, 'admin') : false
  const canManageRunAs = user ? hasMinimumRole(user.role, 'operator') : false
  const canStartProcess = user ? hasMinimumRole(user.role, 'operator') : false
  const definitions: TicketStartableProcessDefinition[] =
    canStartProcess && definitionsRes.success
      ? definitionsRes.data
          .map((definition) => ({
            id: definition.id,
            name: definition.name,
            description: definition.description,
            triggers: definition.triggers
              .filter((trigger) => trigger.type === 'ticket' && trigger.enabled)
              .map((trigger) => ({
                id: trigger.id,
                type: trigger.type,
                enabled: trigger.enabled,
                inputMap: trigger.inputMap,
              })),
          }))
          .filter((definition) => definition.triggers.length > 0)
      : []

  return (
    <div className="space-y-6">
      <TicketMeta ticket={ticket} isAdmin={isAdmin} />
      <TicketThread ticket={ticket} comments={commentsRes.success ? commentsRes.data : []} />
      <TicketRunAsAuthorization ticket={ticket} canManageRunAs={canManageRunAs} />
      {canStartProcess && <TicketProcessStartPanel ticket={ticket} definitions={definitions} />}
      <TicketFilesPanel ticketId={ticket.id} ticketState={ticket.state} />
      <TicketActions ticket={ticket} />
      <TicketHistory ticketId={ticket.id} />
    </div>
  )
}
