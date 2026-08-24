import { AgentWorkspace } from '@/components/agents/agent-workspace'
import { AgentWorkspaceBoard } from '@/components/agents/agent-workspace-board'
import { AGENT_WORKSPACE_TABS } from '@/lib/agent-workspace-routes'
import type { AgentWorkspaceTab } from '@/lib/agent-rail-types'
import { notFound } from 'next/navigation'

export default async function AgentWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ agentId: string; tab: string }>
  searchParams: Promise<{ from?: string; to?: string; view?: string; scheduled?: string }>
}) {
  const { agentId, tab } = await params
  if (!AGENT_WORKSPACE_TABS.includes(tab as AgentWorkspaceTab)) notFound()
  const board =
    tab === 'board' ? (
      <AgentWorkspaceBoard agentId={agentId} searchParams={await searchParams} />
    ) : null
  return <AgentWorkspace board={board} />
}
