'use client'

import { useMemo, useState } from 'react'
import type { Agent } from '@prisma/client'
import { AgentRegistryCard } from '@/components/agents/agent-registry-card'
import { Card } from '@/components/ui/shell'

export function AgentRegistryList({
  agents,
  canDelete,
}: {
  agents: Agent[]
  canDelete: boolean
}) {
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
          <AgentRegistryCard key={agent.id} agent={agent} canDelete={canDelete} />
        ))}
        {visibleAgents.length === 0 && (
          <Card className="md:col-span-2">
            <p className="text-sm text-ink-faint">
              {agents.length === 0 ? (
                <>
                  Még nincs munkatárs a csapatban — futtasd:{' '}
                  <code className="rounded bg-night-2 px-1.5 py-0.5 font-mono text-xs">
                    npm run db:seed
                  </code>
                </>
              ) : (
                'Nincs megjeleníthető aktív munkatárs. Nyugdíjazottak megjelenítéséhez használd a fenti gombot.'
              )}
            </p>
          </Card>
        )}
      </div>
    </div>
  )
}
