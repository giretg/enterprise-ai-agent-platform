import { z } from 'zod'

export const ticketFilterSchema = z.object({
  state: z
    .enum([
      'backlog',
      'ready',
      'approved',
      'in_progress',
      'awaiting_human',
      'needs_info',
      'done',
      'rejected',
    ])
    .optional(),
})

export const ticketIdSchema = z.object({
  id: z.string().uuid(),
})

export const scheduledTaskIdSchema = z.object({
  id: z.string().uuid(),
})

export const sandboxAppIdSchema = z.object({
  appId: z.string().uuid(),
})

export const createSandboxReportSchema = z.object({
  ticketId: z.string().uuid(),
})

// ── App Registry általános API (Feature-spec — App Registry §4) ─────────────

export const createSandboxAppSchema = z.object({
  name: z.string().trim().min(3).max(80),
  description: z.string().max(1000).optional(),
  sandboxId: z.string().uuid().optional(),
  criticality: z.enum(['L0', 'L1']).optional(),
  createdFromTicketId: z.string().uuid().optional(),
  createdFromConversationId: z.string().uuid().optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
})

export const upsertSandboxAppVersionSchema = z.object({
  appId: z.string().uuid(),
  html: z.string().min(1),
  changeSummary: z.string().trim().min(1).max(1000),
  activate: z.boolean().optional(),
  createdFromRunId: z.string().uuid().optional(),
})

export const listSandboxAppsSchema = z.object({
  sandboxId: z.string().uuid().optional(),
  createdByAgentId: z.string().uuid().optional(),
  status: z.enum(['draft', 'active', 'archived', 'blocked']).optional(),
  search: z.string().max(200).optional(),
  limit: z.number().int().positive().max(200).optional(),
  cursor: z.string().uuid().optional(),
})

export const getSandboxAppSchema = z.object({
  appId: z.string().uuid(),
})

export const sandboxAppPreviewUrlSchema = z.object({
  appId: z.string().uuid(),
  version: z.number().int().positive().optional(),
})

export const activateSandboxAppVersionSchema = z.object({
  appId: z.string().uuid(),
  version: z.number().int().positive(),
  reason: z.string().max(500).optional(),
})

export const archiveSandboxAppSchema = z.object({
  appId: z.string().uuid(),
})

export const listAuditLogSchema = z.object({
  limit: z.number().int().positive().max(500).optional(),
  action: z.union([z.string().max(128), z.array(z.string().max(128)).max(50)]).optional(),
  actorType: z.enum(['human', 'agent', 'system']).optional(),
  actorId: z.string().uuid().optional(),
  targetType: z.string().max(64).optional(),
  targetId: z.string().max(128).optional(),
  ticketId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  since: z.coerce.date().optional(),
})

export const transitionTicketSchema = z.object({
  id: z.string().uuid(),
  toState: z.enum([
    'backlog',
    'ready',
    'approved',
    'in_progress',
    'awaiting_human',
    'needs_info',
    'done',
    'rejected',
  ]),
  note: z.string().optional(),
})

export const ticketTransitionAllowedActorSchema = z.enum([
  'system',
  'agent',
  'approver',
  'operator',
  'admin',
  'system_or_operator',
  'creator_or_operator',
])

export const ticketTypeConfigSchema = z
  .object({
    type: z.enum(['interaction', 'training', 'monitor_alert']),
    allowedTransitions: z
      .array(
        z.object({
          from: z.enum([
            'backlog',
            'ready',
            'approved',
            'in_progress',
            'awaiting_human',
            'needs_info',
            'done',
            'rejected',
          ]),
          to: z.enum([
            'backlog',
            'ready',
            'approved',
            'in_progress',
            'awaiting_human',
            'needs_info',
            'done',
            'rejected',
          ]),
          allowed: ticketTransitionAllowedActorSchema,
        }),
      )
      .min(1)
      .max(40),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    for (const [index, rule] of value.allowedTransitions.entries()) {
      const key = `${rule.from}:${rule.to}`
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['allowedTransitions', index],
          message: 'Duplicate transition rule',
        })
      }
      seen.add(key)
    }
  })

export const addTicketCommentSchema = z.object({
  ticketId: z.string().uuid(),
  body: z.string().max(16 * 1024).optional().default(''),
  attachmentDocumentIds: z.array(z.string().uuid()).max(8).optional().default([]),
  handBackToAgent: z.boolean().optional().default(false),
})

export const listTicketCommentsSchema = z.object({
  ticketId: z.string().uuid(),
})

const modelProviderSchema = z.enum(['chatgpt-oauth', 'gemini', 'ollama', 'openrouter'])

export const modelPolicyEntrySchema = z.object({
  provider: modelProviderSchema,
  model: z.string().trim().min(1).max(200),
  enabled: z.boolean(),
  label: z.string().trim().max(120).optional(),
  description: z.string().trim().max(280).optional(),
})

export const createBoardTicketSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4000).optional(),
    assigneeType: z.enum(['human', 'agent']),
    assigneeId: z.string().uuid(),
    /** Ha true, a ticket ready marad, de a dispatcher nem indul — pl. workspace fájl feltöltés után. */
    deferDispatch: z.boolean().optional(),
  })
  .refine((args) => args.assigneeType !== 'agent' || args.assigneeId, {
    message: 'assigneeId is required when assigneeType is agent',
  })

export const processDocumentSchema = z.object({
  documentId: z.string().uuid(),
  agentId: z.string().uuid(),
})

export const processDocumentForWikiSchema = z.object({
  documentId: z.string().uuid(),
  agentId: z.string().uuid(),
})

export const requestKbDocumentSchema = z.object({
  documentId: z.string().uuid(),
  agentId: z.string().uuid(),
  processingMode: z.enum(['raw_text_only', 'okf']).optional(),
})

export const kbTicketSchema = z.object({
  ticketId: z.string().uuid(),
})

