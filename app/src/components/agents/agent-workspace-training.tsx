import { getAgent, getTrainingWorkspace } from '@/app/actions/platform'
import { TrainingWorkspace } from '@/components/agents/training-workspace'

export async function AgentWorkspaceTraining({ agentId }: { agentId: string }) {
  const [agentRes, workspaceRes] = await Promise.all([
    getAgent({ id: agentId }),
    getTrainingWorkspace({ agentId }),
  ])

  if (!agentRes.success) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-coral-deep">{agentRes.error}</p>
      </div>
    )
  }

  if (!workspaceRes.success) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-coral-deep">{workspaceRes.error}</p>
      </div>
    )
  }

  const workspace = workspaceRes.data
  const versionLabel = workspace?.activeVersion?.version ?? agentRes.data.memoryVersion ?? 1

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-4xl">
        <p className="mb-5 text-sm text-ink-soft">
          Betanított működési szabályok — aktuális v{versionLabel}
          {workspace?.pendingProposal
            ? ` · ${workspace.pendingProposal.nextStep ?? 'van függő javaslat'}`
            : ''}
        </p>
        <TrainingWorkspace
          agents={[agentRes.data.agent]}
          selectedAgentId={agentId}
          workspace={workspace}
          lockAgent
        />
      </div>
    </div>
  )
}
