import { redirect } from 'next/navigation'

export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ proposalId: string }>
}) {
  const { proposalId } = await params
  redirect(`/control-plane/tickets/${proposalId}`)
}
