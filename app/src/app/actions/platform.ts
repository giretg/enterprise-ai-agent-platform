'use server'

import { z } from 'zod'
import { clerkClient } from '@clerk/nextjs/server'
import { getCurrentUser } from '@/auth'
import { requireTenantPermission, requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { repositories } from '@/repositories/postgres'
import { isClerkEnabled } from '@/lib/clerk-config'
import { fail, ok } from '@/lib/result'
import { canReadPublishedAgent, isPrivilegedAgentReader } from '@/domain/agent-definition'
import { isSuperadmin } from '@/lib/tenant-policy'
import type { ConnectorAccessMode } from '@prisma/client'
import { DEFAULT_LIST_LIMIT } from '@/lib/list-pagination'
import { ensureAgentKnowledgeBase, toolsNeedKnowledgeBase } from '@/lib/agent-knowledge-base'
import {
  agentIdSchema,
  approveUserSchema,
  changeUserRoleSchema,
  createAgentSchema,
  inviteUserSchema,
  provisionUserSchema,
  reactivateUserSchema,
  redeemInvitationSchema,
  revokeInvitationSchema,
  setAgentUserAccessSchema,
  setUserAgentAccessSchema,
  suspendAgentSchema,
  suspendUserSchema,
  updateAgentAvatarSchema,
  updateAgentInstructionSchema,
  updateAgentProfileSchema,
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

export async function listUserAgentAccess() {
  try {
    const ctx = await requireTenantPermission('user.read')
    const users = await services.iam.listUsers(ctx.activeTenantId, { limit: 100 })
    const entries = await Promise.all(
      users.map(async (user) => [
        user.id,
        await repositories.resourceGrants.listAgentIdsGrantedToUser({
          tenantId: ctx.activeTenantId,
          userId: user.id,
        }),
      ] as const),
    )
    return ok({ grantsByUserId: Object.fromEntries(entries) as Record<string, string[]> })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list agent access')
  }
}

export async function setUserAgentAccess(input: {
  targetUserId: string
  agentId: string
  granted: boolean
}) {
  try {
    const ctx = await requireTenantPermission('user.role.write')
    const parsed = setUserAgentAccessSchema.parse(input)
    // Célpont és ügynök is a hívó tenantjába kell tartozzon (N-IAM-6) —
    // idegen tenantra "not found", nem szivárogtatunk létezést.
    const [membership, agent] = await Promise.all([
      repositories.tenantMemberships.findByTenantAndUser(ctx.activeTenantId, parsed.targetUserId),
      repositories.agents.findById(parsed.agentId, ctx.activeTenantId),
    ])
    if (!membership) return fail('user: not found')
    if (!agent) return fail('Agent not found')
    if (parsed.granted) {
      await repositories.resourceGrants.upsertAgentGrant({
        tenantId: ctx.activeTenantId,
        userId: parsed.targetUserId,
        agentId: parsed.agentId,
        accessLevel: 'operate',
        grantedById: ctx.user.id,
      })
    } else {
      await repositories.resourceGrants.revokeAgentGrant({
        tenantId: ctx.activeTenantId,
        userId: parsed.targetUserId,
        agentId: parsed.agentId,
      })
    }
    await services.iam.auditUserAgentAccessUpdate({
      actorId: ctx.user.id,
      tenantId: ctx.activeTenantId,
      targetUserId: parsed.targetUserId,
      agentId: parsed.agentId,
      granted: parsed.granted,
    })
    return ok({ updated: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update agent access')
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
    const ctx = await requireTenantPermission('user.role.write')
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
    const ctx = await requireTenantPermission('user.role.write')
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
    const tenants = await repositories.tenants.findMany()
    return ok({ tenantIds: tenants.map((row) => row.id), includesGlobalFallback: false })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list tenants')
  }
}

export async function purgeTenantWorkspaces(tenantId: string) {
  try {
    await requireTenantRole('admin')
    const normalized = tenantId.trim()
    if (!normalized) return fail('Tenant ID is required')
    return ok({ deletedObjects: 0 })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Workspace purge failed')
  }
}

async function readableAgent(user: {
  user: { id: string }
  activeTenantId: string
  activeTenantRole: import('@prisma/client').UserRole
}, agentId: string) {
  const agent = await repositories.agents.findById(agentId, user.activeTenantId)
  if (!agent) return null
  const grant = await repositories.resourceGrants.findAgentGrant({
    tenantId: user.activeTenantId,
    userId: user.user.id,
    agentId,
  })
  return canReadPublishedAgent({ role: user.activeTenantRole, grant }) ? agent : null
}

export async function listAgents(input?: { limit?: number; offset?: number }) {
  try {
    const user = await requireTenantRole('viewer')
    if (!user.activeTenantId) return ok([])
    if (isPrivilegedAgentReader(user.activeTenantRole)) {
      const page = await repositories.agents.listPage({
        tenantId: user.activeTenantId,
        limit: input?.limit ?? DEFAULT_LIST_LIMIT,
        offset: input?.offset,
      })
      return ok(page.items)
    }
    const ids = await repositories.resourceGrants.listAgentIdsGrantedToUser({
      tenantId: user.activeTenantId,
      userId: user.user.id,
    })
    const page = await repositories.agents.listPage({
      tenantId: user.activeTenantId,
      ids,
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
    const agent = await readableAgent(user, id)
    if (!agent) return fail('Agent not found')
    return ok(agent)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to get agent')
  }
}

export async function getAgentGovernance(input: { agentId: string }) {
  try {
    const user = await requireTenantRole('viewer')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const agent = await readableAgent(user, agentId)
    if (!agent) return fail('Agent not found')
    const [capabilities, connectors] = await Promise.all([
      repositories.agents.findCapabilitiesForAgent(agentId),
      repositories.agents.findConnectorsForAgent(agentId),
    ])
    return ok({ capabilities, connectors })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load agent governance')
  }
}

export async function createAgent(input: { name: string; roleInstruction: string }) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = createAgentSchema.parse(input)
    if (!user.activeTenantId) return fail('Tenant required')
    const agent = await repositories.agents.create({
      name: parsed.name,
      roleInstruction: parsed.roleInstruction,
      tenantId: user.activeTenantId,
      status: 'draft',
    })
    await services.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'agent.create',
      targetType: 'agent',
      targetId: agent.id,
      modelUsed: null,
      inputRef: parsed.name,
      outputRef: 'draft',
      policyDecision: 'created',
      metadata: { name: parsed.name },
      tenantId: user.activeTenantId,
    })
    return ok({ agent })
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
    return ok({ updated: true, roleInstruction: updated.roleInstruction })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update instruction')
  }
}

export async function updateAgentProfile(input: { agentId: string; name?: string; description?: string }) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = updateAgentProfileSchema.parse(input)
    const existing = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!existing) return fail('Agent not found')
    const updated = await repositories.agents.updateProfile({
      agentId: parsed.agentId,
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.description !== undefined
        ? { description: parsed.description.length > 0 ? parsed.description : null }
        : {}),
    })
    await services.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'agent.profile',
      targetType: 'agent',
      targetId: updated.id,
      modelUsed: null,
      inputRef: existing.name,
      outputRef: updated.name,
      policyDecision: 'updated',
      metadata: {
        nameChanged: existing.name !== updated.name,
        descriptionChanged: (existing.description ?? null) !== (updated.description ?? null),
      },
      tenantId: user.activeTenantId,
    })
    return ok({ updated: true, name: updated.name, description: updated.description })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update profile')
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
    await repositories.agents.replaceCapabilities(parsed.agentId, tools)
    if (toolsNeedKnowledgeBase(tools) && user.activeTenantId) {
      await ensureAgentKnowledgeBase(existing, {
        connectors: repositories.connectors,
        agents: repositories.agents,
      })
    }
    return ok({ updated: true, updatedCount: tools.length })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update capabilities')
  }
}

