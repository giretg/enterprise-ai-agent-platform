import { notFound } from 'next/navigation'
import { getAgent } from '@/app/actions/platform'
import { AgentSandboxWorkspace } from '@/components/sandbox/agent-sandbox-workspace'
import { sandboxKindForAgent } from '@/lib/agent-kind'

export default async function AgentSandboxPage({
  params,
}: {
  params: Promise<{ agentId: string }>
}) {
  const { agentId } = await params
  const res = await getAgent({ id: agentId })
  if (!res.success) notFound()

  const { agent } = res.data
  const kind = sandboxKindForAgent(agent)

  return (
    <AgentSandboxWorkspace
      kind={kind}
      agent={{
        id: agent.id,
        name: agent.name,
        roleDescription: agent.roleDescription,
      }}
    />
  )
}
