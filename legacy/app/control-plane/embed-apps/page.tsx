import { requireTenantRole } from '@/auth/tenant-context'
import { getEmbedApps } from '@/app/actions/embed-apps'
import { EmbedAppsPanel } from '@/components/iam/embed-apps-panel'

/**
 * Beágyazott agent-chat — „Beágyazó alkalmazások" (feature-spec #481, D7). Tenant-admin
 * oldal: itt kötik be a külső appokat (pl. CRM), amik gombbal nyithatnak platform-chatet.
 */
export default async function EmbedAppsPage() {
  await requireTenantRole('admin')
  const res = await getEmbedApps()

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">
          Beágyazott agent-chat
        </p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Beágyazó alkalmazások</h1>
      </div>

      {res.success ? (
        <EmbedAppsPanel initialApps={res.data.apps} />
      ) : (
        <p className="text-sm text-ink-faint">{res.error}</p>
      )}
    </div>
  )
}
