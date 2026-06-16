import type { UserRole, UserStatus } from '@prisma/client'

export type AuthUser = {
  id: string
  externalAuthId: string
  email: string
  name: string
  role: UserRole
  status: UserStatus
  tenantId: string | null
}

export interface AuthProvider {
  getCurrentUser(): Promise<AuthUser | null>
  requireRole(minimum: UserRole | UserRole[]): Promise<AuthUser>
}

const ROLE_RANK: Record<UserRole, number> = {
  viewer: 0,
  operator: 1,
  approver: 2,
  admin: 3,
}

export function hasMinimumRole(userRole: UserRole, required: UserRole | UserRole[]): boolean {
  const requiredRoles = Array.isArray(required) ? required : [required]
  const userRank = ROLE_RANK[userRole]
  return requiredRoles.some((role) => userRank >= ROLE_RANK[role])
}

/** Kill-switch: felfüggesztett fiók nem léphet be (§10). */
export function assertActive(user: AuthUser): void {
  if (user.status === 'suspended') {
    throw new Error('Account suspended')
  }
}

export function assertRole(user: AuthUser, required: UserRole | UserRole[]): void {
  assertActive(user)
  if (!hasMinimumRole(user.role, required)) {
    throw new Error('Insufficient permissions')
  }
}