export const shareKnowledgeBaseSchema = z.object({
  agentId: z.string().uuid(),
  targetAgentId: z.string().uuid(),
})

export const deleteKbDocumentSchema = z.object({
  agentId: z.string().uuid(),
  documentId: z.string().uuid(),
})

export const kbArtifactReviewSchema = z.object({
  agentId: z.string().uuid(),
  documentId: z.string().uuid(),
})

export const askWikiSchema = z.object({
  agentId: z.string().uuid(),
  question: z.string().trim().min(1).max(2000),
  conversationId: z.string().uuid().optional(),
})

export const generateReportSchema = z.object({
  agentId: z.string().uuid(),
  templateId: z.string().trim().min(1).max(64),
})

export const sendAgentMessageSchema = z.object({
  agentId: z.string().uuid(),
  content: z.string().trim().max(8000).default(''),
  conversationId: z.string().uuid().optional(),
  attachmentDocumentIds: z.array(z.string().uuid()).max(8).optional(),
}).refine((v) => v.content.length > 0 || (v.attachmentDocumentIds?.length ?? 0) > 0, {
  message: 'Az üzenet vagy legalább egy csatolmány kötelező',
})

export const createAgentTaskTicketSchema = z.object({
  agentId: z.string().uuid(),
  content: z.string().trim().max(8000).default(''),
  conversationId: z.string().uuid().optional(),
  attachmentDocumentIds: z.array(z.string().uuid()).max(8).optional(),
  executeAfter: z
    .string()
    .datetime()
    .optional(),
  authorizeRunAs: z.boolean().optional(),
}).refine((v) => v.content.length > 0 || (v.attachmentDocumentIds?.length ?? 0) > 0, {
  message: 'A feladat leírása vagy legalább egy csatolmány kötelező',
})

export const createScheduledAgentTaskSchema = z.object({
  agentId: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(8000),
  conversationId: z.string().uuid().optional(),
  attachmentDocumentIds: z.array(z.string().uuid()).max(8).optional(),
  nextRunAt: z.string().datetime(),
  recurrence: z.enum(['none', 'daily', 'weekly', 'monthly']).optional(),
  maxRuns: z.number().int().min(1).max(365).nullable().optional(),
  authorizeRunAs: z.boolean().optional(),
})

export const loadAgentChatSchema = z.object({
  conversationId: z.string().uuid(),
  agentId: z.string().uuid(),
})

export const listAgentChatSessionsSchema = z.object({
  agentId: z.string().uuid(),
  status: z.enum(['active', 'archived', 'all']).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).optional(),
})

export const conversationIdSchema = z.object({
  conversationId: z.string().uuid(),
})

export const promoteToTicketSchema = z.object({
  conversationId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500).optional(),
})

export const messageIdSchema = z.object({
  messageId: z.string().uuid(),
})

export const createTrainingSchema = z.object({
  agentId: z.string().uuid(),
  proposedContent: z.string().min(1),
  source: z.string().min(1),
})

export const goldenSetAssertionSchema = z.object({
  description: z.string().min(1),
  type: z.enum(['contains', 'not_contains', 'min_length']),
  value: z.union([z.string(), z.number()]),
})

export const approveTrainingSchema = z.object({
  ticketId: z.string().uuid(),
  overrideEval: z.boolean().optional(),
})

export const createEvalSchema = z.object({
  agentId: z.string().uuid(),
  name: z.string().min(1),
  goldenSet: z.array(goldenSetAssertionSchema).min(1),
})

export const runEvalSchema = z.object({
  evalId: z.string().uuid(),
  agentId: z.string().uuid(),
  proposedContent: z.string().min(1),
})

export const rollbackMemorySchema = z.object({
  agentId: z.string().uuid(),
  toVersion: z.number().int().positive(),
})

// ── Tartós agent-memória — WP-6 (agent-memory-persistent-cross-conversation-spec.md §6.2) ──

export const memoryCandidateIdSchema = z.object({
  candidateId: z.string().uuid(),
})

export const rejectMemoryCandidateSchema = z.object({
  candidateId: z.string().uuid(),
  reason: z.string().optional(),
})

export const modifyMemoryCandidateSchema = z.object({
  candidateId: z.string().uuid(),
  patch: z.object({
    title: z.string().min(1).optional(),
    summary: z.string().optional(),
    text: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    evidence: z.string().optional(),
    reason: z.string().optional(),
  }),
})

export const approveMemoryCandidateTicketSchema = z.object({
  ticketId: z.string().uuid(),
})

// ── Tartós agent-memória — WP-8 (agent-memory-persistent-cross-conversation-spec.md
// §8/§9.3/§11.2): maintenance-indítás, manifest-alapú (chunk-scope-os) rollback, és
// az agent memória-oldal olvasása. NEM ugyanaz, mint a legacy `rollbackMemorySchema`
// (§9.3 — a régi full-inject rollback nem projectKey-scoped). ──

export const memoryScopeSchema = z.object({
  agentId: z.string().uuid(),
  projectKey: z.string().min(1),
  workstreamKey: z.string().min(1).optional(),
})

export const rollbackMemoryVersionSchema = memoryScopeSchema.extend({
  toVersion: z.number().int().positive(),
})

export const agentIdSchema = z.object({
  id: z.string().uuid(),
})

export const agentApiKeyIdSchema = z.object({
  keyId: z.string().uuid(),
})

export const suspendAgentSchema = z.object({
  agentId: z.string().uuid(),
  reason: z.string().trim().min(1, 'Indok kötelező a felfüggesztéshez'),
})

const userRoleSchema = z.enum(['admin', 'approver', 'operator', 'viewer'])

export const inviteUserSchema = z.object({
  email: z.string().trim().email(),
  role: userRoleSchema,
})

export const redeemInvitationSchema = z.object({
  token: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
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
  reason: z.string().trim().min(1, 'Indok kötelező a felfüggesztéshez'),
})

export const reactivateUserSchema = z.object({
  targetUserId: z.string().uuid(),
})

