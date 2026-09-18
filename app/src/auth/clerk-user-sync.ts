import type { PrismaClient, User } from '@prisma/client'
import { ROLE_RANK, isEmailDomainAllowed, isPreProvisionedAuthId } from '@/lib/iam-policy'
import { repositories } from '@/repositories/postgres'

export type ClerkUserSyncInput = {
  externalAuthId: string
  email: string
  name: string
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
    // Prefer pre-provisioned rows so first login claims the admin-prepared account
    // instead of a stale duplicate (email is not unique in the schema).
    const aPre = isPreProvisionedAuthId(a.externalAuthId) ? 1 : 0
    const bPre = isPreProvisionedAuthId(b.externalAuthId) ? 1 : 0
    if (bPre !== aPre) return bPre - aPre
    const roleDelta = ROLE_RANK[b.role ?? 'viewer'] - ROLE_RANK[a.role ?? 'viewer']
    if (roleDelta !== 0) return roleDelta
    return a.createdAt.getTime() - b.createdAt.getTime()
  })[0]
}

function updateData(input: ClerkUserSyncInput, currentRole?: User['role']) {
  return {
    email: input.email,
    name: input.name,
    // The provider proves identity only. Authorization is granted exclusively
    // by a locally validated invitation or an internal approval workflow.
    role: currentRole ?? null,
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
 *
 * Pre-provisioned users (`preprovisioned:…`) are claimed on first verified login:
 * Clerk subject is linked and pending tenant memberships become active.
 */
export async function syncClerkUser(prisma: PrismaClient, input: ClerkUserSyncInput): Promise<User> {
  const existingByAuthId = await prisma.user.findUnique({
    where: { externalAuthId: input.externalAuthId },
  })

  if (existingByAuthId) {
    if (
      existingByAuthId.status === 'pending' &&
      existingByAuthId.role !== null &&
      !isPreProvisionedAuthId(existingByAuthId.externalAuthId)
    ) {
      const { services } = await import('@/domain/gateway-services')
      return services.iam.activateProvisionedUser({
        user: existingByAuthId,
        name: input.name,
      })
    }

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
    if (isPreProvisionedAuthId(existingByEmail.externalAuthId)) {
      // Lazy import: avoids auth ↔ domain circular init at module load.
      const { services } = await import('@/domain/gateway-services')
      return services.iam.claimPreProvisionedUser({
        user: existingByEmail,
        externalAuthId: input.externalAuthId,
        name: input.name,
      })
    }

    if (existingByEmail.status === 'pending' && existingByEmail.role !== null) {
      const { services } = await import('@/domain/gateway-services')
      return services.iam.activateProvisionedUser({
        user: existingByEmail,
        externalAuthId: input.externalAuthId,
        name: input.name,
      })
    }

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

  // Új személy: opcionális domain-allowlist, egyébként `pending` + `role = NULL`
  // (§7/B). A Clerk publicMetadata nem emelhet belső jogosultságot.
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
