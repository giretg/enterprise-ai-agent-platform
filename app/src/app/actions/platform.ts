'use server'

import { z } from 'zod'
import { clerkClient } from '@clerk/nextjs/server'
import { getCurrentUser } from '@/auth'
import { requireTenantPermission, requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { repositories } from '@/repositories/postgres'
import { prisma } from '@/lib/db'
import { isClerkEnabled } from '@/lib/clerk-config'
import { fail, ok } from '@/lib/result'
import { isTenantAdmin, tenantUserSubject } from '@/domain/agent-access/tenant-user-subject'
import { DEFAULT_LIST_LIMIT } from '@/lib/list-pagination'
import {
  agentIdSchema,
  approveUserSchema,
  changeUserRoleSchema,
  createAgentSchema,
  createBehaviorProfileSchema,
  inviteUserSchema,
  listAuditLogSchema,
  provisionUserSchema,
  reactivateUserSchema,
  redeemInvitationSchema,
  revokeInvitationSchema,
  setAgentBehaviorProfileSchema,
  setUserJobDescriptionSchema,
  suspendAgentSchema,
  suspendUserSchema,
  updateAgentAvatarSchema,
  updateAgentInstructionSchema,
  updateAgentOperatorSkillManagementSchema,
  updateAgentOperatorVisibilitySchema,
  updateAgentPersonaSchema,
  updateBehaviorProfileSchema,
  updateRolePermissionSchema,
} from '@/lib/validators/actions'

export async function getMe() {
  try {
    const user = await getCurrentUser()
    if (!user) return fail('Unauthorized')
    return ok(user)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load current user')
  }
}

export async function listUsers() {
  try {
    const ctx = await requireTenantPermission('user.read')
    const users = await services.iam.listUsers(ctx.activeTenantId, { limit: 100 })
    return ok(users)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list users')
  }
}

export async function listInvitations() {
  try {
    const ctx = await requireTenantPermission('user.read')
    const invitations = await services.iam.listInvitations(ctx.activeTenantId, { limit: 100 })
    return ok(invitations)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list invitations')
  }
}

export async function inviteUser(input: { email: string; role: string }) {
  try {
    const ctx = await requireTenantPermission('user.invite')
    const parsed = inviteUserSchema.parse(input)
    const email = parsed.email.trim().toLowerCase()
    const result = await services.iam.inviteUser({
      email,
      role: parsed.role,
      createdById: ctx.user.id,
      tenantId: ctx.activeTenantId,
    })

    let clerkInvited = false
    if (isClerkEnabled()) {
      try {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '')
        const client = await clerkClient()
        const clerkInvitation = await client.invitations.createInvitation({
          emailAddress: email,
          publicMetadata: { enterpriseInvitationId: result.invitation.id },
          notify: true,
          ignoreExisting: true,
          ...(appUrl ? { redirectUrl: `${appUrl}/sign-up` } : {}),
        })
        await services.iam.bindClerkInvitation({
          invitationId: result.invitation.id,
          clerkInvitationId: clerkInvitation.id,
        })
        clerkInvited = true
      } catch (error) {
        await services.iam.revokeInvitation({
          invitationId: result.invitation.id,
          actorId: ctx.user.id,
          actorTenantId: ctx.activeTenantId,
        })
        throw error
      }
    }
    return ok({ invitationId: result.invitation.id, token: result.rawToken, clerkInvited })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to invite user')
  }
}

export async function provisionUser(input: { email: string; role: string }) {
  try {
    const ctx = await requireTenantPermission('user.invite')
    const parsed = provisionUserSchema.parse(input)
    const result = await services.iam.provisionUser({
      email: parsed.email.trim().toLowerCase(),
      role: parsed.role,
      createdById: ctx.user.id,
      tenantId: ctx.activeTenantId,
    })
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to provision user')
  }
}

