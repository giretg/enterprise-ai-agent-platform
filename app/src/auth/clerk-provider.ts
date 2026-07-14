import { auth, currentUser } from '@clerk/nextjs/server'
import type { UserRole } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { AuthProvider, AuthUser, ActiveAuthUser } from './types'
import { assertRole } from './types'
import { syncClerkUser, DomainNotAllowedError } from './clerk-user-sync'

export class ClerkAuthProvider implements AuthProvider {
  async getCurrentUser(): Promise<AuthUser | null> {
    const clerkUser = await currentUser()
    if (!clerkUser) return null

    const externalAuthId = clerkUser.id
    const primaryEmail = clerkUser.primaryEmailAddress
    if (!primaryEmail || primaryEmail.verification?.status !== 'verified') return null
    const email = primaryEmail.emailAddress
    const name =
      [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') ||
      clerkUser.username ||
      email
    let user
    try {
      user = await syncClerkUser(prisma, {
        externalAuthId,
        email,
        name,
      })
    } catch (err) {
      // §7/B: domain-allowlist elutasítás ⇒ nincs belső fiók, a hívó úgy kezeli,
      // mintha nem lenne bejelentkezve (nem szivárog "van fiók, de tiltva" infó).
      if (err instanceof DomainNotAllowedError) return null
      throw err
    }

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
    const { userId } = await auth()
    if (!userId) throw new Error('Unauthorized')

    const user = await this.getCurrentUser()
    if (!user) throw new Error('Unauthorized')

    assertRole(user, minimum)
    return user
  }
}
