import { notFound } from 'next/navigation'
import { getTicket, getTicketTransitions, listTicketComments } from '@/app/actions/platform'
import { listProcessDefinitions } from '@/app/actions/process'
import { getAuthContext } from '@/auth/context'
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
import { TicketActivityHistory } from '@/components/tickets/ticket-activity-history'

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ ticketId: string }>
}) {
  const { ticketId } = await params
  const [commentsRes, ctx, definitionsRes, transitionsRes] = await Promise.all([
    listTicketComments({ ticketId }),
    getAuthContext(),
    listProcessDefinitions({ status: 'active' }),
    getTicketTransitions({ id: ticketId }),
  ])
  // Fetched last so its state can never be older than the history above.
  const res = await getTicket({ id: ticketId })
  if (!res.success) notFound()

  const ticket = res.data
  const transitions = transitionsRes.success ? transitionsRes.data : []
  const isAdmin = hasMinimumRole(ctx?.activeTenantRole, 'admin')
  const canManageRunAs = hasMinimumRole(ctx?.activeTenantRole, 'operator')
  const canStartProcess = hasMinimumRole(ctx?.activeTenantRole, 'operator')
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
      <TicketMeta ticket={ticket} isAdmin={isAdmin} canDispatch={canManageRunAs} />
      <TicketThread ticket={ticket} comments={commentsRes.success ? commentsRes.data : []} />
      <TicketRunAsAuthorization ticket={ticket} canManageRunAs={canManageRunAs} />
      {canStartProcess && <TicketProcessStartPanel ticket={ticket} definitions={definitions} />}
      <TicketFilesPanel ticketId={ticket.id} ticketState={ticket.state} />
      <TicketActions ticket={ticket} />
      <TicketActivityHistory
        ticket={{
          state: ticket.state,
          payload: ticket.payload,
          cancelRequested: ticket.cancelRequested,
          lockedAt: ticket.lockedAt,
        }}
      />
      <TicketHistory transitions={transitions} />
    </div>
  )
}
