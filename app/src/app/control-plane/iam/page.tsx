import { getTranslations } from 'next-intl/server'
import {
  getPermissionMatrix,
  listAgents,
  listInvitations,
  listUserAgentAccess,
  listUsers,
  listWorkspaceTenants,
} from '@/app/actions/platform'
import { IamAdminPanel } from '@/components/iam/iam-admin-panel'
import { WorkspaceOffboardingPanel } from '@/components/iam/workspace-offboarding-panel'

export default async function IamPage() {
  const [usersRes, invitationsRes, tenantsRes, permissionsRes, agentsRes, accessRes] =
    await Promise.all([
      listUsers(),
      listInvitations(),
      listWorkspaceTenants(),
      getPermissionMatrix(),
      listAgents({ limit: 100 }),
      listUserAgentAccess(),
    ])
  const users = usersRes.success ? usersRes.data : []
  const invitations = invitationsRes.success ? invitationsRes.data : []
  const tenantIds = tenantsRes.success ? tenantsRes.data.tenantIds : []
  const permissions = permissionsRes.success ? permissionsRes.data : []
  const agents = agentsRes.success ? agentsRes.data : []
  const grantsByUserId = accessRes.success ? accessRes.data.grantsByUserId : {}
  const error =
    !usersRes.success ? usersRes.error : !invitationsRes.success ? invitationsRes.error : null

  const t = await getTranslations('ControlPlane.iam')
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
          <h1 className="mt-2 font-display text-3xl font-semibold">{t('title')}</h1>
          <p className="mt-1 max-w-2xl text-ink-soft">{t('body')}</p>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {error}
        </div>
      ) : (
        <>
          <IamAdminPanel
            users={users}
            invitations={invitations}
            permissions={permissions}
            agents={agents}
            grantsByUserId={grantsByUserId}
          />
          <WorkspaceOffboardingPanel tenantIds={tenantIds} />
        </>
      )}
    </div>
  )
}
