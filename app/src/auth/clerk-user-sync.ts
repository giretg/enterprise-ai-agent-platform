import type { PrismaClient, User, UserRole } from '@prisma/client'

export type ClerkUserSyncInput = {
  externalAuthId: string
  email: string
  name: string
  role: UserRole | null
}

const ROLE_RANK: Record<UserRole, number> = {
  viewer: 0,
  operator: 1,
  approver: 2,
  admin: 3,
}

function pickBestEmailMatch(users: User[]): User | null {
  if (users.length === 0) return null
  return [...users].sort((a, b) => {
    const roleDelta = ROLE_RANK[b.role] - ROLE_RANK[a.role]
    if (roleDelta !== 0) return roleDelta
    return a.createdAt.getTime() - b.createdAt.getTime()
  })[0]
}

function updateData(input: ClerkUserSyncInput, currentRole?: UserRole) {
  return {
    email: input.email,
    name: input.name,
    role: input.role ?? currentRole,
  }
}

async function findBestUserByEmail(prisma: PrismaClient, email: string): Promise<User | null> {
  const emailMatches = await prisma.user.findMany({
    where: {
      email: {
        equals: email,
        mode: 'insensitive',
      },
    },
  })
  return pickBestEmailMatch(emailMatches)
}

/**
 * Clerk IDs differ between local/dev seeds and the hosted Clerk user. When the
 * email already belongs to an in-app account, attach that account to Clerk
 * instead of creating a fresh viewer row and hiding admin-only controls.
 */
export async function syncClerkUser(prisma: PrismaClient, input: ClerkUserSyncInput): Promise<User> {
  const existingByAuthId = await prisma.user.findUnique({
    where: { externalAuthId: input.externalAuthId },
  })

  if (existingByAuthId) {
    const existingByEmail = await findBestUserByEmail(prisma, input.email)
    return prisma.user.update({
      where: { id: existingByAuthId.id },
      data: updateData(input, existingByEmail?.role ?? existingByAuthId.role),
    })
  }

  const existingByEmail = await findBestUserByEmail(prisma, input.email)

  if (existingByEmail) {
    return prisma.user.update({
      where: { id: existingByEmail.id },
      data: {
        externalAuthId: input.externalAuthId,
        ...updateData(input, existingByEmail.role),
      },
    })
  }

  return prisma.user.create({
    data: {
      externalAuthId: input.externalAuthId,
      email: input.email,
      name: input.name,
      role: input.role ?? 'viewer',
    },
  })
}
