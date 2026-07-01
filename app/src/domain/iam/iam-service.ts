import type { UserRole } from '@prisma/client'
import type { AuditRepository, UserRepository, InvitationRepository, RolePermissionRepository } from '@/repositories/interfaces'
import { generateTokenPair, hashOpaqueToken } from '@/lib/crypto/hash-chain'
import { checkInvitationRedeemable, checkLastAdminLock, isSelfModification } from '@/lib/iam-policy'

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 nap

/**
 * IAM / RBAC domain (Feature-spec IAM-RBAC §4, §6, §7, §8).
 *
 * - Admin-meghívás lejáró, egyszer beváltható, hashelt tokennel (a nyers token CSAK egyszer látszik).
 * - Utolsó aktív admin nem zárható ki (sem felfüggesztés, sem visszaminősítés) — tenant-szinten.
 * - Admin a saját szerepét/státuszát nem írhatja át.
 * - Minden hozzáférési esemény auditba kerül (§8.5 esemény-nevek).
 * - Minden lista- és cél-alapú művelet a HÍVÓ tenantjára szűkül (N-IAM-6) — cross-tenant
 *   célpontra "user: not found"-ot ad vissza, nem szivárogtatja a létezést.
 *
 * Megjegyzés: Clerk módban a humán szerepkör forrása a Clerk publicMetadata, amelyet a
 * `getCurrentUser` upsert minden híváskor visszaír. A `changeRole` itt az adatmodell igazságát
 * frissíti és auditálja; a Clerk-szinkron itt van visszaírva (platform.ts).
 */
export class IamService {
  constructor(
    private users: UserRepository,
    private invitations: InvitationRepository,
    private rolePermissions: RolePermissionRepository,
    private audit: AuditRepository,
    private connectorGrants?: import('@/domain/connector-grant/connector-grant-service').ConnectorGrantService,
  ) {}

  async inviteUser(params: { email: string; role: UserRole; createdById: string; tenantId: string | null }) {
    const { rawToken, tokenHash } = generateTokenPair()
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS)

    const invitation = await this.invitations.create({
      tenantId: params.tenantId,
      email: params.email.trim().toLowerCase(),
      role: params.role,
      tokenHash,
      expiresAt,
      createdById: params.createdById,
    })

    await this.audit.append({
      actorType: 'human',
      actorId: params.createdById,
      agentVersion: null,
      action: 'user.invite.issue',
      targetType: 'invitation',
      targetId: invitation.id,
      modelUsed: null,
      inputRef: invitation.email,
      outputRef: params.role,
      policyDecision: 'invited',
      metadata: { expiresAt: expiresAt.toISOString(), tenantId: params.tenantId },
    })

