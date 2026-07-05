import { listPlatformMembers, getPlatformAuditTrail } from '@/app/actions/tenant'
import { getAuthContext } from '@/auth/context'
import { PlatformIamPanel } from '@/components/tenant/platform-iam-panel'

/**
 * Platform IAM (Tenant-Management §9.3): platform-tagok (superadmin / operator /
 * auditor), platform-szerep kiosztás/megvonás és a tenant-lifecycle + assume
 * audit-napló. Csak platform-szerep (`requirePlatformRole`) fér hozzá — a
 * grant/revoke `superadmin`, a nézet `platform_auditor` minimummal.
 */
export default async function PlatformIamPage() {
  const [membersRes, auditRes, ctx] = await Promise.all([
    listPlatformMembers(),
    getPlatformAuditTrail(),
    getAuthContext(),
  ])
  const canManage = Boolean(ctx?.platformRoles.includes('superadmin'))

  if (!membersRes.success) {
    return (
      <div className="space-y-6">
        <header>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Platform</p>
          <h1 className="mt-2 font-display text-3xl font-semibold">Platform IAM</h1>
        </header>
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          Ehhez a felülethez platform-szintű jogosultság szükséges.
          <span className="mt-1 block text-xs opacity-70">{membersRes.error}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Platform</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Platform IAM</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Platform-szintű szerepek és a tenant-lifecycle / superadmin assume audit-nyoma. A
          platform-szerep nem tenant-szerep — a superadmin tenant-adatba csak explicit „assume”
          után, auditálva léphet be.
        </p>
      </header>
      <PlatformIamPanel
        members={membersRes.data}
        audit={auditRes.success ? auditRes.data : []}
        canManage={canManage}
      />
    </div>
  )
}