export const setUserJobDescriptionSchema = z.object({
  targetUserId: z.string().uuid(),
  jobDescription: z.string().trim().max(280).nullish(),
})

export const updateRolePermissionSchema = z.object({
  permissionKey: z.string().trim().min(1),
  minRole: userRoleSchema,
})

export const costSummarySchema = z.object({
  range: z.enum(['today', '7d', '30d', 'all']).optional(),
})

export const createAgentSchema = z.object({
  name: z.string().min(1),
  roleInstruction: z.string().min(1),
  behaviorProfile: z.string().min(1),
  role: z.enum(['worker', 'orchestrator']).optional(),
  modelConfig: z.object({
    provider: modelProviderSchema,
    model: z.string().min(1),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
  }),
})

const httpApiEndpointSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().trim().min(1).max(500),
  description: z.string().trim().max(500).optional(),
  idempotent: z.boolean().optional(),
  profile: z.string().trim().max(80).optional(),
})

const httpApiAuthProfileSchema = z.object({
  secretAlias: z.string().trim().min(1).max(500),
  auth: z
    .discriminatedUnion('scheme', [
      z.object({ scheme: z.literal('bearer') }),
      z.object({
        scheme: z.literal('header'),
        header: z.string().trim().min(1).max(120),
      }),
    ])
    .optional(),
})

const httpApiConnectorFields = {
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().trim().url().max(500),
  authScheme: z.enum(['header', 'bearer', 'oauth2', 'oauth2_delegated']),
  authHeader: z.string().trim().max(120).optional(),
  /** oauth2 / oauth2_delegated séma: token-refresh végpont + kliens-azonosító (nem titok). */
  tokenUrl: z.string().trim().url().max(500).optional(),
  clientId: z.string().trim().max(300).optional(),
  scope: z.string().trim().max(500).optional(),
  /** oauth2_delegated séma: authorization-code consent végpont (nem titok). */
  authUrl: z.string().trim().url().max(500).optional(),
  /** oauth2_delegated séma: opcionális userinfo/whoami végpont a fiók-címkéhez (nem titok). */
  userInfoUrl: z.string().trim().url().max(500).optional(),
  /** oauth2 séma: a refresh_token grant titkai — a secret-store mögé, sosem a configba kerülnek. */
  clientSecret: z.string().trim().max(4000).optional(),
  refreshToken: z.string().trim().max(4000).optional(),
  description: z.string().trim().max(50000).optional(),
  authProfiles: z
    .record(z.string().regex(/^[a-zA-Z0-9_-]+$/), httpApiAuthProfileSchema)
    .optional(),
  defaultAuthProfile: z.string().trim().max(80).optional(),
  requestHeaders: z.record(z.string(), z.string()).optional(),
  writeHeaders: z.record(z.string(), z.string()).optional(),
  accessMode: z.enum(['read', 'write']).default('write'),
  restrictToEndpoints: z.boolean().default(false),
  endpoints: z.array(httpApiEndpointSchema).max(100).optional(),
}

function hasKnownHttpApiProfiles(v: {
  authProfiles?: Record<string, unknown>
  defaultAuthProfile?: string
  endpoints?: Array<{ profile?: string }>
}) {
  const profileNames = new Set(Object.keys(v.authProfiles ?? {}))
  if (v.defaultAuthProfile && !profileNames.has(v.defaultAuthProfile)) return false
  return !(v.endpoints ?? []).some((endpoint) => endpoint.profile && !profileNames.has(endpoint.profile))
}

function oauth2FieldsPresent(v: { authScheme: string; tokenUrl?: string; clientId?: string }) {
  if (v.authScheme !== 'oauth2' && v.authScheme !== 'oauth2_delegated') return true
  return Boolean(v.tokenUrl) && Boolean(v.clientId)
}

/** oauth2_delegated (auto-consent): a consent-flow-hoz authUrl + scope is kell. */
function delegatedOAuthFieldsPresent(v: { authScheme: string; authUrl?: string; scope?: string }) {
  if (v.authScheme !== 'oauth2_delegated') return true
  return Boolean(v.authUrl) && Boolean(v.scope)
}

export const createHttpApiConnectorSchema = z
  .object({
    agentId: z.string().uuid(),
    ...httpApiConnectorFields,
    apiKey: z.string().trim().max(4000).optional(),
  })
  .refine((v) => v.authScheme !== 'header' || (v.authHeader && v.authHeader.length > 0), {
    message: 'A fejléc-séma kötelezővé teszi a fejléc nevét (pl. X-Api-Key)',
    path: ['authHeader'],
  })
  .refine(oauth2FieldsPresent, {
    message: 'Az oauth2 séma kötelezővé teszi a tokenUrl-t és a clientId-t',
    path: ['tokenUrl'],
  })
  .refine(delegatedOAuthFieldsPresent, {
    message: 'Az automatikus consent (oauth2_delegated) kötelezővé teszi az authUrl-t és a scope-ot',
    path: ['authUrl'],
  })
  .refine((v) => v.authScheme !== 'oauth2' || (Boolean(v.clientSecret) && Boolean(v.refreshToken)), {
    message: 'Az oauth2 séma első beállításkor kötelezővé teszi a client secret-et és a refresh tokent',
    path: ['clientSecret'],
  })
  .refine((v) => v.authScheme !== 'oauth2_delegated' || Boolean(v.clientSecret), {
    message: 'Az automatikus consent kötelezővé teszi a client secret-et (a refresh tokent a felhasználó hozzájárulása adja)',
    path: ['clientSecret'],
  })
  .refine((v) => v.authScheme === 'oauth2' || v.authScheme === 'oauth2_delegated' || Boolean(v.apiKey), {
    message: 'API kulcs kötelező (kivéve oauth2 sémánál)',
    path: ['apiKey'],
  })
  .refine((v) => !v.restrictToEndpoints || (v.endpoints && v.endpoints.length > 0), {
    message: 'Az endpoint-korlátozáshoz legalább egy endpoint szükséges',
    path: ['endpoints'],
  })
  .refine(hasKnownHttpApiProfiles, {
    message: 'Az endpoint/default auth profil csak a megadott authProfiles kulcsaira hivatkozhat',
    path: ['authProfiles'],
  })

