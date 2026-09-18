import { z } from 'zod'
import type { UserRole } from '@prisma/client'

const userRoleSchema = z.enum(['viewer', 'operator', 'approver', 'admin']) satisfies z.ZodType<UserRole>

export const agentIdSchema = z.object({ id: z.string().uuid() })

export const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  roleInstruction: z.string().trim().min(1).max(20_000),
})

export const updateAgentInstructionSchema = z.object({
  agentId: z.string().uuid(),
  roleInstruction: z.string().trim().min(1).max(20_000),
})

export const updateAgentPersonaSchema = z.object({
  agentId: z.string().uuid(),
  personaNickname: z.string().trim().max(80).nullable().optional(),
  personaTrait: z.string().trim().max(200).nullable().optional(),
  personaGreeting: z.string().trim().max(400).nullable().optional(),
})

export const updateAgentAvatarSchema = z.object({
  agentId: z.string().uuid(),
  avatarUrl: z.string().trim().max(2000),
})

export const updateAgentOperatorVisibilitySchema = z.object({
  agentId: z.string().uuid(),
  hiddenFromOperators: z.boolean(),
})

export const updateAgentOperatorSkillManagementSchema = z.object({
  agentId: z.string().uuid(),
  operatorCanManageSkills: z.boolean(),
})

export const suspendAgentSchema = z.object({
  agentId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
})

export const listAuditLogSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  action: z.string().trim().max(200).optional(),
})

export const inviteUserSchema = z.object({
  email: z.string().email(),
  role: userRoleSchema,
})

export const provisionUserSchema = inviteUserSchema

export const redeemInvitationSchema = z.object({
  token: z.string().trim().min(1),
  name: z.string().trim().max(120).optional(),
})

export const revokeInvitationSchema = z.object({
  invitationId: z.string().uuid(),
})

export const approveUserSchema = z.object({
  targetUserId: z.string().uuid(),
  role: userRoleSchema,
})

export const changeUserRoleSchema = z.object({
  targetUserId: z.string().uuid(),
  newRole: userRoleSchema,
})

export const suspendUserSchema = z.object({
  targetUserId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
})

export const reactivateUserSchema = z.object({
  targetUserId: z.string().uuid(),
})

export const setUserJobDescriptionSchema = z.object({
  targetUserId: z.string().uuid(),
  jobDescription: z.string().trim().max(4000).nullable(),
})

export const updateRolePermissionSchema = z.object({
  permissionKey: z.string().trim().min(1),
  minRole: userRoleSchema,
})

export const connectorGrantIdSchema = z.object({
  grantId: z.string().uuid(),
})

export const startConnectorOAuthSchema = z.object({
  connectorId: z.string().uuid(),
  scopes: z.array(z.string()).optional(),
  toolName: z.string().optional(),
  returnTo: z
    .object({
      kind: z.enum(['conversation', 'ticket']),
      id: z.string(),
      agentId: z.string().optional(),
      originPath: z.string().optional(),
    })
    .optional(),
})

export const createBehaviorProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(20_000),
})

export const updateBehaviorProfileSchema = z.object({
  profileId: z.string().uuid(),
  body: z.string().trim().min(1).max(20_000),
})

export const behaviorProfileIdSchema = z.object({
  profileId: z.string().uuid(),
})

export const setAgentBehaviorProfileSchema = z.object({
  agentId: z.string().uuid(),
  profileId: z.string().uuid().nullable(),
  overlay: z.string().nullable().optional(),
})

const navVisibilityKeyList = z.array(z.string().min(1).max(120)).max(200)

export const setNavVisibilitySchema = z.object({
  policy: z.object({
    viewer: navVisibilityKeyList,
    operator: navVisibilityKeyList,
    approver: navVisibilityKeyList,
    admin: navVisibilityKeyList,
  }),
})

export const setTenantLanguageSchema = z.object({
  language: z.enum(['hu', 'en']),
})
