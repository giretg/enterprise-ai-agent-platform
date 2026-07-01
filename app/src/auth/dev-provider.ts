import type { UserRole } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { AuthProvider, AuthUser, ActiveAuthUser } from './types'
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

    // Dev-bypass: nincs valódi hitelesítés, ezért a `status`-t is szinkronban
    // tartjuk az env-konfigurált szereppel — a pending-by-default (N-IAM-3) itt
    // nem alkalmazandó, mert ez a mód eleve nem valódi onboarding-út.
    const user = await prisma.user.upsert({
      where: { externalAuthId },
      create: { externalAuthId, email, name, role, status: 'active', activatedAt: new Date() },
      update: { email, name, role, status: 'active' },
    })

    return {
      id: user.id,
      externalAuthId: user.externalAuthId,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      tenantId: user.tenantId,
    }
  }

  async requireRole(minimum: UserRole | UserRole[]): Promise<ActiveAuthUser> {
    const user = await this.getCurrentUser()
    if (!user) throw new Error('Unauthorized')
    assertRole(user, minimum)
    return user
  }
}
