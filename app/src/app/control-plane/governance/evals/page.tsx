import Link from 'next/link'
import { listAgents, listEvalsForAgent } from '@/app/actions/platform'
import { EvalWorkspace } from '@/components/evals/eval-workspace'

type SearchParams = Promise<{ agentId?: string }>

type GoldenAssertion = {
  description: string
  type: 'contains' | 'not_contains' | 'min_length'
  value: string | number
}

function asGoldenSet(value: unknown): GoldenAssertion[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is GoldenAssertion => {
    if (!item || typeof item !== 'object') return false
    const assertion = item as { description?: unknown; type?: unknown; value?: unknown }
    return (
      typeof assertion.description === 'string' &&
      (assertion.type === 'contains' ||
        assertion.type === 'not_contains' ||
        assertion.type === 'min_length') &&
      (typeof assertion.value === 'string' || typeof assertion.value === 'number')
    )
  })
}

export default async function GovernanceEvalsPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const { agentId: queryAgentId } = await searchParams
  const agentsRes = await listAgents()
  const agents = agentsRes.success ? agentsRes.data : []
  const selectedAgentId =
    queryAgentId && agents.some((agent) => agent.id === queryAgentId)
      ? queryAgentId
      : agents[0]?.id

  const evalsRes = selectedAgentId
    ? await listEvalsForAgent({ agentId: selectedAgentId })
    : ({ success: true, data: [] } as const)

  const evals = evalsRes.success
    ? evalsRes.data.map((evalDef) => {
        const lastRun = evalDef.runs[0]
        return {
          id: evalDef.id,
          name: evalDef.name,
          status: evalDef.status,
          goldenSet: asGoldenSet(evalDef.goldenSet),
          lastRun: lastRun
            ? {
                id: lastRun.id,
                passed: lastRun.passed,
                score: lastRun.score,
                trigger: lastRun.trigger,
                createdAt: lastRun.createdAt.toISOString(),
                details: lastRun.details,
              }
            : null,
        }
      })
    : []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Eval ellenőrzések</h1>
          <p className="mt-1 text-ink-soft">
            Golden set alapú kézi ellenőrzés a tanítási és S6 minőségi kapukhoz.
          </p>
        </div>
        <Link
          href="/control-plane/governance"
          className="rounded-full border border-line bg-card px-4 py-2 text-sm font-semibold text-ink-soft transition-colors hover:border-coral/45 hover:text-coral-deep"
        >
          Governance
        </Link>
      </div>

      {agents.length === 0 ? (
        <p className="text-sm text-ink-faint">Nincs agent. Előbb hozz létre egyet az Agent Registry-ben.</p>
      ) : (
        <EvalWorkspace
          agents={agents.map((agent) => ({ id: agent.id, name: agent.name }))}
          evals={evals}
          selectedAgentId={selectedAgentId}
        />
      )}

      {!evalsRes.success && (
        <p className="text-sm text-coral-deep">Eval lista betöltése sikertelen: {evalsRes.error}</p>
      )}
    </div>
  )
}
