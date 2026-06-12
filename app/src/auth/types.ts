import type { UserRole } from '@prisma/client'

export type AuthUser = {
  id: string
  externalAuthId: string
  email: string
  name: string
  role: UserRole
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

export function assertRole(user: AuthUser, required: UserRole | UserRole[]): void {
  if (!hasMinimumRole(user.role, required)) {
    throw new Error('Insufficient permissions')
  }
}
