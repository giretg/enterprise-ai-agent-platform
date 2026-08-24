import { getAgent, listTickets, listTrainingMemoryVersions } from '@/app/actions/platform'
import { TrainingWorkspace } from '@/components/agents/training-workspace'

export async function AgentWorkspaceTraining({ agentId }: { agentId: string }) {
  const [agentRes, ticketsRes, versionsRes] = await Promise.all([
    getAgent({ id: agentId }),
    listTickets(),
    listTrainingMemoryVersions({ agentId, limit: 20 }),
  ])

  if (!agentRes.success) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-coral-deep">{agentRes.error}</p>
      </div>
    )
  }

  const trainingTickets = (ticketsRes.success ? ticketsRes.data : []).filter(
    (ticket) =>
      ticket.type === 'training' &&
      ticket.state === 'awaiting_human' &&
      ticket.agentId === agentId,
  )

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-4xl">
        <p className="mb-5 text-sm text-ink-soft">
          Megtanult szabályok szerkesztése, hozzáadása, törlése és rollback — aktuális v
          {agentRes.data.memoryVersion ?? 1}
        </p>
        <TrainingWorkspace
          agents={[agentRes.data.agent]}
          trainingTickets={trainingTickets}
          selectedAgentId={agentId}
          memoryContent={agentRes.data.memoryContent}
          memoryVersions={versionsRes.success ? versionsRes.data.versions : []}
          currentVersionId={versionsRes.success ? versionsRes.data.currentVersionId : null}
          lockAgent
        />
      </div>
    </div>
  )
}
