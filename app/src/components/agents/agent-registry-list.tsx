'use client'

import { useMemo, useState } from 'react'
import type { Agent } from '@prisma/client'
import type { AssigneeOptions } from '@/components/agents/agent-card-actions'
import { AgentRegistryCard } from '@/components/agents/agent-registry-card'
import { Card } from '@/components/ui/shell'

export function AgentRegistryList({
  agents,
  canDelete,
  loadError,
  workingAgentIds = [],
  canCreateTicket = false,
  assigneeOptions,
}: {
  agents: Agent[]
  canDelete: boolean
  /** Ha a lista lekérése elbukott — ne „üres csapat / seed” üzenetet mutassunk. */
  loadError?: string | null
  /** Agent-id-k, akiknek van aktívan futó ügyük — dashboarddal azonos forrás. */
  workingAgentIds?: readonly string[]
  canCreateTicket?: boolean
  assigneeOptions?: AssigneeOptions
}) {
  const workingIds = new Set(workingAgentIds)
  const [showRetired, setShowRetired] = useState(false)

  const retiredCount = useMemo(
    () => agents.filter((agent) => agent.status === 'retired').length,
    [agents],
  )

  const visibleAgents = useMemo(
    () => (showRetired ? agents : agents.filter((agent) => agent.status !== 'retired')),
    [agents, showRetired],
  )

  return (
    <div className="space-y-4">
      {loadError && (
        <Card className="border-coral/40 bg-coral/5">
          <p className="text-sm font-medium text-coral-deep">A munkatársak betöltése sikertelen</p>
          <p className="mt-1 text-sm text-ink-soft">{loadError}</p>
        </Card>
      )}

      {retiredCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-faint">
            {showRetired
              ? `${retiredCount} nyugdíjazott munkatárs is látható.`
              : `${retiredCount} nyugdíjazott munkatárs el van rejtve.`}
          </p>
          <button
            type="button"
            onClick={() => setShowRetired((current) => !current)}
            className="rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition-colors hover:border-ink-faint hover:text-ink"
          >
            {showRetired ? 'Nyugdíjazottak elrejtése' : 'Nyugdíjazottak megjelenítése'}
          </button>
        </div>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        {visibleAgents.map((agent) => (
          <AgentRegistryCard
            key={agent.id}
            agent={agent}
            canDelete={canDelete}
            isWorking={workingIds.has(agent.id)}
            canCreateTicket={canCreateTicket}
            assigneeOptions={assigneeOptions}
          />
        ))}
        {!loadError && visibleAgents.length === 0 && (
          <Card className="md:col-span-2">
            <p className="text-sm text-ink-faint">
              {agents.length === 0
                ? 'Még nincs munkatárs ebben a tenantban.'
                : 'Nincs megjeleníthető aktív munkatárs. Nyugdíjazottak megjelenítéséhez használd a fenti gombot.'}
            </p>
          </Card>
        )}
      </div>
    </div>
  )
}