export const updateHttpApiConnectorSchema = z
  .object({
    agentId: z.string().uuid(),
    connectorId: z.string().uuid(),
    ...httpApiConnectorFields,
    apiKey: z.string().trim().min(1).max(4000).optional(),
  })
  .refine((v) => v.authScheme !== 'header' || (v.authHeader && v.authHeader.length > 0), {
    message: 'A fejléc-séma kötelezővé teszi a fejléc nevét (pl. X-Api-Key)',
    path: ['authHeader'],
  })
  .refine(oauth2FieldsPresent, {
    message: 'Az oauth2 séma kötelezővé teszi a tokenUrl-t és a clientId-t',
    path: ['tokenUrl'],
  })
  .refine(delegatedOAuthFieldsPresent, {
    message: 'Az automatikus consent (oauth2_delegated) kötelezővé teszi az authUrl-t és a scope-ot',
    path: ['authUrl'],
  })
  .refine((v) => v.authScheme === 'oauth2_delegated' || Boolean(v.clientSecret) === Boolean(v.refreshToken), {
    message: 'A client secret és a refresh token csak együtt frissíthető (rotáláshoz mindkettő kell)',
    path: ['refreshToken'],
  })
  .refine((v) => !v.restrictToEndpoints || (v.endpoints && v.endpoints.length > 0), {
    message: 'Az endpoint-korlátozáshoz legalább egy endpoint szükséges',
    path: ['endpoints'],
  })
  .refine(hasKnownHttpApiProfiles, {
    message: 'Az endpoint/default auth profil csak a megadott authProfiles kulcsaira hivatkozhat',
    path: ['authProfiles'],
  })

export const updateAgentSelfEvolutionProfileSchema = z.object({
  agentId: z.string().uuid(),
  profile: z.object({
    scope: z.array(z.enum(['memory', 'behavior', 'role'])).min(1),
    approval_mode: z.enum(['human', 'higher_role', 'eval_only', 'auto_after_eval']),
    diff_limit: z.number().int().positive().optional(),
  }).strict(),
})

export const createBehaviorProfileSchema = z.object({
  name: z.string().trim().min(1, 'Név kötelező'),
  body: z.string().trim().min(1, 'A viselkedés-profil törzse kötelező'),
})

export const updateBehaviorProfileSchema = z.object({
  profileId: z.string().uuid(),
  body: z.string().trim().min(1, 'A viselkedés-profil törzse kötelező'),
})

export const acceptBehaviorProfileUpdateSchema = z.object({
  agentId: z.string().uuid(),
  profileId: z.string().uuid(),
  profileVersion: z.number().int().positive(),
})

export const behaviorProfileIdSchema = z.object({
  profileId: z.string().uuid(),
})

export const setAgentBehaviorProfileSchema = z.object({
  agentId: z.string().uuid(),
  // `null` = nincs megosztott profil (tisztán egyedi munkastílus).
  profileId: z.string().uuid().nullable(),
  // Az agent-specifikus egyedi rész; üres is lehet, ha van választott profil.
  overlay: z.string().max(20000).optional().default(''),
})

export const updateAgentInstructionSchema = z
  .object({
    agentId: z.string().uuid(),
    roleInstruction: z.string().min(1).optional(),
    behaviorProfile: z.string().min(1).optional(),
  })
  .refine((v) => v.roleInstruction !== undefined || v.behaviorProfile !== undefined, {
    message: 'Legalább a szerep-instrukciót vagy a viselkedés-profilt meg kell adni',
  })

export const updateAgentPersonaSchema = z
  .object({
    agentId: z.string().uuid(),
    personaNickname: z.string().max(80).optional(),
    personaGreeting: z.string().max(280).optional(),
    personaTrait: z.string().max(280).optional(),
  })
  .refine(
    (v) =>
      v.personaNickname !== undefined ||
      v.personaGreeting !== undefined ||
      v.personaTrait !== undefined,
    {
      message: 'Legalább a nevet, az üdvözlő mondatot vagy a jellemvonást meg kell adni',
    },
  )

// Avatár: data URL (feltöltött, downscale-elt kép) vagy külső http(s) URL, vagy
// üres string a törléshez. A ~700 000 karakteres felső korlát bőven elég egy
// 256px-es webp/jpeg data URL-nek, de véd a DB-t elárasztó túl nagy blobbtól.
export const updateAgentAvatarSchema = z.object({
  agentId: z.string().uuid(),
  avatarUrl: z
    .string()
    .max(700_000)
    .refine(
      (v) =>
        v === '' ||
        /^data:image\/(png|jpeg|jpg|webp|gif);base64,/.test(v) ||
        /^https?:\/\//.test(v),
      { message: 'Az avatár csak feltöltött kép vagy http(s) URL lehet' },
    ),
})

export const updateAgentModelConfigSchema = z.object({
  agentId: z.string().uuid(),
  modelConfig: z.object({
    provider: modelProviderSchema,
    model: z.string().min(1),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
  }),
})

export const createInteractionTicketSchema = z.object({
  agentId: z.string().uuid(),
  title: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  sourceDocumentId: z.string().uuid().optional(),
})

const ticketStateSchema = z.enum([
  'backlog',
  'ready',
  'approved',
  'in_progress',
  'awaiting_human',
  'done',
  'rejected',
])

const toolInvokeBaseSchema = {
  ticketId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  actingUserId: z.string().uuid().optional(),
}

const xlsxCellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])

const borderStyleSchema = z.enum(['thin', 'medium', 'thick'])

