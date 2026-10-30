import Link from 'next/link'
import { getAgentMailOverview } from '@/app/actions/agentmail'
import { getTenantMailboxOverview } from '@/app/actions/tenant-mailbox'
import { AgentMailPanel } from './agentmail-panel'
import { TenantMailboxPanel } from './tenant-mailbox-panel'

/** OAuth-visszatérés hibakódjai, közérthetően. */
function tenantMailboxReturnMessage(error: string | undefined): string | null {
  if (!error) return null
  if (error === 'mailbox_account_mismatch') {
    return 'Más fiókkal léptél be, mint amelyik ehhez a postafiókhoz tartozik. Lépj be az eredeti postafiók fiókjával.'
  }
  if (error === 'access_denied') return 'A bejelentkezést megszakítottad, a postafiók nincs bekötve.'
  if (error === 'mailbox_address_unknown') return 'Nem sikerült megállapítani a postafiók címét. Próbáld újra.'
  return `A postafiók bekötése nem sikerült (${error}).`
}

export default async function MailboxesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; connected?: string }>
}) {
  const [params, overview, mailboxes] = await Promise.all([
    searchParams,
    getAgentMailOverview(),
    getTenantMailboxOverview(),
  ])
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <Link href="/control-plane/provisioning" className="text-xs font-semibold text-ink-soft hover:text-ink">
          ← Konnektorok
        </Link>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight">Postafiókok</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          Postafiók az agenteknek, két módon: egy meglévő közös céges cím bekötése (Google vagy Microsoft), vagy
          saját, új cím az agentnek (AgentMail). Egyik sem a munkatársak saját postafiókja — arra a Gmail kapcsolat
          való. Kimenő levél csak jóváhagyás után megy ki.
        </p>
      </header>
      {mailboxes.success ? (
        <TenantMailboxPanel
          overview={mailboxes.data}
          returnError={tenantMailboxReturnMessage(params.error)}
          connected={params.connected === '1'}
        />
      ) : (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-3 text-sm text-coral-deep">
          {mailboxes.error}
        </p>
      )}
      <h2 className="pt-2 font-display text-xl font-semibold tracking-tight">Saját cím az agentnek (AgentMail)</h2>
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
