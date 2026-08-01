import { getAgent, listAgents, listTickets, listTrainingMemoryVersions } from '@/app/actions/platform'
import { TrainingWorkspace } from '@/components/agents/training-workspace'

export default async function TrainingPage({
  searchParams,
}: {
  searchParams: Promise<{ agentId?: string }>
}) {
  const { agentId: queryAgentId } = await searchParams
  const [agentsRes, ticketsRes] = await Promise.all([listAgents(), listTickets()])
  const agents = agentsRes.success ? agentsRes.data : []
  const allTickets = ticketsRes.success ? ticketsRes.data : []

  const selectedAgentId =
    queryAgentId && agents.some((a) => a.id === queryAgentId) ? queryAgentId : agents[0]?.id

  const trainingTickets = allTickets.filter(
    (t) =>
      t.type === 'training' &&
      t.state === 'awaiting_human' &&
      (!selectedAgentId || t.agentId === selectedAgentId),
  )

  let currentVersion = 1
  let memoryContent: string | null = null
  let memoryVersions: {
    id: string
    version: number
    content: string | null
    status: string
    createdAt: string | Date
    source: string | null
  }[] = []
  let currentVersionId: string | null = null

  if (selectedAgentId) {
    const [agentRes, versionsRes] = await Promise.all([
      getAgent({ id: selectedAgentId }),
      listTrainingMemoryVersions({ agentId: selectedAgentId, limit: 20 }),
    ])
    if (agentRes.success) {
      currentVersion = agentRes.data.memoryVersion ?? 1
      memoryContent = agentRes.data.memoryContent
    }
    if (versionsRes.success) {
      currentVersionId = versionsRes.data.currentVersionId
      memoryVersions = versionsRes.data.versions
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-semibold">Tanítás</h1>
        <p className="mt-1 text-ink-soft">
          Megtanult szabályok szerkesztése, hozzáadása, törlése és rollback — aktuális v
          {currentVersion}
        </p>
      </div>

      {agents.length === 0 ? (
        <p className="text-sm text-ink-faint">Nincs agent. Hozz létre egyet az Agent Registry-ben.</p>
      ) : (
        <TrainingWorkspace
          agents={agents}
          trainingTickets={trainingTickets}
          selectedAgentId={selectedAgentId}
          memoryContent={memoryContent}
          memoryVersions={memoryVersions}
          currentVersionId={currentVersionId}
        />
      )}
    </div>
  )
}
