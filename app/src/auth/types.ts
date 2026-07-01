import type { UserRole, UserStatus } from '@prisma/client'
import { hasMinimumRole } from '@/lib/iam-policy'

export type AuthUser = {
  id: string
  externalAuthId: string
  email: string
  name: string
  /** NULL = nincs kiosztott szerep (pending önregisztráció) — deny-by-default (N-IAM-2/3). */
  role: UserRole | null
  status: UserStatus
  tenantId: string | null
}

/** A `requireRole`/`assertRole` sikeres visszatérése garantálja a nem-NULL szerepet. */
export type ActiveAuthUser = AuthUser & { role: UserRole }

export interface AuthProvider {
  getCurrentUser(): Promise<AuthUser | null>
  requireRole(minimum: UserRole | UserRole[]): Promise<ActiveAuthUser>
}

export { hasMinimumRole }

/** N-IAM-3: a kettős kapu első fele — kizárólag `active` státusz enged tovább (pending is tiltott). */
export function assertActive(user: AuthUser): void {
  if (user.status !== 'active') {
    throw new Error(`Account not active (status=${user.status})`)
  }
}

export function assertRole(user: AuthUser, required: UserRole | UserRole[]): asserts user is ActiveAuthUser {
  assertActive(user)
  if (!user.role) {
    throw new Error('No role assigned')
  }
  if (!hasMinimumRole(user.role, required)) {
    throw new Error('Insufficient permissions')
  }
}
