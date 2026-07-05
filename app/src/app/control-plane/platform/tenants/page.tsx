import { listTenants } from '@/app/actions/tenant'
import { PlatformTenantPanel } from '@/components/tenant/platform-tenant-panel'

/**
 * Platform admin — tenant registry (Tenant-Management §9.2, elfogadási kritérium §13/1).
 * Csak platform-szerep (`requirePlatformRole`) férhet hozzá; tenant-admin nem.
 * A lista + életciklus (suspend/offboard/archive/reactivate) + tenant-létrehozás
 * mind a `requirePlatformRole('superadmin')` guard alatti server actionökön megy.
 */
export default async function PlatformTenantsPage() {
  const res = await listTenants()

  if (!res.success) {
    return (
      <div className="space-y-6">
        <header>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Platform</p>
          <h1 className="mt-2 font-display text-3xl font-semibold">Tenantok</h1>
        </header>
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          Ehhez a felülethez platform-szintű jogosultság (superadmin / platform operator) szükséges.
          <span className="mt-1 block text-xs opacity-70">{res.error}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Platform</p>
          <h1 className="mt-2 font-display text-3xl font-semibold">Tenantok</h1>
          <p className="mt-1 max-w-2xl text-ink-soft">
            Ügyfelek (tenantok) regisztere és életciklusa. Minden tenant saját agentekkel,
            connectorokkal, Playbookokkal és audit-nézettel — nincs adat-megosztás tenantok között.
          </p>
        </div>
      </header>
      <PlatformTenantPanel tenants={res.data} />
    </div>
  )
}