    // A nyers token CSAK most látszik — innentől csak a hash tárolt.
    return { invitation, rawToken }
  }

  async revokeInvitation(params: { invitationId: string; actorId: string; actorTenantId: string | null }) {
    const invitation = await this.invitations.findById(params.invitationId)
    if (!invitation) throw new Error('invitation: not found')
    if (invitation.tenantId !== params.actorTenantId) throw new Error('invitation: not found')
    if (invitation.status !== 'pending') {
      throw new Error(`invitation: cannot revoke, already ${invitation.status}`)
    }

    const updated = await this.invitations.update(invitation.id, {
      status: 'revoked',
      revokedAt: new Date(),
    })

    await this.audit.append({
      actorType: 'human',
      actorId: params.actorId,
      agentVersion: null,
      action: 'user.invite.revoke',
      targetType: 'invitation',
      targetId: invitation.id,
      modelUsed: null,
      inputRef: invitation.email,
      outputRef: null,
      policyDecision: 'revoked',
      metadata: null,
    })

    return updated
  }

  async redeemInvitation(params: { token: string; email: string; externalAuthId: string; name?: string }) {
    const tokenHash = hashOpaqueToken(params.token)
    const invitation = await this.invitations.findByTokenHash(tokenHash)
    if (!invitation) throw new Error('invitation: not found')

    const check = checkInvitationRedeemable(invitation, { email: params.email, now: new Date() })
    if (!check.ok) {
      if (check.reason === 'EXPIRED' && invitation.status === 'pending') {
        await this.invitations.update(invitation.id, { status: 'expired' })
      }
      throw new Error(`invitation: ${check.reason.toLowerCase()}`)
    }

    const user = await this.users.upsertByExternalAuthId({
      externalAuthId: params.externalAuthId,
      create: {
        email: invitation.email,
        name: params.name?.trim() || invitation.email,
        role: invitation.role,
        status: 'active',
        tenantId: invitation.tenantId,
      },
      update: {
        role: invitation.role,
        status: 'active',
        activatedAt: new Date(),
        invitedById: invitation.createdById,
        tenantId: invitation.tenantId,
      },
    })

    await this.invitations.update(invitation.id, { status: 'redeemed', redeemedAt: new Date() })

    await this.audit.append({
      actorType: 'human',
      actorId: user.id,
      agentVersion: null,
      action: 'user.invite.redeem',
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

  /** §7/B: pending + role=NULL önregisztrált fiók jóváhagyása szerepkör-kiosztással. */
  async approveUser(params: { targetUserId: string; role: UserRole; actorId: string; actorTenantId: string | null }) {
    const target = await this.loadTenantScopedUser(params.targetUserId, params.actorTenantId)
    if (target.status !== 'pending' || target.role !== null) {
      throw new Error('user: not pending approval')
    }

    const updated = await this.users.update(target.id, {
      role: params.role,
      status: 'active',
      activatedAt: new Date(),
      invitedById: params.actorId,
    })

    await this.audit.append({
      actorType: 'human',
      actorId: params.actorId,
      agentVersion: null,
      action: 'user.role.assign',
      targetType: 'user',
      targetId: target.id,
      modelUsed: null,
      inputRef: null,
      outputRef: params.role,
      policyDecision: 'approved',
      metadata: null,
    })

    return updated
  }

  async changeRole(params: { targetUserId: string; newRole: UserRole; actorId: string; actorTenantId: string | null }) {
    if (isSelfModification(params.actorId, params.targetUserId)) {
      throw new Error('self_modification_forbidden: admin cannot change own role')
    }

    const target = await this.loadTenantScopedUser(params.targetUserId, params.actorTenantId)

    if (target.role === 'admin' && params.newRole !== 'admin' && target.status === 'active') {
      await this.assertNotLastActiveAdmin(params.actorTenantId, target.id)
    }

    const updated = await this.users.update(target.id, { role: params.newRole })

    await this.audit.append({
      actorType: 'human',
      actorId: params.actorId,
      agentVersion: null,
      action: 'user.role.change',
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

  async suspendUser(params: { targetUserId: string; reason: string; actorId: string; actorTenantId: string | null }) {
    if (isSelfModification(params.actorId, params.targetUserId)) {
      throw new Error('self_modification_forbidden: admin cannot suspend own account')
    }

    const target = await this.loadTenantScopedUser(params.targetUserId, params.actorTenantId)

    if (target.role === 'admin' && target.status === 'active') {
      await this.assertNotLastActiveAdmin(params.actorTenantId, target.id)
    }

    const updated = await this.users.update(target.id, {
      status: 'suspended',
      suspendedAt: new Date(),
      suspendedById: params.actorId,
      suspendedReason: params.reason,
    })

    if (this.connectorGrants) {
      await this.connectorGrants.revokeAllForUser(target.id, params.actorId)
    }

    await this.audit.append({
      actorType: 'human',
      actorId: params.actorId,
      agentVersion: null,
      action: 'user.suspend',
      targetType: 'user',
      targetId: target.id,
      modelUsed: null,
      inputRef: target.status,
      outputRef: 'suspended',
      policyDecision: 'suspended',
      metadata: { reason: params.reason },
    })

    return updated
  }

  async reactivateUser(params: { targetUserId: string; actorId: string; actorTenantId: string | null }) {
    const target = await this.loadTenantScopedUser(params.targetUserId, params.actorTenantId)
    if (target.status !== 'suspended') throw new Error('user: not suspended')

    const updated = await this.users.update(target.id, {
      status: 'active',
      suspendedAt: null,
      suspendedById: null,
      suspendedReason: null,
    })

    await this.audit.append({
      actorType: 'human',
      actorId: params.actorId,
      agentVersion: null,
      action: 'user.reactivate',
      targetType: 'user',
      targetId: target.id,
      modelUsed: null,
      inputRef: 'suspended',
      outputRef: 'active',
      policyDecision: 'reactivated',
      metadata: null,
    })

    return updated
  }

  async listUsers(tenantId: string | null) {
    return this.users.findMany({ tenantId })
  }

  async listInvitations(tenantId: string | null) {
    return this.invitations.findMany({ tenantId })
  }

  async getPermissionMatrix() {
    return this.rolePermissions.findAll()
  }

  async updatePermission(params: { permissionKey: string; minRole: UserRole; actorId: string }) {
    const before = await this.rolePermissions.findByKey(params.permissionKey)
    const updated = await this.rolePermissions.upsert(params.permissionKey, params.minRole, before?.description)

    await this.audit.append({
      actorType: 'human',
      actorId: params.actorId,
      agentVersion: null,
      action: 'user.permission.update',
      targetType: 'role_permission',
      targetId: updated.id,
      modelUsed: null,
      inputRef: before?.minRole ?? null,
      outputRef: params.minRole,
      policyDecision: 'permission_updated',
      metadata: { permissionKey: params.permissionKey },
    })

    return updated
  }

  /**
   * N-IAM-6: minden cél-alapú User-műveletnek ezen kell átmennie — cross-tenant
   * célpontra "not found"-ot ad, nem szivárogtatja, hogy a rekord létezik-e (§8.8).
   */
  private async loadTenantScopedUser(userId: string, actorTenantId: string | null) {
    const target = await this.users.findById(userId)
    if (!target || target.tenantId !== actorTenantId) throw new Error('user: not found')
    return target
  }

  /** §8/N-IAM-5: legalább egy aktív adminnak mindig maradnia kell — tenant-szinten. */
  private async assertNotLastActiveAdmin(tenantId: string | null, excludeUserId: string) {
    const otherActiveAdmins = await this.users.countActiveAdmins(tenantId, excludeUserId)
    const check = checkLastAdminLock(otherActiveAdmins, true)
    if (check.blocked) {
      throw new Error('lockout: last active admin cannot be removed')
    }
  }
}
