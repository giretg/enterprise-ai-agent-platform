import Link from 'next/link'
import { getModelPolicy } from '@/app/actions/platform'
import { CreateAgentForm } from '@/components/agents/create-agent-form'
import { enabledModelProviders } from '@/lib/model-policy'

export default async function NewAgentPage() {
  const policyRes = await getModelPolicy()
  const providers = policyRes.success ? enabledModelProviders(policyRes.data) : []

  return (
    <div className="space-y-6">
      <div>
        <Link href="/control-plane/agents" className="text-sm text-ink-faint hover:text-ink">
          ← Agent Registry
        </Link>
        <h1 className="mt-2 font-display text-3xl font-semibold">Új agent</h1>
        <p className="mt-1 text-ink-soft">Admin wizard — memória, verzió és scoped API-kulcs automatikusan</p>
      </div>

      <div className="max-w-2xl">
        {policyRes.success && providers.length > 0 ? (
          <CreateAgentForm providers={providers} />
        ) : (
          <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
            {policyRes.success
              ? 'Nincs agenthez engedélyezett modell. A Rendszer oldalon engedélyezz legalább egyet.'
              : policyRes.error}
          </div>
        )}
      </div>
    </div>
  )
}
