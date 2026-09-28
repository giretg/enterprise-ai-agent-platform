import Link from 'next/link'
import { getAgentMailOverview } from '@/app/actions/agentmail'
import { AgentMailPanel } from './agentmail-panel'

export default async function AgentMailPage() {
  const overview = await getAgentMailOverview()
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <Link href="/control-plane/provisioning" className="text-xs font-semibold text-ink-soft hover:text-ink">
          ← Konnektorok
        </Link>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight">Agent postafiókok</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          Saját e-mail cím a munkatársaknak (AgentMail, EU adattárolás). Az agent a saját nevében
          levelez — nem a felhasználó postafiókját kezeli, arra a Gmail kapcsolat való. Minden kimenő
          levél emberi jóváhagyás után megy ki.
        </p>
      </header>
      {overview.success ? (
        <AgentMailPanel overview={overview.data} />
      ) : (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-3 text-sm text-coral-deep">
          {overview.error}
        </p>
      )}
    </div>
  )
}
