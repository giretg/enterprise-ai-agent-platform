import { prisma } from '@/lib/db'
import type { UserRole, UserStatus } from '@prisma/client'
import type { AuditRepository } from '@/repositories/interfaces'
import { generateTokenPair, hashOpaqueToken } from '@/lib/crypto/hash-chain'

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 nap

/**
 * IAM / RBAC domain (§5.2, §10 lock-out védelem).
 *
 * - Admin-meghívás lejáró, egyszer beváltható, hashelt tokennel (a nyers token CSAK egyszer látszik).
 * - Utolsó aktív admin nem zárható ki (sem felfüggesztés, sem visszaminősítés).
 * - Admin a saját szerepét nem írhatja át és magát nem függesztheti fel.
 * - Minden hozzáférési esemény auditba kerül.
 *
 * Megjegyzés: Clerk módban a humán szerepkör forrása a Clerk publicMetadata, amelyet a
 * `getCurrentUser` upsert minden híváskor visszaír. A `changeRole` itt az adatmodell igazságát
 * frissíti és auditálja; a Clerk-szinkron a Fázis 2 hardening tárgya (cserepont).
 */
export class IamService {
  constructor(
    private audit: AuditRepository,
    private connectorGrants?: import('@/domain/connector-grant/connector-grant-service').ConnectorGrantService,
  ) {}

  async inviteUser(params: { email: string; role: UserRole; createdById: string }) {
    const { rawToken, tokenHash } = generateTokenPair()
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS)

    const invitation = await prisma.invitation.create({
      data: {
        email: params.email.trim().toLowerCase(),
        role: params.role,
        tokenHash,
        status: 'pending',
        expiresAt,
        createdById: params.createdById,
      },
    })

    await this.audit.append({
      actorType: 'human',
      actorId: params.createdById,
      agentVersion: null,
      action: 'access.invite',
      targetType: 'invitation',
      targetId: invitation.id,
      modelUsed: null,
      inputRef: invitation.email,
      outputRef: params.role,
      policyDecision: 'invited',
      metadata: { expiresAt: expiresAt.toISOString() },
    })

    // A nyers token CSAK most látszik — innentől csak a hash tárolt.
    return { invitation, rawToken }
  }

  async redeemInvitation(params: { token: string; externalAuthId: string; name?: string }) {
    const tokenHash = hashOpaqueToken(params.token)
    const invitation = await prisma.invitation.findUnique({ where: { tokenHash } })
    if (!invitation) throw new Error('invitation: not found')
    if (invitation.status !== 'pending') {
      throw new Error(`invitation: already ${invitation.status}`)
    }
    if (new Date() > invitation.expiresAt) {
      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: 'expired' },
      })
      throw new Error('invitation: expired')
    }

    const user = await prisma.user.upsert({
      where: { externalAuthId: params.externalAuthId },
      create: {
        externalAuthId: params.externalAuthId,
        email: invitation.email,
        name: params.name?.trim() || invitation.email,
        role: invitation.role,
        status: 'active',
      },
      update: { role: invitation.role, status: 'active' },
    })

    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: 'redeemed', redeemedAt: new Date() },
    })

    await this.audit.append({
      actorType: 'human',
      actorId: user.id,
      agentVersion: null,
      action: 'access.redeem',
      targetType: 'user',
      targetId: user.id,
      modelUsed: null,
      inputRef: invitation.id,
      outputRef: invitation.role,
      policyDecision: 'redeemed',
      metadata: { email: user.email },
    })

    return user
  }

  async changeRole(params: { targetUserId: string; newRole: UserRole; actorId: string }) {
    if (params.targetUserId === params.actorId) {
      throw new Error('lockout: admin cannot change own role')
    }

    const target = await prisma.user.findUnique({ where: { id: params.targetUserId } })
    if (!target) throw new Error('user: not found')

    // Utolsó aktív admin visszaminősítése tiltott.
    if (target.role === 'admin' && params.newRole !== 'admin' && target.status === 'active') {
      await this.assertNotLastActiveAdmin(target.id)
    }

    const updated = await prisma.user.update({
      where: { id: target.id },
      data: { role: params.newRole },
    })

    await this.audit.append({
      actorType: 'human',
      actorId: params.actorId,
      agentVersion: null,
      action: 'access.role_change',
      targetType: 'user',
      targetId: target.id,
      modelUsed: null,
      inputRef: target.role,
      outputRef: params.newRole,
      policyDecision: 'role_changed',
      metadata: null,
    })

    return updated
  }

  async setStatus(params: { targetUserId: string; status: UserStatus; actorId: string }) {
    const target = await prisma.user.findUnique({ where: { id: params.targetUserId } })
    if (!target) throw new Error('user: not found')

    if (params.status === 'suspended') {
      if (params.targetUserId === params.actorId) {
        throw new Error('lockout: admin cannot suspend own account')
      }
      // Utolsó aktív admin felfüggesztése tiltott.
      if (target.role === 'admin' && target.status === 'active') {
        await this.assertNotLastActiveAdmin(target.id)
      }
    }

    const updated = await prisma.user.update({
      where: { id: target.id },
      data: { status: params.status },
    })

    if (params.status === 'suspended' && this.connectorGrants) {
      await this.connectorGrants.revokeAllForUser(target.id, params.actorId)
    }

    await this.audit.append({
      actorType: 'human',
      actorId: params.actorId,
      agentVersion: null,
      action: params.status === 'suspended' ? 'access.suspend' : 'access.role_change',
      targetType: 'user',
      targetId: target.id,
      modelUsed: null,
      inputRef: target.status,
      outputRef: params.status,
      policyDecision: params.status === 'suspended' ? 'suspended' : 'status_changed',
      metadata: null,
    })

    return updated
  }

  async listUsers() {
    return prisma.user.findMany({ orderBy: { createdAt: 'asc' } })
  }

  async listInvitations() {
    return prisma.invitation.findMany({ orderBy: { createdAt: 'desc' } })
  }

  /** §10: legalább egy aktív adminnak mindig maradnia kell. */
  private async assertNotLastActiveAdmin(excludeUserId: string) {
    const otherActiveAdmins = await prisma.user.count({
      where: { role: 'admin', status: 'active', id: { not: excludeUserId } },
    })
    if (otherActiveAdmins === 0) {
      throw new Error('lockout: last active admin cannot be removed')
    }
  }
}
