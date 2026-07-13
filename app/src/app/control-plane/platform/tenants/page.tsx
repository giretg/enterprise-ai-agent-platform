import { listTenants, listPlatformUsers } from '@/app/actions/tenant'
import { getAuthContext } from '@/auth/context'
import { PlatformTenantPanel } from '@/components/tenant/platform-tenant-panel'

/**
 * Platform admin — tenant registry (Tenant-Management §9.2, elfogadási kritérium §13/1).
 * Csak platform-szerep (`requirePlatformRole`) férhet hozzá; tenant-admin nem.
 * A lista + életciklus (suspend/offboard/archive/reactivate) + tenant-létrehozás
 * mind a `requirePlatformRole('superadmin')` guard alatti server actionökön megy.
 */
export default async function PlatformTenantsPage() {
  const [res, usersRes, ctx] = await Promise.all([listTenants(), listPlatformUsers(), getAuthContext()])
  const canManageMemberships = Boolean(ctx?.platformRoles.includes('superadmin'))

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
      {!usersRes.success && (
        <div className="rounded-lg border border-honey/35 bg-honey/10 p-3 text-sm text-ink-soft">
          Felhasználólista nem töltődött be — a tag-hozzáadás és első admin kiválasztás nem elérhető.
          <span className="mt-1 block text-xs text-ink-faint">{usersRes.error}</span>
        </div>
      )}
      <PlatformTenantPanel
        tenants={res.data}
        users={usersRes.success ? usersRes.data : []}
        canManageMemberships={canManageMemberships}
      />
    </div>
  )
}
