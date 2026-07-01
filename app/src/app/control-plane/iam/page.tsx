import {
  getPermissionMatrix,
  listInvitations,
  listUsers,
  listWorkspaceTenants,
} from '@/app/actions/platform'
import { IamAdminPanel } from '@/components/iam/iam-admin-panel'
import { WorkspaceOffboardingPanel } from '@/components/iam/workspace-offboarding-panel'

export default async function IamPage() {
  const [usersRes, invitationsRes, tenantsRes, permissionsRes] = await Promise.all([
    listUsers(),
    listInvitations(),
    listWorkspaceTenants(),
    getPermissionMatrix(),
  ])
  const users = usersRes.success ? usersRes.data : []
  const invitations = invitationsRes.success ? invitationsRes.data : []
  const tenantIds = tenantsRes.success ? tenantsRes.data.tenantIds : []
  const permissions = permissionsRes.success ? permissionsRes.data : []
  const error =
    !usersRes.success ? usersRes.error : !invitationsRes.success ? invitationsRes.error : null

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">IAM</p>
          <h1 className="mt-2 font-display text-3xl font-semibold">Hozzáférések</h1>
          <p className="mt-1 max-w-2xl text-ink-soft">
            Meghívók, szerepkörök, felfüggesztés és lock-out védelem egy helyen.
          </p>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          {error}
        </div>
      ) : (
        <>
          <IamAdminPanel users={users} invitations={invitations} permissions={permissions} />
          <WorkspaceOffboardingPanel tenantIds={tenantIds} />
        </>
      )}
    </div>
  )
}