const cellStyleSchema = z.object({
  font: z
    .object({
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      size: z.number().min(1).max(409).optional(),
      color: z.string().regex(/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/).optional(),
      name: z.string().max(64).optional(),
    })
    .optional(),
  fill: z
    .object({
      color: z.string().regex(/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/).optional(),
    })
    .optional(),
  alignment: z
    .object({
      horizontal: z.enum(['left', 'center', 'right']).optional(),
      vertical: z.enum(['top', 'middle', 'bottom']).optional(),
      wrapText: z.boolean().optional(),
    })
    .optional(),
  border: z
    .object({
      top: borderStyleSchema.optional(),
      bottom: borderStyleSchema.optional(),
      left: borderStyleSchema.optional(),
      right: borderStyleSchema.optional(),
    })
    .optional(),
  numFmt: z.string().max(200).optional(),
})

export const toolInvokeSchema = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('kb_search'),
    ...toolInvokeBaseSchema,
    args: z.object({
      query: z.string().min(1),
      k: z.number().int().min(1).max(10).optional(),
    }),
  }),
  z.object({
    tool: z.literal('kb_list_index'),
    ...toolInvokeBaseSchema,
    args: z.object({
      pathPrefix: z.string().max(200).optional(),
      maxDepth: z.number().int().min(1).max(20).optional(),
    }),
  }),
  z.object({
    tool: z.literal('kb_get_page'),
    ...toolInvokeBaseSchema,
    args: z.object({
      path: z.string().min(1).max(400),
      artifactId: z.string().uuid().optional(),
    }),
  }),
  z.object({
    tool: z.literal('board_write'),
    ...toolInvokeBaseSchema,
    args: z.object({
      ticketId: z.string().uuid(),
      patch: z
        .object({
          state: ticketStateSchema.optional(),
          payload: z.record(z.string(), z.unknown()).optional(),
        })
        .refine((patch) => patch.state || patch.payload, {
          message: 'board_write patch must include state or payload',
        }),
    }),
  }),
  z.object({
    tool: z.literal('ticket_create'),
    ...toolInvokeBaseSchema,
    args: z
      .object({
        title: z.string().min(1).max(200),
        payload: z.record(z.string(), z.unknown()),
        assigneeType: z.enum(['human', 'agent']),
        assigneeId: z.string().uuid().optional(),
        sourceDocumentId: z.string().uuid().optional(),
      })
      .refine((args) => args.assigneeType !== 'agent' || args.assigneeId, {
        message: 'assigneeId is required when assigneeType is agent',
      }),
  }),
  z.object({
    tool: z.literal('agent_ask'),
    ...toolInvokeBaseSchema,
    args: z.object({
      targetAgentId: z.string().uuid(),
      question: z.string().min(1).max(4000),
      context: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  z.object({
    tool: z.literal('agent_resolve'),
    ...toolInvokeBaseSchema,
    args: z.object({
      query: z.string().min(1).max(200),
      limit: z.number().int().min(1).max(10).optional(),
    }),
  }),
  z.object({
    tool: z.literal('agent_catalog'),
    ...toolInvokeBaseSchema,
    args: z.object({
      query: z.string().max(200).optional(),
      agentId: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(25).optional(),
    }),
  }),
  z.object({
    tool: z.literal('user_directory'),
    ...toolInvokeBaseSchema,
    args: z.object({
      query: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  }),
  z.object({
    tool: z.literal('gmail_search'),
    ...toolInvokeBaseSchema,
    args: z.object({
      query: z.string().min(1).max(500),
      maxResults: z.number().int().min(1).max(25).optional(),
    }),
  }),
  z.object({
    tool: z.literal('gmail_get_message'),
    ...toolInvokeBaseSchema,
    args: z.object({ id: z.string().min(1).max(200) }),
  }),
  z.object({
    tool: z.literal('mailbox_count'),
    ...toolInvokeBaseSchema,
    args: z.object({
      connectorId: z.string().uuid().optional(),
      query: z.string().max(500).optional(),
      labelIds: z.array(z.string().min(1).max(120)).max(10).optional(),
      includeSpamTrash: z.boolean().optional(),
    }),
  }),
  z.object({
    tool: z.literal('gmail_create_draft'),
    ...toolInvokeBaseSchema,
    args: z.object({
      to: z.string().email(),
      subject: z.string().min(1).max(500),
      body: z.string().min(1).max(20000),
      threadId: z.string().optional(),
    }),
  }),
  z.object({
    tool: z.literal('gmail_send'),
    ...toolInvokeBaseSchema,
    args: z
      .object({
        draftId: z.string().optional(),
        to: z.string().email().optional(),
        subject: z.string().optional(),
        body: z.string().optional(),
        approvalTicketId: z.string().uuid().optional(),
      })
      .refine((a) => a.draftId || (a.to && a.subject && a.body), {
        message: 'gmail_send requires draftId or to/subject/body',
      }),
  }),
  z.object({
    tool: z.literal('http_api_get'),
    ...toolInvokeBaseSchema,
    args: z.object({
      connectorId: z.string().uuid().optional(),
      path: z.string().min(1).max(1000),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    }),
  }),
  z.object({
    tool: z.literal('http_api_request'),
    ...toolInvokeBaseSchema,
    args: z.object({
      connectorId: z.string().uuid().optional(),
      method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
      path: z.string().min(1).max(1000),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      body: z.unknown().optional(),
    }),
  }),
  z.object({
    tool: z.literal('file_read'),
    ...toolInvokeBaseSchema,
    args: z.object({
      path: z.string().min(1).max(500),
      offset: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(5000).optional(),
    }),
  }),
  z.object({
    tool: z.literal('file_write'),
    ...toolInvokeBaseSchema,
    args: z.object({
      path: z.string().min(1).max(500),
      content: z.string().max(52_428_800),
    }),
  }),
  z.object({
    tool: z.literal('file_edit'),
    ...toolInvokeBaseSchema,
    args: z.object({
      path: z.string().min(1).max(500),
      old_string: z.string().min(1),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    }),
  }),
  z.object({
    tool: z.literal('file_list'),
    ...toolInvokeBaseSchema,
    args: z.object({
      path: z.string().max(500).optional(),
      recursive: z.boolean().optional(),
    }),
  }),
  z.object({
    tool: z.literal('file_glob'),
    ...toolInvokeBaseSchema,
    args: z.object({
      pattern: z.string().min(1).max(500),
    }),
  }),
  z.object({
    tool: z.literal('file_search'),
    ...toolInvokeBaseSchema,
    args: z.object({
      pattern: z.string().min(1).max(500),
      path: z.string().max(500).optional(),
      glob: z.string().max(500).optional(),
      ignore_case: z.boolean().optional(),
      max_results: z.number().int().min(1).max(1000).optional(),
    }),
  }),
  z.object({
    tool: z.literal('file_delete'),
    ...toolInvokeBaseSchema,
    args: z.object({
      path: z.string().min(1).max(500),
    }),
  }),
  z.object({
    tool: z.literal('xlsx_read_sheet'),
    ...toolInvokeBaseSchema,
    args: z.object({
      path: z.string().min(1).max(500),
      sheet: z.string().max(200).optional(),
      max_rows: z.number().int().min(1).max(5000).optional(),
    }),
  }),
  z.object({
    tool: z.literal('xlsx_write_cells'),
    ...toolInvokeBaseSchema,
    args: z.object({
      path: z.string().min(1).max(500),
      sheet: z.string().max(200).optional(),
      changes: z
        .array(
          z
            .object({
              cell: z.string().min(1).max(20),
              value: xlsxCellValueSchema.optional(),
              formula: z.string().max(2000).optional(),
              style: cellStyleSchema.optional(),
              numFmt: z.string().max(200).optional(),
            })
            .refine((c) => !(c.value !== undefined && c.formula !== undefined), {
              message: 'cell change cannot set both value and formula',
            }),
        )
        .min(1)
        .max(500),
    }),
  }),
  z.object({
    tool: z.literal('xlsx_format_range'),
    ...toolInvokeBaseSchema,
    args: z.object({
      path: z.string().min(1).max(500),
      sheet: z.string().max(200).optional(),
      range: z.string().min(3).max(40),
      style: cellStyleSchema,
    }),
  }),
  z.object({
    tool: z.literal('xlsx_layout'),
    ...toolInvokeBaseSchema,
    args: z.object({
      path: z.string().min(1).max(500),
      sheet: z.string().max(200).optional(),
      mergeCells: z.array(z.string().min(3).max(40)).max(200).optional(),
      columnWidths: z
        .array(z.object({ column: z.string().min(1).max(3), width: z.number().min(0).max(255) }))
        .max(256)
        .optional(),
      rowHeights: z
        .array(z.object({ row: z.number().int().min(1), height: z.number().min(0).max(409) }))
        .max(1000)
        .optional(),
      freeze: z
        .object({
          rows: z.number().int().min(0).max(1000).optional(),
          columns: z.number().int().min(0).max(256).optional(),
        })
        .optional(),
      autoFilter: z.string().min(3).max(40).optional(),
    }),
  }),
  z.object({
    tool: z.literal('xlsx_create'),
    ...toolInvokeBaseSchema,
    args: z.object({
      path: z.string().min(1).max(500),
      sheets: z
        .array(
          z.object({
            name: z.string().min(1).max(31),
            rows: z.array(z.array(xlsxCellValueSchema)).max(10000).optional(),
          }),
        )
        .min(1)
        .max(64),
    }),
  }),
  z.object({
    tool: z.literal('xlsx_append_rows'),
    ...toolInvokeBaseSchema,
    args: z.object({
      path: z.string().min(1).max(500),
      sheet: z.string().max(200).optional(),
      rows: z.array(z.record(z.string(), xlsxCellValueSchema)).min(1).max(1000),
    }),
  }),
  z.object({
    tool: z.literal('docx_read'),
    ...toolInvokeBaseSchema,
    args: z.object({
      path: z.string().min(1).max(500),
    }),
  }),
  z.object({
    tool: z.literal('pdf_read'),
    ...toolInvokeBaseSchema,
    args: z.object({
      path: z.string().min(1).max(500),
      page_range: z.string().max(20).optional(),
    }),
  }),
  z.object({
    tool: z.literal('pptx_create'),
    ...toolInvokeBaseSchema,
    args: z.object({
      path: z.string().min(1).max(500),
      title: z.string().max(300).optional(),
      author: z.string().max(200).optional(),
      subject: z.string().max(300).optional(),
      slides: z
        .array(
          z.object({
            layout: z.enum(['title', 'section', 'bullets', 'table']).optional(),
            title: z.string().max(500).optional(),
            subtitle: z.string().max(1000).optional(),
            bullets: z.array(z.string().max(1000)).max(50).optional(),
            headers: z.array(z.string().max(300)).max(20).optional(),
            rows: z.array(z.array(xlsxCellValueSchema).max(20)).max(500).optional(),
            notes: z.string().max(4000).optional(),
          }),
        )
        .min(1)
        .max(100),
    }),
  }),
  z.object({
    tool: z.literal('web_search'),
    ...toolInvokeBaseSchema,
    args: z.object({
      query: z.string().min(1).max(2000),
      domains: z.array(z.string().min(1).max(255)).max(20).optional(),
      recencyDays: z.number().int().min(1).max(365).optional(),
      locale: z.string().min(2).max(20).optional(),
      // A felső határ csak input-sanity; a tényleges effektív cap a tenant
      // policy hardMaxResults mezőjéből jön (WS14/WN12 — nincs 400, hanem clamp).
      maxResults: z.number().int().min(1).max(1000).optional(),
      purpose: z.string().max(200).optional(),
    }),
  }),
])

export const connectorGrantIdSchema = z.object({
  grantId: z.string().uuid(),
})

export const connectorIdSchema = z.object({
  connectorId: z.string().uuid(),
})

const gmailOAuthScopeSchema = z.enum([
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
])

export const startConnectorOAuthSchema = z.object({
  connectorId: z.string().uuid(),
  scopes: z.array(gmailOAuthScopeSchema).min(1).max(3).optional(),
})

export const approveGmailSendSchema = z.object({
  ticketId: z.string().uuid(),
  draftId: z.string().min(1),
})

export const authorizeTicketRunAsSchema = z.object({
  ticketId: z.string().uuid(),
})

export const harnessCompletionSchema = z.object({
  lockToken: z.string().uuid(),
  status: z.enum(['succeeded', 'failed']),
  jobId: z.string().trim().min(1).max(300).optional(),
  executionName: z.string().trim().min(1).max(500).optional(),
  error: z.string().trim().max(1000).optional(),
  errorCategory: z.enum(['permanent', 'transient']).optional(),
})

export const setDispatcherControlsSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowedModes: z.array(z.enum(['local-wiki', 'docker-local', 'cloud-run-job'])).optional(),
    // UI másodpercben küldi; a service ms-ban tárol és klampol (5s–600s).
    pollIntervalSeconds: z.number().int().min(5).max(600).optional(),
    blockedNotifyChannel: z
      .string()
      .trim()
      .max(120)
      .regex(/^(audit-only:[A-Za-z0-9_-]+|chat:[A-Za-z0-9_-]+)$/)
      .optional(),
  })
  .refine(
    (v) =>
      v.enabled !== undefined ||
      v.allowedModes !== undefined ||
      v.pollIntervalSeconds !== undefined ||
      v.blockedNotifyChannel !== undefined,
    { message: 'Legalább egy mezőt meg kell adni' },
  )

export const setDatabaseModeSchema = z.object({
  mode: z.enum(['production', 'test']),
})

export const syncTestDatabaseSchema = z.object({
  confirm: z.literal(true),
})

export const setMonitorControlsSchema = z
  .object({
    killSwitch: z.boolean().optional(),
    maxConcurrent: z.number().int().min(1).max(20).optional(),
  })
  .refine((v) => v.killSwitch !== undefined || v.maxConcurrent !== undefined, {
    message: 'Legalább egy mezőt meg kell adni',
  })

export const setWebSearchControlsSchema = z.object({
  killSwitch: z.boolean(),
})

export const setTenantWebSearchControlsSchema = z.object({
  killSwitch: z.boolean(),
})

/** Web Fetch (WS-D) platform-tool vezérlés (WebFetch-Egress §14). Legalább az egyik mező. */
export const setWebFetchControlsSchema = z
  .object({
    enabled: z.boolean().optional(),
    discoveryEnabled: z.boolean().optional(),
  })
  .refine((v) => v.enabled !== undefined || v.discoveryEnabled !== undefined, {
    message: 'enabled vagy discoveryEnabled megadása kötelező',
  })

const optionalHttpUrlSchema = z
  .string()
  .trim()
  .max(1000)
  .optional()
  .transform((value) => value?.trim() || undefined)
  .refine((value) => !value || /^https?:\/\//i.test(value), {
    message: 'Az API URL-nek http(s) címmel kell kezdődnie',
  })

export const updatePlatformHostedWebSearchSchema = z.object({
  providerApiUrl: optionalHttpUrlSchema,
  apiKey: z
    .string()
    .trim()
    .max(4000)
    .optional()
    .transform((value) => value?.trim() || undefined),
})

export const updateWebSearchPolicySchema = z.object({
  connectorId: z.string().uuid(),
  provider: z.enum(['stub', 'custom_search_api', 'platform_hosted_search']),
  providerApiUrl: optionalHttpUrlSchema,
  apiKey: z
    .string()
    .trim()
    .max(4000)
    .optional()
    .transform((value) => value?.trim() || undefined),
  allowedDomains: z.array(z.string().trim().min(1).max(255)).max(200),
  deniedDomains: z.array(z.string().trim().min(1).max(255)).max(200),
  allowGeneralWeb: z.boolean(),
  defaultLocale: z.string().trim().min(2).max(20),
  defaultRegion: z.string().trim().min(2).max(20),
  defaultMaxResults: z.number().int().min(1).max(50),
  hardMaxResults: z.number().int().min(1).max(100),
  maxQueryLength: z.number().int().min(50).max(2000),
  maxQueriesPerTicket: z.number().int().min(1).max(1000),
  maxQueriesPerAgentDay: z.number().int().min(1).max(10000),
  safeSearch: z.enum(['strict', 'moderate']),
  logRawQuery: z.boolean(),
  retentionDays: z.number().int().min(1).max(3650),
  requireHumanApprovalForSensitiveQuery: z.boolean(),
}).refine((value) => value.hardMaxResults >= value.defaultMaxResults, {
  path: ['hardMaxResults'],
  message: 'A hard cap nem lehet kisebb az alapértelmezett max találatszámnál',
})

export const createMonitorSchema = z.object({
  kind: z.enum(['board_backlog', 'deadline', 'connector_count', 'composite']),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  intervalSeconds: z.number().int().min(60).max(86400),
  collectorConfig: z.record(z.string(), z.unknown()).optional(),
  filterConfig: z.record(z.string(), z.unknown()).optional(),
  cooldownSeconds: z.number().int().min(0).max(604800).optional(),
  dedupKeyTemplate: z.string().trim().max(200).optional(),
  escalateAgentId: z.string().uuid().nullable().optional(),
  perRunBudgetUsd: z.number().min(0).max(100).nullable().optional(),
  notifyChannel: z.string().trim().max(200).nullable().optional(),
})

export const updateMonitorSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  intervalSeconds: z.number().int().min(60).max(86400).optional(),
  collectorConfig: z.record(z.string(), z.unknown()).optional(),
  filterConfig: z.record(z.string(), z.unknown()).optional(),
  cooldownSeconds: z.number().int().min(0).max(604800).optional(),
  dedupKeyTemplate: z.string().trim().max(200).nullable().optional(),
  escalateAgentId: z.string().uuid().nullable().optional(),
  perRunBudgetUsd: z.number().min(0).max(100).nullable().optional(),
  notifyChannel: z.string().trim().max(200).nullable().optional(),
})

