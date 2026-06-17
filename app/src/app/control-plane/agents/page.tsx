import Link from 'next/link'
import { listAgents } from '@/app/actions/platform'
import { getCurrentUser } from '@/auth'
import { hasMinimumRole } from '@/auth/types'
import { AgentRegistryCard } from '@/components/agents/agent-registry-card'
import { Card } from '@/components/ui/shell'

export default async function AgentRegistryPage() {
  const [res, user] = await Promise.all([listAgents(), getCurrentUser()])
  const agents = res.success ? res.data : []
  const canDelete = user ? hasMinimumRole(user.role, 'admin') : false
  const canCreate = canDelete

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="animate-rise">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">A csapat</p>
          <h1 className="mt-2 font-display text-[2.4rem] font-semibold leading-tight">
            Munkatársak, akikre számíthatsz
          </h1>
          <p className="mt-2 max-w-xl text-ink-soft">
            Minden agent egy-egy hús-vér munkatárs: saját névvel, stílussal és hangulattal. Kattints
            rájuk, és ismerd meg őket közelebbről.
          </p>
        </div>
        {canCreate && (
          <Link
            href="/control-plane/agents/new"
            className="rounded-full bg-coral px-5 py-2.5 text-sm font-semibold text-card shadow-[0_10px_24px_-12px_rgba(178,58,85,0.7)] transition-transform hover:-translate-y-0.5"
          >
            + Új munkatárs
          </Link>
        )}
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        {agents.map((agent) => (
          <AgentRegistryCard key={agent.id} agent={agent} canDelete={canDelete} />
        ))}
        {agents.length === 0 && (
          <Card className="md:col-span-2">
            <p className="text-sm text-ink-faint">
              Még nincs munkatárs a csapatban — futtasd:{' '}
              <code className="rounded bg-night-2 px-1.5 py-0.5 font-mono text-xs">
                npm run db:seed
              </code>
            </p>
          </Card>
        )}
      </div>
    </div>
  )
}
