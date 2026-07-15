import Link from 'next/link'
import { listAgents } from '@/app/actions/platform'
import { getAuthContext } from '@/auth/context'
import { hasMinimumRole } from '@/auth/types'
import { AgentRegistryList } from '@/components/agents/agent-registry-list'

export default async function AgentRegistryPage() {
  const [res, ctx] = await Promise.all([listAgents(), getAuthContext()])
  const agents = res.success ? res.data : []
  const canDelete = hasMinimumRole(ctx?.activeTenantRole, 'admin')
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

      <AgentRegistryList agents={agents} canDelete={canDelete} />
    </div>
  )
}