export async function updateAgentConnectorBinding(input: {
  agentId: string
  connectorId: string
  accessMode?: string
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = z
      .object({
        agentId: z.string().uuid(),
        connectorId: z.string().uuid(),
        accessMode: z.enum(['read', 'write']).optional(),
      })
      .parse(input)
    const existing = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!existing) return fail('Agent not found')
    await repositories.agents.upsertConnectorBinding({
      agentId: parsed.agentId,
      connectorId: parsed.connectorId,
      accessMode: (parsed.accessMode ?? 'read') as ConnectorAccessMode,
    })
    return ok({ updated: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update connector binding')
  }
}

export async function publishAgentDefinitionAction(input: { agentId: string }) {
  try {
    const user = await requireTenantRole('admin')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    if (!user.activeTenantId) return fail('Tenant required')
    const existing = await repositories.agents.findById(agentId, user.activeTenantId)
    if (!existing) return fail('Agent not found')
    const definition = await services.agentDefinitions.publishAgentDefinition({
      agentId,
      tenantId: user.activeTenantId,
      publishedById: user.user.id,
    })
    return ok(definition)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to publish agent definition')
  }
}

export async function getAgentPublishStatus(input: { agentId: string }) {
  try {
    const user = await requireTenantRole('viewer')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    if (!user.activeTenantId) return fail('Tenant required')
    const status = await services.agentDefinitions.getPublishStatus({
      agentId,
      tenantId: user.activeTenantId,
    })
    return ok(status)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load publish status')
  }
}

export async function activateAgent(input: { agentId: string }) {
  try {
    const user = await requireTenantRole('admin')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    if (!user.activeTenantId) return fail('Tenant required')
    const agent = await repositories.agents.findById(agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')
    const result = await services.agentDefinitions.activateAgent({
      agentId,
      tenantId: user.activeTenantId,
      actorId: user.user.id,
    })
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
    const force = isSuperadmin(user.platformRoles)
    await repositories.agents.delete(id, { force })
    await services.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'agent.delete',
      targetType: 'agent',
      targetId: id,
      modelUsed: null,
      inputRef: existing.name,
      outputRef: existing.status,
      policyDecision: 'deleted',
      metadata: { force },
      tenantId: user.activeTenantId,
    })
    return ok({ deleted: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to delete agent'
    if (/foreign key|P2003/i.test(message)) {
      return fail('Nem törölhető, mert már van hozzá MCP-művelet. Kapcsold ki a Használhatót.')
    }
    return fail(message)
  }
}

function formPurpose(formData: FormData): string | null {
  const value = formData.get('purpose')
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export async function listKbDocuments(input: { agentId: string }) {
  try {
    const user = await requireTenantRole('viewer')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const docs = await services.knowledgeBase.listDocuments({
      tenantId: user.activeTenantId,
      agentId,
    })
    return ok(docs)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list knowledge base documents')
  }
}

export async function ingestKbDocument(formData: FormData) {
  try {
    const user = await requireTenantRole('admin')
    const agentId = agentIdSchema.parse({ id: String(formData.get('agentId') ?? '') }).id
    const processingMode = formData.get('processingMode') === 'okf' ? 'okf' : 'raw_text_only'
    const purpose = formPurpose(formData)
    const file = formData.get('file')
    if (!(file instanceof File) || file.size === 0) return fail('Válassz egy fájlt')
    const buffer = Buffer.from(await file.arrayBuffer())
    const result = await services.knowledgeBase.ingest({
      tenantId: user.activeTenantId,
      agentId,
      uploadedById: user.user.id,
      filename: file.name,
      mimeType: file.type || null,
      buffer,
      processingMode,
      purpose,
    })
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to ingest document')
  }
}

export async function deleteKbDocument(input: { agentId: string; documentId: string }) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = z
      .object({ agentId: z.string().uuid(), documentId: z.string().uuid() })
      .parse(input)
    await services.knowledgeBase.deleteDocument({
      tenantId: user.activeTenantId,
      agentId: parsed.agentId,
      documentId: parsed.documentId,
      actorId: user.user.id,
    })
    return ok({ deleted: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to delete document')
  }
}

/** Közös tudásbázis-katalógus: tenant-szintű tár, innen másolható az agenthez. */
export async function listKnowledgeCatalog() {
  try {
    const user = await requireTenantRole('viewer')
    const docs = await services.knowledgeBase.listCatalogDocuments({
      tenantId: user.activeTenantId,
    })
    return ok(docs)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list knowledge catalog')
  }
}

export async function ingestKnowledgeCatalogDocument(formData: FormData) {
  try {
    const user = await requireTenantRole('admin')
    const processingMode = formData.get('processingMode') === 'okf' ? 'okf' : 'raw_text_only'
    const purpose = formPurpose(formData)
    const file = formData.get('file')
    if (!(file instanceof File) || file.size === 0) return fail('Válassz egy fájlt')
    const buffer = Buffer.from(await file.arrayBuffer())
    const result = await services.knowledgeBase.ingestCatalog({
      tenantId: user.activeTenantId,
      uploadedById: user.user.id,
      filename: file.name,
      mimeType: file.type || null,
      buffer,
      processingMode,
      purpose,
    })
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to ingest catalog document')
  }
}

export async function deleteKnowledgeCatalogDocument(input: { documentId: string }) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = z.object({ documentId: z.string().uuid() }).parse(input)
    await services.knowledgeBase.deleteCatalogDocument({
      tenantId: user.activeTenantId,
      documentId: parsed.documentId,
      actorId: user.user.id,
    })
    return ok({ deleted: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to delete catalog document')
  }
}

export async function attachKnowledgeCatalogDocument(input: {
  agentId: string
  documentId: string
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = z
      .object({ agentId: z.string().uuid(), documentId: z.string().uuid() })
      .parse(input)
    const result = await services.knowledgeBase.attachCatalogDocumentToAgent({
      tenantId: user.activeTenantId,
      agentId: parsed.agentId,
      documentId: parsed.documentId,
      actorId: user.user.id,
    })
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to attach catalog document')
  }
}

/**
 * Kik használhatják az agentet: a tenant userei a grant-szintjükkel.
 * Admin/approver alapból hozzáfér (grant nélkül is), ezért a lista az
 * operátor/néző kör szűkítésére és bővítésére való.
 */
export async function listAgentAccess(input: { agentId: string }) {
  try {
    const user = await requireTenantRole('admin')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const agent = await repositories.agents.findById(agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')
    const [users, grants] = await Promise.all([
      services.iam.listUsers(user.activeTenantId, { unbounded: true }),
      repositories.resourceGrants.listAgentGrantsForAgent({
        tenantId: user.activeTenantId,
        agentId,
      }),
    ])
    const grantByUserId = new Map(grants.map((grant) => [grant.userId, grant.accessLevel]))
    return ok({
      users: users.map((member) => ({
        id: member.id,
        name: member.name,
        email: member.email,
        role: member.role,
        accessLevel: grantByUserId.get(member.id) ?? null,
      })),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list agent access')
  }
}

export async function setAgentUserAccess(input: {
  agentId: string
  userId: string
  accessLevel: 'view' | 'operate' | 'none'
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = setAgentUserAccessSchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')
    const members = await services.iam.listUsers(user.activeTenantId, { unbounded: true })
    const target = members.find((member) => member.id === parsed.userId)
    if (!target) return fail('A user nem tagja ennek a szervezetnek')
    if (parsed.accessLevel === 'none') {
      await repositories.resourceGrants.revokeAgentGrant({
        tenantId: user.activeTenantId,
        userId: parsed.userId,
        agentId: parsed.agentId,
      })
      await services.audit.append({
        actorType: 'human',
        actorId: user.user.id,
        agentVersion: null,
        action: 'agent.user.revoke',
        targetType: 'agent',
        targetId: parsed.agentId,
        modelUsed: null,
        inputRef: target.email,
        outputRef: 'none',
        policyDecision: 'revoked',
        metadata: { userId: parsed.userId },
        tenantId: user.activeTenantId,
      })
    } else {
      await repositories.resourceGrants.upsertAgentGrant({
        tenantId: user.activeTenantId,
        userId: parsed.userId,
        agentId: parsed.agentId,
        accessLevel: parsed.accessLevel,
        grantedById: user.user.id,
      })
      await services.audit.append({
        actorType: 'human',
        actorId: user.user.id,
        agentVersion: null,
        action: 'agent.user.grant',
        targetType: 'agent',
        targetId: parsed.agentId,
        modelUsed: null,
        inputRef: target.email,
        outputRef: parsed.accessLevel,
        policyDecision: 'granted',
        metadata: { userId: parsed.userId, accessLevel: parsed.accessLevel },
        tenantId: user.activeTenantId,
      })
    }
    return ok({ updated: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update agent access')
  }
}
