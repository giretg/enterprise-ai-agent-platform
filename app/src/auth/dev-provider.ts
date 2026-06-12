import type { UserRole } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { AuthProvider, AuthUser } from './types'
import { assertRole } from './types'

function devRole(): UserRole {
  const role = process.env.DEV_AUTH_ROLE
  if (role === 'admin' || role === 'approver' || role === 'operator' || role === 'viewer') {
    return role
  }
  return 'operator'
}

export class DevAuthProvider implements AuthProvider {
  async getCurrentUser(): Promise<AuthUser | null> {
    const externalAuthId = process.env.DEV_AUTH_USER_ID ?? 'dev-user-001'
    const email = process.env.DEV_AUTH_EMAIL ?? 'dev@excellence.ai'
    const name = process.env.DEV_AUTH_NAME ?? 'Dev Operator'
    const role = devRole()

    const user = await prisma.user.upsert({
      where: { externalAuthId },
      create: { externalAuthId, email, name, role },
      update: { email, name, role },
    })

    return {
      id: user.id,
      externalAuthId: user.externalAuthId,
      email: user.email,
      name: user.name,
      role: user.role,
    }
  }

  async requireRole(minimum: UserRole | UserRole[]): Promise<AuthUser> {
    const user = await this.getCurrentUser()
    if (!user) throw new Error('Unauthorized')
    assertRole(user, minimum)
    return user
  }
}