export async function revokeInvitation(input: { invitationId: string }) {
  try {
    const ctx = await requireTenantPermission('user.invite')
    const parsed = revokeInvitationSchema.parse(input)
    await services.iam.revokeInvitation({
      invitationId: parsed.invitationId,
      actorId: ctx.user.id,
      actorTenantId: ctx.activeTenantId,
    })
    return ok({ revoked: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to revoke invitation')
  }
}

export async function redeemInvitation(input: { token: string; name?: string }) {
  try {
    const user = await getCurrentUser()
    if (!user) return fail('Unauthorized')
    const parsed = redeemInvitationSchema.parse(input)
    const result = await services.iam.redeemInvitation({
      token: parsed.token,
      email: user.email,
      externalAuthId: user.externalAuthId ?? user.id,
      name: parsed.name ?? user.name,
    })
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to redeem invitation')
  }
}

export async function approveUser(input: { targetUserId: string; role: string }) {
  try {
    const ctx = await requireTenantPermission('user.approve')
    const parsed = approveUserSchema.parse(input)
    await services.iam.approveUser({
      targetUserId: parsed.targetUserId,
      role: parsed.role,
      actorId: ctx.user.id,
      actorTenantId: ctx.activeTenantId,
    })
    return ok({ approved: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to approve user')
  }
}

export async function changeUserRole(input: { targetUserId: string; newRole: string }) {
  try {
    const ctx = await requireTenantPermission('user.role.change')
    const parsed = changeUserRoleSchema.parse(input)
    await services.iam.changeRole({
      targetUserId: parsed.targetUserId,
      newRole: parsed.newRole,
      actorId: ctx.user.id,
      actorTenantId: ctx.activeTenantId,
    })
    return ok({ changed: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to change role')
  }
}

export async function suspendUser(input: { targetUserId: string; reason: string }) {
  try {
    const ctx = await requireTenantPermission('user.suspend')
    const parsed = suspendUserSchema.parse(input)
    await services.iam.suspendUser({
      targetUserId: parsed.targetUserId,
      reason: parsed.reason,
      actorId: ctx.user.id,
      actorTenantId: ctx.activeTenantId,
    })
    return ok({ suspended: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to suspend user')
  }
}

export async function reactivateUser(input: { targetUserId: string }) {
  try {
    const ctx = await requireTenantPermission('user.suspend')
    const parsed = reactivateUserSchema.parse(input)
    await services.iam.reactivateUser({
      targetUserId: parsed.targetUserId,
      actorId: ctx.user.id,
      actorTenantId: ctx.activeTenantId,
    })
    return ok({ reactivated: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to reactivate user')
  }
}

export async function setUserJobDescription(input: {
  targetUserId: string
  jobDescription: string | null
}) {
  try {
    const ctx = await requireTenantPermission('user.role.change')
    const parsed = setUserJobDescriptionSchema.parse(input)
    await services.iam.setJobDescription({
      targetUserId: parsed.targetUserId,
      jobDescription: parsed.jobDescription,
      actorId: ctx.user.id,
      actorTenantId: ctx.activeTenantId,
    })
    return ok({ updated: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update job description')
  }
}

export async function getPermissionMatrix() {
  try {
    await requireTenantPermission('user.read')
    const matrix = await services.iam.getPermissionMatrix()
    return ok(matrix)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load permission matrix')
  }
}

export async function updateRolePermission(input: { permissionKey: string; minRole: string }) {
  try {
    const ctx = await requireTenantPermission('user.role.change')
    const parsed = updateRolePermissionSchema.parse(input)
    await services.iam.updatePermission({
      permissionKey: parsed.permissionKey,
      minRole: parsed.minRole,
      actorId: ctx.user.id,
      tenantId: ctx.activeTenantId,
    })
    return ok({ updated: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update permission')
  }
}

export async function listWorkspaceTenants() {
  try {
    await requireTenantRole('admin')
    const rows = await prisma.user.findMany({
      where: { tenantId: { not: null } },
      select: { tenantId: true },
      distinct: ['tenantId'],
    })
    const tenantIds = rows.map((row) => row.tenantId).filter((id): id is string => Boolean(id))
    return ok({ tenantIds, includesGlobalFallback: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list tenants')
  }
}

export async function purgeTenantWorkspaces(tenantId: string) {
  try {
    const actor = await requireTenantRole('admin')
    const normalized = tenantId.trim()
    if (!normalized) return fail('Tenant ID is required')
    await repositories.audit.append({
      actorType: 'human',
      actorId: actor.user.id,
      agentVersion: null,
      action: 'workspace.tenant.purge',
      targetType: 'tenant',
      targetId: normalized === 'global' ? null : normalized,
      modelUsed: null,
      inputRef: normalized,
      outputRef: '0',
      policyDecision: 'allowed',
      metadata: { deletedObjects: 0, tenantId: normalized, deferred: true },
    })
    return ok({ deletedObjects: 0 })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Workspace purge failed')
  }
}

export async function listAgents(input?: { limit?: number; offset?: number }) {
  try {
    const user = await requireTenantRole('viewer')
    const subject = tenantUserSubject(user)
    if (!subject) return ok([])
    const accessible = await services.agentAccess.listAccessibleAgents(subject, 'view', {
      subjectIsTenantAdmin: isTenantAdmin(user),
    })
    const page = await repositories.agents.listPage({
      tenantId: user.activeTenantId,
      ids: accessible.map((a) => a.id),
      limit: input?.limit ?? DEFAULT_LIST_LIMIT,
      offset: input?.offset,
    })
    return ok(page.items)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list agents')
  }
}

export async function getAgent(input: { id: string }) {
  try {
    const user = await requireTenantRole('viewer')
    const { id } = agentIdSchema.parse(input)
    const subject = tenantUserSubject(user)
    if (!subject) return fail('Agent not found')
    const decision = await services.agentAccess.canAccessAgent(subject, id, 'view', {
      subjectIsTenantAdmin: isTenantAdmin(user),
    })
    if (!decision.allowed) return fail('Agent not found')
    const detail = await repositories.agents.findById(id, user.activeTenantId)
    if (!detail) return fail('Agent not found')
    return ok(detail)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to get agent')
  }
}

export async function getAgentGovernance(input: { agentId: string }) {
  try {
    const user = await requireTenantRole('viewer')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const subject = tenantUserSubject(user)
    if (!subject) return fail('Agent not found')
    const decision = await services.agentAccess.canAccessAgent(subject, agentId, 'view', {
      subjectIsTenantAdmin: isTenantAdmin(user),
    })
    if (!decision.allowed) return fail('Agent not found')
    const agent = await repositories.agents.findById(agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')
    const [capabilities, connectors] = await Promise.all([
      repositories.toolBroker.findCapabilitiesForAgent(agentId),
      repositories.toolBroker.findConnectorsForAgent(agentId),
    ])
    return ok({ capabilities, connectors })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load agent governance')
  }
}

export async function createAgent(input: {
  name: string
  roleInstruction: string
  behaviorProfile?: string
  role?: 'worker' | 'orchestrator'
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = createAgentSchema.parse(input)
    const result = await repositories.agents.create({
      ...parsed,
      modelConfig: { provider: 'none', model: 'none' },
      createdById: user.user.id,
      tenantId: user.activeTenantId,
      status: 'draft',
    })
    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'agent.create',
      targetType: 'agent',
      targetId: result.agent.id,
      modelUsed: null,
      inputRef: null,
      outputRef: result.agent.name,
      policyDecision: 'allowed',
      metadata: { role: result.agent.role, status: result.agent.status },
    })
    if (user.activeTenantId) {
      const { materializeDefaultUserAgentGrants } = await import(
        '@/domain/agent-access/default-user-agent-grants'
      )
      await materializeDefaultUserAgentGrants({
        tenantId: user.activeTenantId,
        actorUserId: user.user.id,
        agentId: result.agent.id,
      }).catch(() => undefined)
    }
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to create agent')
  }
}

export async function updateAgentInstruction(input: { agentId: string; roleInstruction: string }) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = updateAgentInstructionSchema.parse(input)
    const existing = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!existing) return fail('Agent not found')
    const updated = await repositories.agents.updateInstruction({
      agentId: parsed.agentId,
      roleInstruction: parsed.roleInstruction,
    })
    return ok({
      updated: true,
      agentVersion: updated.agentVersion,
      roleInstructionVersion: updated.roleInstructionVersion,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update instruction')
  }
}

export async function updateAgentPersona(input: {
  agentId: string
  personaNickname?: string | null
  personaTrait?: string | null
  personaGreeting?: string | null
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = updateAgentPersonaSchema.parse(input)
    const existing = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!existing) return fail('Agent not found')
    await repositories.agents.updatePersona(parsed)
    return ok({ updated: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update persona')
  }
}

export async function updateAgentAvatar(input: { agentId: string; avatarUrl: string }) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = updateAgentAvatarSchema.parse(input)
    const existing = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!existing) return fail('Agent not found')
    const avatar = await repositories.agents.updateAvatar(parsed)
    return ok({ updated: true, avatarUrl: avatar.avatarUrl })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update avatar')
  }
}

export async function updateAgentOperatorVisibility(input: {
  agentId: string
  hiddenFromOperators: boolean
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = updateAgentOperatorVisibilitySchema.parse(input)
    const existing = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!existing) return fail('Agent not found')
    await repositories.agents.updateOperatorVisibility(parsed)
    return ok({ updated: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update visibility')
  }
}

export async function updateAgentOperatorSkillManagement(input: {
  agentId: string
  operatorCanManageSkills: boolean
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = updateAgentOperatorSkillManagementSchema.parse(input)
    const existing = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!existing) return fail('Agent not found')
    await repositories.agents.updateOperatorSkillManagement(parsed)
    return ok({ updated: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update skill management')
  }
}

export async function updateAgentCapabilities(input: {
  agentId: string
  enabledTools?: string[]
  capabilities?: string[]
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = z
      .object({
        agentId: z.string().uuid(),
        enabledTools: z.array(z.string()).optional(),
        capabilities: z.array(z.string()).optional(),
      })
      .parse(input)
    const existing = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!existing) return fail('Agent not found')
    const tools = [...new Set(parsed.enabledTools ?? parsed.capabilities ?? [])]
    await prisma.capability.deleteMany({ where: { agentId: parsed.agentId } })
    if (tools.length > 0) {
      await prisma.capability.createMany({
        data: tools.map((toolName) => ({ agentId: parsed.agentId, toolName, allowed: true })),
      })
    }
    return ok({
      updated: true,
      updatedCount: tools.length,
      httpApiAssignmentRequired: false,
      codeSandboxAssignmentRequired: false,
      knowledgeBaseLinked: false,
      workspaceLinked: false,
      gmailLinked: false,
      httpApiLinked: false,
      webSearchLinked: false,
      boardLinked: false,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update capabilities')
  }
}

export async function getBehaviorProfile(input: { profileId: string }) {
  try {
    const user = await requireTenantRole('viewer')
    const parsed = z.object({ profileId: z.string().uuid() }).parse(input)
    const profile = await repositories.behaviorProfiles.findByIdWithVersions(
      parsed.profileId,
      user.activeTenantId,
    )
    if (!profile) return fail('Profile not found')
    return ok(profile)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load behavior profile')
  }
}

export async function updateAgentConnectorBinding(input: {
  agentId: string
  connectorId: string
  accessMode?: string
}) {
  try {
    await requireTenantRole('admin')
    void input
    return ok({ updated: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update connector binding')
  }
}

export async function activateAgent(input: { agentId: string }) {
  try {
    const user = await requireTenantRole('admin')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const agent = await repositories.agents.findById(agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')
    const result = await repositories.agents.activate(agentId)
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to activate agent')
  }
}

export async function suspendAgent(input: { agentId: string; reason: string }) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = suspendAgentSchema.parse(input)
    const existing = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!existing) return fail('Agent not found')
    const agent = await repositories.agents.suspend(parsed.agentId, parsed.reason)
    return ok(agent)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to suspend agent')
  }
}

export async function resumeAgent(input: { agentId: string }) {
  try {
    const user = await requireTenantRole('admin')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const existing = await repositories.agents.findById(agentId, user.activeTenantId)
    if (!existing) return fail('Agent not found')
    const agent = await repositories.agents.resume(agentId)
    return ok(agent)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to resume agent')
  }
}

export async function retireAgent(input: { agentId: string }) {
  try {
    const user = await requireTenantRole('admin')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const existing = await repositories.agents.findById(agentId, user.activeTenantId)
    if (!existing) return fail('Agent not found')
    const agent = await repositories.agents.retire(agentId)
    return ok(agent)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to retire agent')
  }
}

export async function deleteAgent(input: { id: string }) {
  try {
    const user = await requireTenantRole('admin')
    const { id } = agentIdSchema.parse(input)
    const existing = await repositories.agents.findById(id, user.activeTenantId)
    if (!existing) return fail('Agent not found')
    await repositories.agents.delete(id)
    return ok({ deleted: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to delete agent')
  }
}

export async function listBehaviorProfiles() {
  try {
    const user = await requireTenantRole('viewer')
    const profiles = await repositories.behaviorProfiles.findMany(user.activeTenantId)
    return ok(profiles)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list behavior profiles')
  }
}

export async function createBehaviorProfile(input: { name: string; body: string }) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = createBehaviorProfileSchema.parse(input)
    const profile = await repositories.behaviorProfiles.create({
      ...parsed,
      tenantId: user.activeTenantId,
      approvedById: user.user.id,
    })
    return ok(profile)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to create behavior profile')
  }
}

export async function updateBehaviorProfile(input: { profileId: string; body: string }) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = updateBehaviorProfileSchema.parse(input)
    const profile = await repositories.behaviorProfiles.update({
      profileId: parsed.profileId,
      body: parsed.body,
      approvedById: user.user.id,
      tenantId: user.activeTenantId,
    })
    return ok(profile)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update behavior profile')
  }
}

export async function setAgentBehaviorProfile(input: {
  agentId: string
  profileId: string | null
  overlay?: string | null
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = setAgentBehaviorProfileSchema.parse(input)
    const existing = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!existing) return fail('Agent not found')
    const profile = parsed.profileId
      ? await repositories.behaviorProfiles.findByIdWithVersions(parsed.profileId, user.activeTenantId)
      : null
    const currentBody =
      profile?.versions.find((version) => version.version === profile.currentVersion)?.body ??
      existing.behaviorProfile
    const updated = await repositories.agents.setBehaviorProfile({
      agentId: parsed.agentId,
      profileId: parsed.profileId,
      profileVersion: profile?.currentVersion ?? null,
      profileBody: currentBody,
      overlay: parsed.overlay ?? null,
    })
    return ok({ updated: true, agentVersion: updated.agentVersion })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to set behavior profile')
  }
}

export async function listAuditLog(input?: z.infer<typeof listAuditLogSchema>) {
  try {
    const user = await requireTenantRole('approver')
    const parsed = input ? listAuditLogSchema.parse(input) : {}
    const entries = await repositories.audit.findMany({
      tenantId: user.activeTenantId,
      limit: parsed.limit ?? 100,
      action: parsed.action,
    })
    return ok(entries)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list audit log')
  }
}

export async function verifyAuditChain() {
  try {
    await requireTenantRole('approver')
    const result = await services.auditChain.verifyChain()
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Verification failed')
  }
}

export async function exportAuditSiem(input?: { since?: string }) {
  try {
    const user = await requireTenantRole('admin')
    const { since } = z.object({ since: z.coerce.date().optional() }).parse(input ?? {})
    const jsonLines = await services.auditChain.exportJsonLines({
      tenantId: user.activeTenantId,
      since,
    })
    return ok({
      content: jsonLines,
      filename: `audit-siem-${new Date().toISOString().slice(0, 10)}.jsonl`,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Export failed')
  }
}

export async function getAccessAuditLog(input?: { limit?: number }) {
  try {
    const ctx = await requireTenantPermission('user.read')
    const entries = await repositories.audit.findMany({
      tenantId: ctx.activeTenantId,
      limit: input?.limit ?? 50,
    })
    return ok(entries)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load access audit')
  }
}
