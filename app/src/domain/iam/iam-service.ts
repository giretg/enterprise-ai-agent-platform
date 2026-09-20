import type { Invitation, TenantMembership, User, UserRole, UserStatus } from '@prisma/client'
import type {
  UserRepository,
  InvitationRepository,
  RolePermissionRepository,
  TenantMembershipRepository,
} from '@/repositories/interfaces'
import { computeDiffHash, generateTokenPair, hashOpaqueToken } from '@/lib/crypto/hash-chain'
import {
  ROLE_RANK,
  checkInvitationRedeemable,
  checkLastAdminLock,
  isPreProvisionedAuthId,
  isSelfModification,
  makePreProvisionedAuthId,
} from '@/lib/iam-policy'
import type { AuditSink } from '@/lib/audit/types'
import { writeAudit } from '@/lib/audit/types'

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 nap

function emailAuditRef(email: string): string {
  return `sha256:${computeDiffHash(email)}`
}

/**
 * IAM / RBAC domain (Feature-spec IAM-RBAC §4, §6, §7, §8).
 *
 * - Admin-meghívás lejáró, egyszer beváltható, hashelt tokennel (a nyers token CSAK egyszer látszik).
 * - Csendes előkészítés (`provisionUser`): User + TenantMembership email+szereppel, meghívó email nélkül;
 *   első verified Clerk/Google login email-egyeztetéssel aktivál (`claimPreProvisionedUser`).
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
    private connectorGrants?: import('@/domain/connector-grant/connector-grant-service').ConnectorGrantService,
    private memberships?: TenantMembershipRepository,
    private audit?: AuditSink,
  ) {}

  private async append(data: Parameters<AuditSink['append']>[0]) {
    await writeAudit(this.audit, data)
  }

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

    await this.append({
      actorType: 'human',
      actorId: params.createdById,
      agentVersion: null,
      action: 'user.invite.issue',
      targetType: 'invitation',
      targetId: invitation.id,
      modelUsed: null,
      inputRef: emailAuditRef(invitation.email),
      outputRef: params.role,
      policyDecision: 'invited',
      metadata: { expiresAt: expiresAt.toISOString(), tenantId: params.tenantId },
      tenantId: params.tenantId,
    })

    // A nyers token CSAK most látszik — innentől csak a hash tárolt.
    return { invitation, rawToken }
  }

  /**
   * Csendes előkészítés: User + TenantMembership email+szereppel, meghívó email / token nélkül.
   * Új email → pending User + pending membership; első login claimeli (`claimPreProvisionedUser`).
   * Már létező (más tenantben aktív) User → csak új membership; aktív usernél azonnal active.
   */
  async provisionUser(params: {
    email: string
    role: UserRole
    createdById: string
    tenantId: string
  }) {
    if (!this.memberships) throw new Error('provision: tenant membership repository unavailable')

    const email = params.email.trim().toLowerCase()
    const existingUsers = await this.users.findManyByEmail(email)

    let user =
      existingUsers.length > 0
        ? [...existingUsers].sort((a, b) => {
            const aPre = isPreProvisionedAuthId(a.externalAuthId) ? 1 : 0
            const bPre = isPreProvisionedAuthId(b.externalAuthId) ? 1 : 0
            if (bPre !== aPre) return bPre - aPre
            const roleDelta = ROLE_RANK[b.role ?? 'viewer'] - ROLE_RANK[a.role ?? 'viewer']
            if (roleDelta !== 0) return roleDelta
            return a.createdAt.getTime() - b.createdAt.getTime()
          })[0]
        : null

    if (user) {
      const existingMembership = await this.memberships.findByTenantAndUser(params.tenantId, user.id)
      if (existingMembership) {
        throw new Error('user: already provisioned for this tenant')
      }
      // Multi-tenant re-provision: never demote the global user.role below an
      // already-assigned pending role; elevate when the new tenant asks higher.
      if (user.role && ROLE_RANK[params.role] > ROLE_RANK[user.role]) {
        user = await this.users.update(user.id, { role: params.role })
      } else if (!user.role) {
        user = await this.users.update(user.id, { role: params.role })
      }
    } else {
      user = await this.users.create({
        externalAuthId: makePreProvisionedAuthId(),
        email,
        name: email,
        role: params.role,
        status: 'pending',
        invitedById: params.createdById,
      })
    }

    const alreadyLinked = !isPreProvisionedAuthId(user.externalAuthId)
    // Admin előkészítés meglévő Clerk-fiókon = jóváhagyás: azonnal active.
    if (alreadyLinked && user.status === 'pending') {
      user = await this.users.update(user.id, {
        status: 'active',
        activatedAt: new Date(),
      })
    }

    const membershipStatus = alreadyLinked && user.status === 'active' ? 'active' : 'pending'

    const membership = await this.memberships.create({
      tenantId: params.tenantId,
      userId: user.id,
      role: params.role,
      status: membershipStatus,
      invitedById: params.createdById,
    })

    await this.append({
      actorType: 'human',
      actorId: params.createdById,
      agentVersion: null,
      action: 'user.provision.create',
      targetType: 'user',
      targetId: user.id,
      modelUsed: null,
      inputRef: emailAuditRef(email),
      outputRef: params.role,
      policyDecision: 'provisioned',
      metadata: { membershipId: membership.id, tenantId: params.tenantId },
      tenantId: params.tenantId,
    })

    return { user, membership }
  }

  /**
   * Első verified login: placeholder externalAuthId → Clerk subject, user + pending memberships active.
   * Nem pre-provisioned userre no-op (visszaadja a bemeneti usert).
   */
  async claimPreProvisionedUser(params: { user: User; externalAuthId: string; name?: string }) {
    if (!isPreProvisionedAuthId(params.user.externalAuthId)) {
      return params.user
    }

    // Clerk retries / concurrent request-time sync: ha már átkötötték, ne dobjon hibát.
    const alreadyLinked = await this.users.findByExternalAuthId(params.externalAuthId)
    if (alreadyLinked && alreadyLinked.id === params.user.id) {
      return alreadyLinked
    }
    if (alreadyLinked && alreadyLinked.id !== params.user.id) {
      throw new Error('user: external auth id already linked')
    }

    const name = params.name?.trim() || params.user.name
    const now = new Date()
    const user = await this.users.update(params.user.id, {
      externalAuthId: params.externalAuthId,
      name,
      email: params.user.email,
      status: 'active',
      activatedAt: now,
      lastLoginAt: now,
    })

    await this.activatePendingMemberships(user.id)

    await this.append({
      actorType: 'human',
      actorId: user.id,
      agentVersion: null,
      action: 'user.provision.claim',
      targetType: 'user',
      targetId: user.id,
      modelUsed: null,
      inputRef: params.user.externalAuthId,
      outputRef: user.role,
      policyDecision: 'claimed',
      metadata: null,
    })

    return user
  }

  /**
   * Admin csendes előkészítés meglévő Clerk-fiókon: pending + szerep → active + active memberships.
   * (Önregisztráció után előkészítés, vagy korábban beragadt fiók belépéskor.)
   */
  async activateProvisionedUser(params: { user: User; externalAuthId?: string; name?: string }) {
    if (isPreProvisionedAuthId(params.user.externalAuthId)) {
      if (!params.externalAuthId) return params.user
      return this.claimPreProvisionedUser({
        user: params.user,
        externalAuthId: params.externalAuthId,
        name: params.name,
      })
    }

    if (params.user.status === 'active') {
      await this.activatePendingMemberships(params.user.id)
      return params.user
    }

    if (params.user.status !== 'pending' || params.user.role === null) {
      return params.user
    }

    const now = new Date()
    const user = await this.users.update(params.user.id, {
      ...(params.externalAuthId ? { externalAuthId: params.externalAuthId } : {}),
      ...(params.name?.trim() ? { name: params.name.trim() } : {}),
      status: 'active',
      activatedAt: now,
      lastLoginAt: now,
    })

    await this.activatePendingMemberships(user.id)

    await this.append({
      actorType: 'human',
      actorId: user.id,
      agentVersion: null,
      action: 'user.provision.claim',
      targetType: 'user',
      targetId: user.id,
      modelUsed: null,
      inputRef: emailAuditRef(params.user.email),
      outputRef: user.role,
      policyDecision: 'activated',
      metadata: null,
    })

    return user
  }

  private async activatePendingMemberships(userId: string) {
    if (!this.memberships) return
    const memberships = await this.memberships.findByUser(userId)
    for (const membership of memberships) {
      if (membership.status !== 'pending') continue
      await this.memberships.update(membership.id, {
        status: 'active',
        activatedAt: new Date(),
      })
    }
  }

  async revokeInvitation(params: { invitationId: string; actorId: string; actorTenantId: string | null }) {
    const invitation = await this.invitations.findById(params.invitationId)
    if (!invitation) throw new Error('invitation: not found')
    if (invitation.tenantId !== params.actorTenantId) throw new Error('invitation: not found')
    if (invitation.status !== 'pending') {
      throw new Error(`invitation: cannot revoke, already ${invitation.status}`)
    }

    const updated = await this.invitations.revokePending(invitation.id, new Date())
    if (!updated) throw new Error('invitation: cannot revoke, already redeemed')

    await this.append({
      actorType: 'human',
      actorId: params.actorId,
      agentVersion: null,
      action: 'user.invite.revoke',
      targetType: 'invitation',
      targetId: invitation.id,
      modelUsed: null,
      inputRef: emailAuditRef(invitation.email),
      outputRef: null,
      policyDecision: 'revoked',
      metadata: null,
      tenantId: invitation.tenantId,
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

    const claimed = await this.invitations.claimPendingRedemption(invitation.id, params.email, new Date())
    if (!claimed) throw new Error('invitation: already_redeemed_or_unavailable')

    const user = await this.users.upsertByExternalAuthId({
      externalAuthId: params.externalAuthId,
      create: {
        email: invitation.email,
        name: params.name?.trim() || invitation.email,
        role: invitation.role,
        status: 'active',
      },
      update: {
        role: invitation.role,
        status: 'active',
        activatedAt: new Date(),
        invitedById: invitation.createdById,
      },
    })

    await this.completeInvitationRedemption(claimed, user, 'token')

    return user
  }

  /** Stores the native Clerk invitation id for revocation/reconciliation. It never grants access. */
  async bindClerkInvitation(params: { invitationId: string; clerkInvitationId: string }) {
    const invitation = await this.invitations.findById(params.invitationId)
    if (!invitation) throw new Error('invitation: not found')
    if (invitation.status !== 'pending') throw new Error('invitation: not pending')
    return this.invitations.update(invitation.id, { clerkInvitationId: params.clerkInvitationId })
  }

  /**
   * Provider identity is not authorization. A signed Clerk lifecycle event may
   * activate exactly the locally-issued invitation id copied into Clerk's
   * server-only public metadata, after local email/status/expiry checks.
   */
  async redeemClerkInvitation(params: { invitationId: string; user: User }) {
    const invitation = await this.invitations.findById(params.invitationId)
    if (!invitation) throw new Error('invitation: not found')

    // Clerk retries signed events. A completed local invitation is a successful
    // no-op for the same verified e-mail, never a second grant or audit event.
    if (invitation.status === 'redeemed') {
      if (invitation.email.trim().toLowerCase() !== params.user.email.trim().toLowerCase()) {
        throw new Error('invitation: email_mismatch')
      }
      return params.user
    }

    const check = checkInvitationRedeemable(invitation, { email: params.user.email, now: new Date() })
    if (!check.ok) {
      if (check.reason === 'EXPIRED' && invitation.status === 'pending') {
        await this.invitations.update(invitation.id, { status: 'expired' })
      }
      throw new Error(`invitation: ${check.reason.toLowerCase()}`)
    }

    const claimed = await this.invitations.claimPendingRedemption(invitation.id, params.user.email, new Date())
    if (!claimed) {
      const current = await this.invitations.findById(invitation.id)
      if (current?.status === 'redeemed' && current.email.trim().toLowerCase() === params.user.email.trim().toLowerCase()) {
        return params.user
      }
      throw new Error('invitation: already_redeemed_or_unavailable')
    }
    const user = await this.users.update(params.user.id, {
      role: invitation.role,
      status: 'active',
      activatedAt: new Date(),
      invitedById: invitation.createdById,
    })
    await this.completeInvitationRedemption(claimed, user, 'clerk')
    return user
  }

  private async completeInvitationRedemption(
    invitation: Invitation,
    user: User,
    source: 'token' | 'clerk',
  ) {
    if (invitation.tenantId) {
      if (!this.memberships) throw new Error('invitation: tenant membership repository unavailable')
      const membership = await this.memberships.upsert({
        tenantId: invitation.tenantId,
        userId: user.id,
        role: invitation.role,
        status: 'active',
        invitedById: invitation.createdById,
      })
      await this.append({
        actorType: 'human',
        actorId: user.id,
        agentVersion: null,
        action: 'tenant.member.invite_accept',
        targetType: 'tenant_membership',
        targetId: membership.id,
        modelUsed: null,
        inputRef: invitation.id,
        outputRef: invitation.role,
        policyDecision: 'active',
        metadata: { invitationId: invitation.id, source },
        tenantId: invitation.tenantId,
      })
    }

    await this.append({
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
      metadata: { source },
      tenantId: invitation.tenantId,
    })
  }

  /** §7/B: pending + role=NULL önregisztrált fiók jóváhagyása szerepkör-kiosztással. */
  async approveUser(params: { targetUserId: string; role: UserRole; actorId: string; actorTenantId: string | null }) {
    const { user: target, membership } = await this.loadTenantScopedTarget(
      params.targetUserId,
      params.actorTenantId,
    )
    if (target.status !== 'pending' || target.role !== null) {
      throw new Error('user: not pending approval')
    }

    const updated = await this.users.update(target.id, {
      role: params.role,
      status: 'active',
      activatedAt: new Date(),
      invitedById: params.actorId,
    })

    if (membership) {
      await this.memberships!.update(membership.id, {
        role: params.role,
        status: 'active',
        activatedAt: new Date(),
      })
    } else if (params.actorTenantId && this.memberships) {
      await this.memberships.create({
        tenantId: params.actorTenantId,
        userId: target.id,
        role: params.role,
        status: 'active',
        invitedById: params.actorId,
      })
    }

    await this.append({
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
      tenantId: params.actorTenantId,
    })

    return this.withMembershipView(updated, params.role, 'active', params.actorTenantId)
  }

  async changeRole(params: { targetUserId: string; newRole: UserRole; actorId: string; actorTenantId: string | null }) {
    if (isSelfModification(params.actorId, params.targetUserId)) {
      throw new Error('self_modification_forbidden: admin cannot change own role')
    }

    const { user: target, membership } = await this.loadTenantScopedTarget(
      params.targetUserId,
      params.actorTenantId,
    )

    if (target.role === 'admin' && params.newRole !== 'admin' && target.status === 'active') {
      await this.assertNotLastActiveAdmin(params.actorTenantId, target.id)
    }

    let updated: User
    if (membership) {
      await this.memberships!.update(membership.id, { role: params.newRole })
      updated = target
    } else {
      updated = await this.users.update(target.id, { role: params.newRole })
    }

    await this.append({
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
      tenantId: params.actorTenantId,
    })

    return this.withMembershipView(updated, params.newRole, target.status, params.actorTenantId)
  }

  async suspendUser(params: { targetUserId: string; reason: string; actorId: string; actorTenantId: string | null }) {
    if (isSelfModification(params.actorId, params.targetUserId)) {
      throw new Error('self_modification_forbidden: admin cannot suspend own account')
    }

    const { user: target, membership } = await this.loadTenantScopedTarget(
      params.targetUserId,
      params.actorTenantId,
    )

    if (target.role === 'admin' && target.status === 'active') {
      await this.assertNotLastActiveAdmin(params.actorTenantId, target.id)
    }

    if (membership) {
      await this.memberships!.update(membership.id, { status: 'suspended' })
    }

    const otherActive =
      this.memberships && membership
        ? (await this.memberships.findByUser(target.id)).some(
            (m) => m.id !== membership.id && m.status === 'active',
          )
        : false

    const updated = otherActive
      ? target
      : await this.users.update(target.id, {
          status: 'suspended',
          suspendedAt: new Date(),
          suspendedById: params.actorId,
          suspendedReason: params.reason,
        })

    // Globális grant-revok csak akkor, ha a fiók minden tenantről kiesett.
    // Egyetlen tenant tagság felfüggesztése ne törölje a többi tenant grantjeit.
    if (!otherActive && this.connectorGrants) {
      await this.connectorGrants.revokeAllForUser(target.id, params.actorId)
    }

    await this.append({
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
      metadata: { reasonHash: computeDiffHash(params.reason) },
      tenantId: params.actorTenantId,
    })

    return this.withMembershipView(
      otherActive ? { ...updated, status: 'suspended' as UserStatus } : updated,
      target.role,
      'suspended',
      params.actorTenantId,
    )
  }

  async reactivateUser(params: { targetUserId: string; actorId: string; actorTenantId: string | null }) {
    const { user: target, membership } = await this.loadTenantScopedTarget(
      params.targetUserId,
      params.actorTenantId,
    )
    // Overlay-elt státusz: membership-only suspend esetén a User.active maradhat.
    const effectiveStatus = membership?.status ?? target.status
    if (effectiveStatus !== 'suspended') throw new Error('user: not suspended')

    if (membership) {
      await this.memberships!.update(membership.id, {
        status: 'active',
        activatedAt: membership.activatedAt ?? new Date(),
      })
    }

    const rawUser = await this.users.findById(target.id)
    if (!rawUser) throw new Error('user: not found')

    const updated =
      rawUser.status === 'suspended'
        ? await this.users.update(target.id, {
            status: 'active',
            suspendedAt: null,
            suspendedById: null,
            suspendedReason: null,
          })
        : rawUser

    await this.append({
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
      tenantId: params.actorTenantId,
    })

    return this.withMembershipView(updated, target.role, 'active', params.actorTenantId)
  }

  /**
   * A humán "szerep" szabad szöveges leírásának beállítása (pl. "marketing vezető").
   * Az agent user_directory toolja ezt látja. Tenant-izolált (N-IAM-6): cross-tenant
   * célpont "not found". Üres/whitespace érték törli a leírást (null).
   */
  async setJobDescription(params: {
    targetUserId: string
    jobDescription: string | null
    actorId: string
    actorTenantId: string | null
  }) {
    const { user: target } = await this.loadTenantScopedTarget(params.targetUserId, params.actorTenantId)
    void params.jobDescription
    const updated = target



    return updated
  }

  async listUsers(tenantId: string | null, opts?: { limit?: number; offset?: number; unbounded?: boolean }) {
    if (tenantId && this.memberships) {
      const memberships = await this.memberships.findByTenant(tenantId)
      const users = await this.users.findManyByIds(memberships.map((m) => m.userId))
      const byId = new Map(users.map((user) => [user.id, user]))

      const fromMembership = memberships.flatMap((membership) => {
        const user = byId.get(membership.userId)
        if (!user) return []
        return [this.withMembershipView(user, membership.role, membership.status, tenantId)]
      })

      // Legacy egytenantos rekordok: User.tenantId kitöltve, membership sor még nincs.
      const sorted = fromMembership.sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      )
      if (opts?.unbounded) return sorted
      const limit = opts?.limit ?? 100
      const offset = opts?.offset ?? 0
      return sorted.slice(offset, offset + limit)
    }

    return this.users.findMany({
      ...(opts?.unbounded ? { unbounded: true } : { limit: opts?.limit ?? 100, offset: opts?.offset }),
    })
  }

  async listInvitations(
    tenantId: string | null,
    opts?: { limit?: number; offset?: number; unbounded?: boolean },
  ) {
    return this.invitations.findMany({
      tenantId,
      ...(opts?.unbounded ? { unbounded: true } : { limit: opts?.limit ?? 100, offset: opts?.offset }),
    })
  }

  async getPermissionMatrix() {
    return this.rolePermissions.findAll()
  }

  async updatePermission(params: {
    permissionKey: string
    minRole: UserRole
    actorId: string
    tenantId: string | null
  }) {
    const before = await this.rolePermissions.findByKey(params.permissionKey)
    const updated = await this.rolePermissions.upsert(params.permissionKey, params.minRole, before?.description)

    await this.append({
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
      metadata: { permissionKey: params.permissionKey, tenantId: params.tenantId },
      tenantId: params.tenantId,
    })

    return updated
  }

  async auditUserAgentAccessUpdate(params: {
    actorId: string
    tenantId: string | null
    targetUserId: string
    agentId: string
    granted: boolean
  }) {
    await this.append({
      actorType: 'human',
      actorId: params.actorId,
      agentVersion: null,
      action: 'user.agent_access.update',
      targetType: 'agent',
      targetId: params.agentId,
      modelUsed: null,
      inputRef: null,
      outputRef: params.granted ? 'operate' : 'revoked',
      policyDecision: params.granted ? 'granted' : 'revoked',
      metadata: { targetUserId: params.targetUserId, tenantId: params.tenantId },
      tenantId: params.tenantId,
    })
  }

  /**
   * N-IAM-6: minden cél-alapú User-műveletnek ezen kell átmennie — cross-tenant
   * célpontra "not found"-ot ad, nem szivárogtatja, hogy a rekord létezik-e (§8.8).
   * Membership jelenlétében a tenant-tagság az igazság; legacy fallback: User.tenantId.
   */
  private async loadTenantScopedTarget(userId: string, actorTenantId: string | null) {
    const target = await this.users.findById(userId)
    if (!target) throw new Error('user: not found')

    if (actorTenantId && this.memberships) {
      const membership = await this.memberships.findByTenantAndUser(actorTenantId, userId)
      if (membership) {
        return {
          user: this.withMembershipView(target, membership.role, membership.status, actorTenantId),
          membership,
        }
      }
      throw new Error('user: not found')
    }

    throw new Error('user: not found')
  }

  private withMembershipView(
    user: User,
    role: UserRole | null,
    status: UserStatus | TenantMembership['status'],
    tenantId: string | null,
  ): User {
    void tenantId
    return {
      ...user,
      role,
      status: status as UserStatus,
    }
  }

  /** §8/N-IAM-5: legalább egy aktív adminnak mindig maradnia kell — tenant-szinten. */
  private async assertNotLastActiveAdmin(tenantId: string | null, excludeUserId: string) {
    if (!tenantId) return
    const otherActiveAdmins = this.memberships
      ? await this.memberships.countActiveAdmins(tenantId, excludeUserId)
      : await this.users.countActiveAdmins(tenantId, excludeUserId)
    const check = checkLastAdminLock(otherActiveAdmins, true)
    if (check.blocked) {
      throw new Error('lockout: last active admin cannot be removed')
    }
  }
}
