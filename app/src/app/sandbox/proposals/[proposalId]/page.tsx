import { notFound } from 'next/navigation'
import { getSandboxReportForTicket, getTicket } from '@/app/actions/platform'
import { WikiProposalDetail } from '@/components/tickets/wiki-proposal-detail'

export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ proposalId: string }>
}) {
  const { proposalId } = await params
  const res = await getTicket({ id: proposalId })
  if (!res.success) notFound()

  const ticket = res.data
  const payload =
    typeof ticket.payload === 'object' && ticket.payload !== null && !Array.isArray(ticket.payload)
      ? (ticket.payload as Record<string, unknown>)
      : {}

  const answer = typeof payload.answer === 'string' ? payload.answer : null
  const sandboxReportRes = answer ? await getSandboxReportForTicket({ ticketId: ticket.id }) : null
  const sandboxReport = sandboxReportRes?.success ? sandboxReportRes.data : null

  return (
    <WikiProposalDetail
      ticketId={ticket.id}
      initialState={ticket.state}
      initialPayload={payload}
      initialSandboxReport={sandboxReport}
    />
  )
}
