import type { PrismaClient, User, UserRole } from '@prisma/client'
import { ROLE_RANK, isEmailDomainAllowed } from '@/lib/iam-policy'
import { repositories } from '@/repositories/postgres'

export type ClerkUserSyncInput = {
  externalAuthId: string
  email: string
  name: string
  role: UserRole | null
}

/** §7/B: nem engedett domainnel érkező, teljesen új önregisztráció elutasítva. */
export class DomainNotAllowedError extends Error {
  constructor(email: string) {
    super(`Domain not allowed for self-registration: ${email}`)
    this.name = 'DomainNotAllowedError'
  }
}

function pickBestEmailMatch(users: User[]): User | null {
  if (users.length === 0) return null
  return [...users].sort((a, b) => {
    const roleDelta = ROLE_RANK[b.role ?? 'viewer'] - ROLE_RANK[a.role ?? 'viewer']
    if (roleDelta !== 0) return roleDelta
    return a.createdAt.getTime() - b.createdAt.getTime()
  })[0]
}

function updateData(input: ClerkUserSyncInput, currentRole?: UserRole | null) {
  return {
    email: input.email,
    name: input.name,
    role: input.role ?? currentRole ?? null,
  }
}

function emailsEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function userMatchesSyncData(user: User, data: ReturnType<typeof updateData>): boolean {
  return (
    emailsEqual(user.email, data.email) &&
    user.name === data.name &&
    user.role === data.role
  )
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
    const data = updateData(input, existingByEmail?.role ?? existingByAuthId.role)
    if (userMatchesSyncData(existingByAuthId, data)) {
      return existingByAuthId
    }
    return prisma.user.update({
      where: { id: existingByAuthId.id },
      data,
    })
  }

  const existingByEmail = await findBestUserByEmail(prisma, input.email)

  if (existingByEmail) {
    const data = {
      externalAuthId: input.externalAuthId,
      ...updateData(input, existingByEmail.role),
    }
    if (
      existingByEmail.externalAuthId === data.externalAuthId &&
      userMatchesSyncData(existingByEmail, data)
    ) {
      return existingByEmail
    }
    return prisma.user.update({
      where: { id: existingByEmail.id },
      data,
    })
  }

  // Teljesen új személy (nincs se authId, se email egyezés).
  if (input.role) {
    // A metadata szerepet hordoz ⇒ Clerk-natív meghívóval érkezett (a role a
    // publicMetadata-ban, `inviteUser` állította be) — ez az admin-vezérelt út,
    // nem önregisztráció, ezért azonnal aktív (§7/A).
    return prisma.user.create({
      data: {
        externalAuthId: input.externalAuthId,
        email: input.email,
        name: input.name,
        role: input.role,
        status: 'active',
        activatedAt: new Date(),
      },
    })
  }

  // Önregisztráció (§7/B): opcionális domain-allowlist, egyébként `pending` + `role = NULL`
  // (deny-by-default, N-IAM-2/3) — csak admin-jóváhagyás után fér bármihez.
  const allowlist = process.env.IAM_SELF_REGISTER_ALLOWED_DOMAINS
  if (!isEmailDomainAllowed(input.email, allowlist)) {
    await repositories.audit.append({
      actorType: 'human',
      actorId: null,
      agentVersion: null,
      action: 'user.authz.deny',
      targetType: 'user',
      targetId: null,
      modelUsed: null,
      inputRef: input.email,
      outputRef: null,
      policyDecision: 'DOMAIN_NOT_ALLOWED',
      metadata: { externalAuthId: input.externalAuthId, email: input.email },
    })
    throw new DomainNotAllowedError(input.email)
  }

  const created = await prisma.user.create({
    data: {
      externalAuthId: input.externalAuthId,
      email: input.email,
      name: input.name,
      role: null,
      status: 'pending',
    },
  })

  await repositories.audit.append({
    actorType: 'human',
    actorId: created.id,
    agentVersion: null,
    action: 'user.selfregister',
    targetType: 'user',
    targetId: created.id,
    modelUsed: null,
    inputRef: created.email,
    outputRef: null,
    policyDecision: 'pending',
    metadata: null,
  })

  return created
}
