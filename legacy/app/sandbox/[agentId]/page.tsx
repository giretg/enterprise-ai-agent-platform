import { redirect } from 'next/navigation'

export default async function AgentSandboxPage({
  params,
}: {
  params: Promise<{ agentId: string }>
}) {
  const { agentId } = await params
  redirect(`/control-plane/apps?agentId=${agentId}`)
}