export const monitorIdSchema = z.object({
  id: z.string().uuid(),
})

export const monitorDryRunSchema = z.object({
  id: z.string().uuid(),
})

// --- Fázis 2 Playbook process runtime (Feature-spec — Playbook §8.2, §8.3) ---

const playbookTicketStateSchema = z.enum([
  'backlog',
  'ready',
  'approved',
  'in_progress',
  'awaiting_human',
  'done',
  'rejected',
])

export const processTriggerTypeSchema = z.enum(['manual', 'ticket', 'chat', 'monitor_cron'])

export const startProcessSchema = z
  .object({
    processDefinitionId: z.string().uuid().optional(),
    triggerType: processTriggerTypeSchema.optional(),
    processType: z.string().trim().min(1).max(120).optional(),
    playbookVersionId: z.string().uuid().optional(),
    inputPayload: z.record(z.string(), z.unknown()).optional(),
    conversationId: z.string().uuid().nullable().optional(),
    rootTicketId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => Boolean(v.processDefinitionId || v.processType), {
    message: 'processDefinitionId vagy processType megadása kötelező',
  })

export const listProcessDefinitionsSchema = z.object({
  status: z.enum(['draft', 'active', 'archived']).optional(),
})

export const processDefinitionIdSchema = z.object({
  id: z.string().uuid(),
})

export const createProcessDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  playbookVersionId: z.string().uuid(),
})

