import type { ReactNode } from 'react'
import NextLink from 'next/link'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getAuthContext, type AuthContext } from '@/auth/context'
import { AuthLocaleShell } from '@/components/auth/auth-locale-shell'
import { CompanyStep, type PendingInvitationView } from '@/components/onboarding/company-step'
import { TeamStep } from '@/components/onboarding/team-step'
import {
  OnboardingAccountButton,
  OnboardingCard,
  OnboardingStepper,
  secondaryButtonClass,
} from '@/components/onboarding/onboarding-ui'
import { services } from '@/domain/gateway-services'
import { CONTROL_PLANE_PENDING_PATH } from '@/lib/control-plane-entry'
import {
  SELF_SERVICE_TENANT_CAP,
  canStartSelfServiceTenant,
  resolveOnboardingTeamTenantId,
  selfServiceCapReached,
} from '@/lib/tenant-policy'
import { repositories } from '@/repositories/postgres'

export async function generateMetadata() {
  const t = await getTranslations('Onboarding')
  return { title: t('metaTitle') }
}

/** Még beváltható meghívók olyan cégbe, ahol a user még nem aktív tag. */
async function pendingInvitationsFor(ctx: AuthContext): Promise<PendingInvitationView[]> {
  // updatedAt kell a felfüggesztett tagság × stale meghívó szűréshez (MembershipView nem hordozza).
  const membershipRows = await repositories.tenantMemberships.findByUser(ctx.user.id)
  const activeTenantsOfUser = new Set(
    membershipRows.filter((m) => m.status === 'active').map((m) => m.tenantId),
  )
  const suspendedByTenant = new Map(
    membershipRows.filter((m) => m.status === 'suspended').map((m) => [m.tenantId, m] as const),
  )
  const invitations = (await services.iam.listPendingInvitationsForEmail(ctx.user.email)).filter((invitation) => {
    if (!invitation.tenantId || activeTenantsOfUser.has(invitation.tenantId)) return false
    const suspended = suspendedByTenant.get(invitation.tenantId)
    // Stale meghívó (felfüggesztéskor / előtte) ne jelenjen meg Join-ként.
    if (suspended && invitation.createdAt.getTime() <= suspended.updatedAt.getTime()) return false
    return true
  })
  if (invitations.length === 0) return []
  const tenants = await repositories.tenants.findByIds(invitations.map((invitation) => invitation.tenantId!))
  const activeTenants = new Map(tenants.filter((tenant) => tenant.status === 'active').map((tenant) => [tenant.id, tenant]))
  return invitations.flatMap((invitation) => {
    const tenant = activeTenants.get(invitation.tenantId!)
    return tenant ? [{ id: invitation.id, companyName: tenant.displayName, role: invitation.role }] : []
  })
}

/** Cégindító varázsló: cégadatok / meghívó, majd opcionális munkatárs-meghívó. */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; tenant?: string }>
}) {
  const ctx = await getAuthContext()
  // Nincs belső fiók (nem igazolt e-mail / nem engedett domain) vagy felfüggesztett ⇒ várakozó képernyő.
  if (!ctx || ctx.user.status === 'suspended') redirect(CONTROL_PLANE_PENDING_PATH)

  const { step, tenant: requestedTenantId } = await searchParams
  const t = await getTranslations('Onboarding')
  const shell = (current: 'company' | 'team', content: ReactNode) => (
    <AuthLocaleShell headerExtra={<OnboardingAccountButton />}>
      <div className="w-full max-w-xl">
        <OnboardingStepper current={current} />
        {content}
      </div>
    </AuthLocaleShell>
  )

  // Superadmin assume-módban fail closed: idegen tenant nevében nem indul saját cég.
  if (ctx.assumed) {
    return shell(
      'company',
      <OnboardingCard eyebrow={t('companyEyebrow')} title={t('assumedTitle')} body={t('assumedBody')}>
        <NextLink href="/control-plane" className={secondaryButtonClass}>
          {t('backToWorkspace')}
        </NextLink>
      </OnboardingCard>,
    )
  }

  const teamTenantId = resolveOnboardingTeamTenantId({
    step,
    requestedTenantId,
    memberships: ctx.memberships,
  })
  if (teamTenantId) {
    const tenant = await repositories.tenants.findById(teamTenantId)
    if (tenant) return shell('team', <TeamStep companyName={tenant.displayName} tenantId={teamTenantId} />)
  }

  const owned = await repositories.tenants.countSelfServiceByCreator(ctx.user.id)
  const invitations = await pendingInvitationsFor(ctx)
  const hasWorkspace = ctx.kind !== 'none'
  const canCreate = canStartSelfServiceTenant({
    userStatus: ctx.user.status,
    assumed: ctx.assumed,
    ownedSelfServiceCount: owned,
  })

  if (selfServiceCapReached(owned) && invitations.length === 0) {
    return shell(
      'company',
      <OnboardingCard
        eyebrow={t('companyEyebrow')}
        title={t('capReachedTitle')}
        body={t('capReachedBody', { cap: SELF_SERVICE_TENANT_CAP })}
      >
        <div className="flex flex-wrap gap-3">
          {hasWorkspace && (
            <NextLink href="/control-plane" className={secondaryButtonClass}>
              {t('backToWorkspace')}
            </NextLink>
          )}
          <NextLink href="/contact" className={secondaryButtonClass}>
            {t('contact')}
          </NextLink>
        </div>
      </OnboardingCard>,
    )
  }

  return shell(
    'company',
    <CompanyStep
      email={ctx.user.email}
      hasWorkspace={hasWorkspace}
      invitations={invitations}
      cap={SELF_SERVICE_TENANT_CAP}
      canCreate={canCreate}
    />,
  )
}
