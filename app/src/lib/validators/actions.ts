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

export const updateAgentMemoryWriteModeSchema = z.object({
  agentId: z.string().uuid(),
  memoryWriteMode: z.enum(['approval', 'direct']),
})

export const updateAgentProfileSchema = z
  .object({
    agentId: z.string().uuid(),
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: 'Nincs változás',
  })

export const setAgentUserAccessSchema = z.object({
  agentId: z.string().uuid(),
  userId: z.string().uuid(),
  accessLevel: z.enum(['view', 'operate', 'none']),
})

export const updateAgentAvatarSchema = z.object({
  agentId: z.string().uuid(),
  avatarUrl: z.string().trim().max(2000),
})

export const suspendAgentSchema = z.object({
  agentId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
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

export const updateRolePermissionSchema = z.object({
  permissionKey: z.string().trim().min(1),
  minRole: userRoleSchema,
})

export const setUserAgentAccessSchema = z.object({
  targetUserId: z.string().uuid(),
  agentId: z.string().uuid(),
  granted: z.boolean(),
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

export const setTenantMcpIntroSchema = z.object({
  mcpIntro: z.string().max(4000),
})
