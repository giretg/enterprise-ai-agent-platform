import { auth, currentUser } from '@clerk/nextjs/server'
import type { UserRole } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { AuthProvider, AuthUser, ActiveAuthUser } from './types'
import { assertRole } from './types'
import { syncClerkUser, DomainNotAllowedError } from './clerk-user-sync'

function readClerkRole(metadata: unknown): UserRole | null {
  const role = (metadata as { role?: string } | undefined)?.role
  if (role === 'admin' || role === 'approver' || role === 'operator' || role === 'viewer') {
    return role
  }
  return null
}

export class ClerkAuthProvider implements AuthProvider {
  async getCurrentUser(): Promise<AuthUser | null> {
    const clerkUser = await currentUser()
    if (!clerkUser) return null

    const externalAuthId = clerkUser.id
    const email =
      clerkUser.primaryEmailAddress?.emailAddress ??
      clerkUser.emailAddresses[0]?.emailAddress ??
      'unknown@local'
    const name =
      [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') ||
      clerkUser.username ||
      email
    const clerkRole = readClerkRole(clerkUser.publicMetadata)
    let user
    try {
      user = await syncClerkUser(prisma, {
        externalAuthId,
        email,
        name,
        role: clerkRole,
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
