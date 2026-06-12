import { getAgent, listAgents, listTickets } from '@/app/actions/platform'
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
    (t) => t.type === 'training' && (!selectedAgentId || t.agentId === selectedAgentId),
  )

  let currentVersion = 1
  if (selectedAgentId) {
    const agentRes = await getAgent({ id: selectedAgentId })
    if (agentRes.success) {
      currentVersion = agentRes.data.memoryVersion ?? 1
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-semibold">Tanítás</h1>
        <p className="mt-1 text-ink-soft">
          Memória-verziózás, diff-nézet, jóváhagyás és rollback — aktuális v{currentVersion}
        </p>
      </div>

      {agents.length === 0 ? (
        <p className="text-sm text-ink-faint">Nincs agent. Hozz létre egyet az Agent Registry-ben.</p>
      ) : (
        <TrainingWorkspace
          agents={agents}
          trainingTickets={trainingTickets}
          selectedAgentId={selectedAgentId}
        />
      )}
    </div>
  )
}
