import { AgentWorkspaceBoard } from '@/components/agents/agent-workspace-board'
import { AgentWorkspaceTraining } from '@/components/agents/agent-workspace-training'
import {
  isAgentWorkspaceRouteTab,
  isAgentWorkspaceTab,
  type AgentWorkspaceRouteTab,
} from '@/lib/agent-workspace-routes'
import { notFound } from 'next/navigation'
import AgentDetailPage from '../../page'

export default async function AgentWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ agentId: string; tab: string }>
  searchParams: Promise<{
    from?: string
    to?: string
    view?: string
    scheduled?: string
    section?: string
  }>
}) {
  const { agentId, tab } = await params
  if (!isAgentWorkspaceTab(tab)) notFound()
  const query = await searchParams

  if (!isAgentWorkspaceRouteTab(tab)) return null
  const renderers: Record<AgentWorkspaceRouteTab, () => React.ReactNode> = {
    board: () => <AgentWorkspaceBoard agentId={agentId} searchParams={query} />,
    training: () => <AgentWorkspaceTraining agentId={agentId} />,
    profile: () => (
      <AgentDetailPage
        params={Promise.resolve({ agentId })}
        searchParams={Promise.resolve({ section: query.section })}
        embedded
      />
    ),
  }
  return renderers[tab]()
}
