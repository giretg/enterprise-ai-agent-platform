import { getTranslations } from 'next-intl/server'
import {
  getPlatformAuditTrail,
  listPendingPlatformRegistrations,
  listPlatformMembers,
  listTenants,
} from '@/app/actions/tenant'
import { getAuthContext } from '@/auth/context'
import { PlatformIamPanel } from '@/components/tenant/platform-iam-panel'
import { PendingPlatformRegistrations } from '@/components/tenant/pending-platform-registrations'

/**
 * Platform IAM (Tenant-Management §9.3): platform-tagok (superadmin / operator /
 * auditor), platform-szerep kiosztás/megvonás és a tenant-lifecycle + assume
 * audit-napló. Csak platform-szerep (`requirePlatformRole`) fér hozzá — a
 * grant/revoke `superadmin`, a nézet `platform_auditor` minimummal.
 */
export default async function PlatformIamPage() {
  const [membersRes, auditRes, registrationsRes, tenantsRes, ctx] = await Promise.all([
    listPlatformMembers(),
    getPlatformAuditTrail(),
    listPendingPlatformRegistrations(),
    listTenants(),
    getAuthContext(),
  ])
  const canManage = Boolean(ctx?.platformRoles.includes('superadmin'))

  const t = await getTranslations('ControlPlane.platformIam')
  if (!membersRes.success) {
    return (
      <div className="space-y-6">
        <header>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
          <h1 className="mt-2 font-display text-3xl font-semibold">{t('title')}</h1>
        </header>
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {t('needPlatform')}
          <span className="mt-1 block text-xs opacity-70">{membersRes.error}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">{t('title')}</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">{t('body')}</p>
      </header>
      <PendingPlatformRegistrations
        registrations={registrationsRes.success ? registrationsRes.data : []}
        tenants={tenantsRes.success ? tenantsRes.data.filter((tenant) => tenant.status === 'active') : []}
        canManage={canManage}
        loadError={!registrationsRes.success ? registrationsRes.error : !tenantsRes.success ? tenantsRes.error : null}
      />
      <PlatformIamPanel
        members={membersRes.data}
        audit={auditRes.success ? auditRes.data : []}
        canManage={canManage}
      />
    </div>
  )
}