export const updateProcessDefinitionBindingsSchema = z.object({
  id: z.string().uuid(),
  roleBindings: z.record(z.string().min(1), z.string().uuid()),
  configValues: z.record(z.string(), z.unknown()).optional(),
})

export const replaceActiveProcessDefinitionSchema = z.object({
  id: z.string().uuid(),
  roleBindings: z.record(z.string().min(1), z.string().uuid()),
  configValues: z.record(z.string(), z.unknown()).optional(),
  triggerType: processTriggerTypeSchema,
  triggerInputMap: z.record(z.string(), z.unknown()).optional(),
  monitorDefinitionId: z.string().uuid().nullable().optional(),
})

export const attachProcessTriggerSchema = z.object({
  processDefinitionId: z.string().uuid(),
  type: processTriggerTypeSchema,
  inputMap: z.record(z.string(), z.unknown()).optional(),
  monitorDefinitionId: z.string().uuid().nullable().optional(),
})

export const detachProcessTriggerSchema = z.object({
  processDefinitionId: z.string().uuid(),
  triggerId: z.string().uuid(),
})

export const startProcessFromTicketSchema = z.object({
  processDefinitionId: z.string().uuid(),
  ticketId: z.string().uuid(),
  triggerId: z.string().uuid().optional(),
})

