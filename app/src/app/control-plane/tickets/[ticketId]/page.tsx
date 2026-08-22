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
  TicketTechnicalPanels,
  type TicketStartableProcessDefinition,
} from '@/components/tickets/ticket-detail'
import { TicketThread } from '@/components/tickets/ticket-thread'
import { TicketConsequenceApprovals } from '@/components/tickets/ticket-consequence-approvals'
import { TicketConnectorGrants } from '@/components/tickets/ticket-connector-grants'
import { TicketFilesPanel } from '@/components/tickets/ticket-files-panel'
import { TicketHistory } from '@/components/tickets/ticket-history'
import { TicketActivityHistory } from '@/components/tickets/ticket-activity-history'
import { canDeleteBoardTicket } from '@/lib/ticket-display'
import { resolveRunAnalysisEntry } from '@/lib/run-analysis-entry'

export default async function TicketDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ ticketId: string }>
  searchParams: Promise<{ granted?: string }>
}) {
  const { ticketId } = await params
  const query = await searchParams
  const [commentsRes, ctx, definitionsRes, transitionsRes] = await Promise.all([
    listTicketComments({ ticketId }),
    getAuthContext(),
    listProcessDefinitions({ status: 'active' }),
    getTicketTransitions({ id: ticketId }),
  ])
  const runAnalysisEntry =
    ctx?.activeTenantId && ctx.activeTenantRole
      ? await resolveRunAnalysisEntry({
          tenantId: ctx.activeTenantId,
          role: ctx.activeTenantRole,
        })
      : { canRunAnalysis: false, runAnalystAgentId: null }
  // Fetched last so its state can never be older than the history above.
  const res = await getTicket({ id: ticketId })
  if (!res.success) notFound()

  const ticket = res.data
  const transitions = transitionsRes.success ? transitionsRes.data : []
  const isAdmin = hasMinimumRole(ctx?.activeTenantRole, 'admin')
  const canManageRunAs = hasMinimumRole(ctx?.activeTenantRole, 'operator')
  const canStartProcess = hasMinimumRole(ctx?.activeTenantRole, 'operator')
  const deleteInfo = canDeleteBoardTicket(ticket, {
    isAdmin,
    canManage: canManageRunAs,
    userId: ctx?.user.id,
  })
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
      <TicketMeta
        ticket={ticket}
        isAdmin={isAdmin}
        canDispatch={canManageRunAs}
        canDelete={deleteInfo.allowed}
        isAdminDelete={deleteInfo.isAdminDelete}
        canRunAnalysis={runAnalysisEntry.canRunAnalysis}
        runAnalystAgentId={runAnalysisEntry.runAnalystAgentId}
      />

      {/* Fő sáv: primer akció (jóváhagyás) → kontextus (szál) → aktivitás.
          Oldalsáv: kísérő adatok (fájlok, engedélyek, állapot-előzmények). */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="min-w-0 space-y-6">
          {/* Feltétel nélkül renderelve: a kártyák a futás KÖZBEN születnek, és a
              komponens maga tölti újra a listát — feltételes mountnál a nulláról
              induló lista sosem frissülne magától. */}
          <TicketConsequenceApprovals
            initial={ticket.pendingConsequenceApprovals ?? []}
            ticketId={ticket.id}
            ticketState={ticket.state}
          />
          <TicketConnectorGrants
            initial={ticket.pendingConnectorGrants ?? []}
            ticketId={ticket.id}
            ticketState={ticket.state}
            resumeAfterGrant={query.granted === '1'}
          />
          <TicketThread ticket={ticket} comments={commentsRes.success ? commentsRes.data : []} />
          <TicketActions ticket={ticket} />
          <TicketActivityHistory
            ticket={{
              id: ticket.id,
              state: ticket.state,
              payload: ticket.payload,
              cancelRequested: ticket.cancelRequested,
              lockedAt: ticket.lockedAt,
            }}
          />
        </div>

        <aside className="min-w-0 space-y-6">
          <TicketFilesPanel ticketId={ticket.id} ticketState={ticket.state} />
          <TicketRunAsAuthorization ticket={ticket} canManageRunAs={canManageRunAs} />
          {canStartProcess && <TicketProcessStartPanel ticket={ticket} definitions={definitions} />}
          <TicketHistory transitions={transitions} />
          <TicketTechnicalPanels ticket={ticket} isAdmin={isAdmin} />
        </aside>
      </div>
    </div>
  )
}
