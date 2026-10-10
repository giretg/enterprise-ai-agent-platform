import { z } from 'zod'
import type { UserRole } from '@prisma/client'

const userRoleSchema = z.enum(['viewer', 'operator', 'approver', 'admin']) satisfies z.ZodType<UserRole>

export const agentIdSchema = z.object({ id: z.string().uuid() })

export const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  roleInstruction: z.string().trim().min(1).max(20_000),
  description: z.string().trim().min(1).max(500),
})

export const updateAgentInstructionSchema = z.object({
  agentId: z.string().uuid(),
  roleInstruction: z.string().trim().min(1).max(20_000),
})

export const updateAgentMemoryWriteModeSchema = z.object({
  agentId: z.string().uuid(),
  memoryWriteMode: z.enum(['approval', 'direct']),
})

export const updateAgentWriteApprovalModesSchema = z.object({
  agentId: z.string().uuid(),
  memoryWriteMode: z.enum(['approval', 'direct']),
  httpApiWriteMode: z.enum(['approval', 'direct']),
  gmailWriteMode: z.enum(['approval', 'direct']),
  driveWriteMode: z.enum(['approval', 'direct']),
  approverUserId: z.string().uuid().nullable().optional(),
})

export const updateAgentOutputFolderSchema = z.object({
  agentId: z.string().uuid(),
  /** Drive mappa-id; üres string = törlés. */
  folderId: z.string().trim().max(200),
})

export const updateAgentLocalRootsSchema = z.object({
  agentId: z.string().uuid(),
  /** Soronként egy path; üres = törlés. */
  localRoots: z.string().max(4200),
})

export const updateAgentApproverSchema = z.object({
  agentId: z.string().uuid(),
  /** Tenant-tag user-id; null = megnevezett jóváhagyó törlése. */
  approverUserId: z.string().uuid().nullable(),
})

export const updateConnectorApproverSchema = z.object({
  connectorId: z.string().uuid(),
  /** Tenant-tag user-id; null = megnevezett jóváhagyó törlése. */
  approverUserId: z.string().uuid().nullable(),
})

export const updateAgentProfileSchema = z
  .object({
    agentId: z.string().uuid(),
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).max(500).optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: 'Nincs változás',
  })

export const setAgentUserAccessSchema = z.object({
  agentId: z.string().uuid(),
  userId: z.string().uuid(),
  accessLevel: z.enum(['view', 'operate', 'none']),
})

/** 256px webp/jpeg data URL felső korlátja (a feltöltő ennyire kicsinyít). */
export const AGENT_AVATAR_MAX_CHARS = 160_000

function isAllowedAgentAvatar(value: string): boolean {
  if (value === '') return true
  if (/^data:image\/(webp|jpeg|png);base64,/.test(value)) return true
  if (value.startsWith('https://') && value.length <= 2000) return true
  return false
}

export const updateAgentAvatarSchema = z.object({
  agentId: z.string().uuid(),
  avatarUrl: z.string().trim().max(AGENT_AVATAR_MAX_CHARS).refine(isAllowedAgentAvatar, 'invalid_avatar'),
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
  nickname: z.string().max(40).optional(),
  addAccount: z.boolean().optional(),
  returnTo: z
    .object({
      kind: z.enum(['conversation', 'ticket']),
      id: z.string(),
      agentId: z.string().optional(),
      originPath: z.string().optional(),
    })
    .optional(),
})

export const updateConnectorGrantNicknameSchema = z.object({
  grantId: z.string().uuid(),
  nickname: z.string().max(40).nullable(),
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

/** #717: KB-nyelv űrlap-határ (a `KB_LANGUAGE_REGISTRY` kulcsaival egyezik — unit-teszt őrzi). */
export const KB_LANGUAGE_VALUES = ['hu', 'en'] as const

export const setKbLanguageSchema = z.object({
  kbLanguage: z.enum(KB_LANGUAGE_VALUES),
})

export const setKbDocumentLanguageSchema = z.object({
  documentId: z.string().uuid(),
  /** `null` = öröklés a tudástár nyelvéről. */
  kbLanguageOverride: z.enum(KB_LANGUAGE_VALUES).nullable(),
})

export const setTenantMcpIntroSchema = z.object({
  mcpIntro: z.string().max(4000),
})
