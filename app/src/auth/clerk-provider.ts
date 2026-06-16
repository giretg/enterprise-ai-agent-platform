import { auth, currentUser } from '@clerk/nextjs/server'
import type { UserRole } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { AuthProvider, AuthUser } from './types'
import { assertRole } from './types'

function mapClerkRole(metadata: unknown): UserRole {
  const role = (metadata as { role?: string } | undefined)?.role
  if (role === 'admin' || role === 'approver' || role === 'operator' || role === 'viewer') {
    return role
  }
  return 'viewer'
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
    const role = mapClerkRole(clerkUser.publicMetadata)

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
      status: user.status,
    }
  }

  async requireRole(minimum: UserRole | UserRole[]): Promise<AuthUser> {
    const { userId } = await auth()
    if (!userId) throw new Error('Unauthorized')

    const user = await this.getCurrentUser()
    if (!user) throw new Error('Unauthorized')

    assertRole(user, minimum)
    return user
  }
}
