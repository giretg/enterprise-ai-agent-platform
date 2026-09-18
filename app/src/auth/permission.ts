import { getCurrentUser } from './index'
import { repositories } from '@/repositories/postgres'
import { decideAuthz, type AuthzDenyReason } from '@/lib/iam-policy'
import type { ActiveAuthUser } from './types'

export type AuthzErrorCode = AuthzDenyReason | 'NO_USER'

export class AuthzError extends Error {
  code: AuthzErrorCode
  constructor(code: AuthzErrorCode) {
    super(code)
    this.name = 'AuthzError'
    this.code = code
  }
}

/**
 * Deny-by-default permission-kapu (Feature-spec IAM-RBAC §6, N-IAM-2).
 *
 * A `role_permissions` deklaratív mátrixból olvassa az adott művelet minimum
 * szerepét — ISMERETLEN permission_key ⇒ tilt (nincs "implicit engedély").
 * A döntést (és minden elutasítást) a `user.authz.deny` audit-esemény rögzíti.
 *
 * Ez az IAM-feature saját, permission-kulcs-alapú kapuja; a platform többi
 * ~85 hívási helye a meglévő `requireRole(role literál)`-t használja tovább
 * (funkcionálisan ekvivalens, migrálásuk külön follow-up).
 */
export async function requirePermission(permissionKey: string): Promise<ActiveAuthUser> {
  const user = await getCurrentUser()
  if (!user) throw new AuthzError('NO_USER')

  const entry = await repositories.rolePermissions.findByKey(permissionKey)
  const decision = decideAuthz(user, entry?.minRole ?? null)

  if (!decision.allow) {

    throw new AuthzError(decision.reason)
  }

  // decideAuthz csak akkor ad allow:true-t, ha user.role nem NULL (lásd fent) —
  // a cast itt ugyanazt a garanciát fejezi ki típusszinten, mint assertRole/ActiveAuthUser.
  return user as ActiveAuthUser
}