export const chatTriggerableProcessDefinitionsSchema = z.object({
  agentId: z.string().uuid(),
})

export const suitableAgentsSchema = z.object({
  playbookVersionId: z.string().uuid(),
  roleKey: z.string().trim().min(1).max(120),
})

export const processIdSchema = z.object({
  id: z.string().uuid(),
})

export const cancelProcessSchema = z.object({
  id: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
})

export const transitionProcessTicketSchema = z.object({
  ticketId: z.string().uuid(),
  toState: playbookTicketStateSchema,
  note: z.string().trim().max(1000).optional(),
  outputPayload: z.record(z.string(), z.unknown()).optional(),
  approvalEvidence: z.record(z.string(), z.unknown()).optional(),
})

// --- Fázis 2 Playbook Registry admin (Feature-spec — Playbook §8.1, §9.1) ----

export const createPlaybookV2Schema = z.object({
  key: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/, 'Csak kisbetű, szám és kötőjel.'),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  processType: z.string().trim().min(1).max(120),
})

export const playbookV2IdSchema = z.object({
  id: z.string().uuid(),
})

export const updatePlaybookMetaSchema = z.object({
  playbookId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
})

export const createPlaybookVersionV2Schema = z.object({
  playbookId: z.string().uuid(),
  spec: z.unknown(),
  changeSummary: z.string().trim().min(1).max(500),
  // Canvas node-pozíciók (Governed Flow Builder D2) — nem hash-elt prezentáció.
  layout: z.record(z.string(), z.unknown()).optional(),
})

export const draftPlaybookFromDescriptionSchema = z
  .object({
    description: z.string().trim().max(4000).default(''),
    existingSpec: z.unknown().optional(),
    priorValidation: z
      .object({
        valid: z.boolean(),
        errors: z.array(z.object({ code: z.string(), path: z.string(), message: z.string() })),
        warnings: z.array(z.object({ code: z.string(), path: z.string(), message: z.string() })),
      })
      .optional(),
  })
  .refine((d) => d.description.length > 0 || d.existingSpec !== undefined, {
    message: 'description vagy existingSpec megadása kötelező',
    path: ['description'],
  })

export const updatePlaybookVersionV2Schema = z.object({
  playbookVersionId: z.string().uuid(),
  spec: z.unknown(),
  changeSummary: z.string().trim().min(1).max(500),
  // Canvas node-pozíciók (Governed Flow Builder D2) — nem hash-elt prezentáció.
  layout: z.record(z.string(), z.unknown()).optional(),
})

export const playbookVersionV2IdSchema = z.object({
  playbookVersionId: z.string().uuid(),
})

export const rejectPlaybookVersionV2Schema = z.object({
  playbookVersionId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
})

export const assignPlaybookV2Schema = z.object({
  playbookVersionId: z.string().uuid(),
  assignmentType: z.enum(['process_type', 'ticket_type']),
  assignmentKey: z.string().trim().min(1).max(120),
  isDefault: z.boolean(),
})
