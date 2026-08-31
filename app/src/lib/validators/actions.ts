import { z } from 'zod'
import { TOOL_NAMES, TOOL_REGISTRY } from '@/domain/tool-broker/tool-registry'
import { githubRepositoryAccessSchema } from '@/domain/connector/github-repository-access-schema'
import { MODEL_PROVIDER_IDS } from '@/lib/model-providers'
import {
  TICKET_SCHEDULE_INTERVAL_HOURS_MAX,
  TICKET_SCHEDULE_INTERVAL_HOURS_MIN,
  TICKET_SCHEDULE_MAX_RUNS_MAX,
  TICKET_SCHEDULE_MAX_RUNS_MIN,
  TICKET_SCHEDULE_RECURRENCES,
  TICKET_SCHEDULE_RECURRENCES_WITH_NONE,
} from '@/lib/ticket-schedule'

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
  excludeTest: z.boolean().optional(),
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
  'system_or_approver',
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

const modelProviderSchema = z.enum(MODEL_PROVIDER_IDS)
const modelTypeSchema = z.enum(['luna', 'terra', 'sol'])

export const modelPolicyEntrySchema = z.object({
  provider: modelProviderSchema,
  model: z.string().trim().min(1).max(200),
  enabled: z.boolean(),
  label: z.string().trim().max(120).optional(),
  description: z.string().trim().max(280).optional(),
})

export const ticketScheduleRecurrenceSchema = z.enum(TICKET_SCHEDULE_RECURRENCES)
const ticketScheduleIntervalHoursSchema = z
  .number()
  .int()
  .min(TICKET_SCHEDULE_INTERVAL_HOURS_MIN)
  .max(TICKET_SCHEDULE_INTERVAL_HOURS_MAX)
const ticketScheduleMaxRunsSchema = z
  .number()
  .int()
  .min(TICKET_SCHEDULE_MAX_RUNS_MIN)
  .max(TICKET_SCHEDULE_MAX_RUNS_MAX)

export const createBoardTicketSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4000).optional(),
    assigneeType: z.enum(['human', 'agent']),
    assigneeId: z.string().uuid(),
    /** Agenthez rendelt, enabled skill-verziók — a runtime Level-1-ként előtölti őket. */
    skillVersionIds: z.array(z.string().uuid()).max(20).optional(),
    /** ISO-8601 határidő; a monitor figyeli, a task-promptba is bekerül. */
    dueBy: z.string().datetime().optional().nullable(),
    /** Ha true, a ticket ready marad, de a dispatcher nem indul — pl. workspace fájl feltöltés után. */
    deferDispatch: z.boolean().optional(),
    /**
     * Feladatkör-korlátozás (#199): a kiválasztott skill deklarált paramétereinek
     * kitöltött értékei. A kulcsokat a szerver a skill `parameters[]` neveihez köti;
     * ismeretlen kulcs hiba. v1-ben minden paraméter opcionális.
     */
    skillParameterValues: z
      .record(z.string().min(1).max(120), z.string().max(2_000))
      .optional(),
    /**
     * Munkaterület Feladatok-fül: a kiosztás kapjon saját beszélgetést.
     * A szerver csak beszélgetős (nem task-only) agentnél érvényesíti.
     */
    linkConversation: z.boolean().optional(),
    /** `none` / hiány: azonnal (vagy play gomb). `once`: executeAfter. `recurring`: ScheduledTask. */
    scheduleMode: z.enum(['none', 'once', 'recurring']).optional(),
    runAt: z.string().datetime().optional(),
    recurrence: ticketScheduleRecurrenceSchema.optional(),
    intervalHours: ticketScheduleIntervalHoursSchema.optional(),
    maxRuns: ticketScheduleMaxRunsSchema.nullable().optional(),
  })
  .refine((args) => args.assigneeType !== 'agent' || args.assigneeId, {
    message: 'assigneeId is required when assigneeType is agent',
  })
  .refine(
    (args) =>
      args.assigneeType === 'agent' ||
      !args.skillVersionIds ||
      args.skillVersionIds.length === 0,
    { message: 'skillVersionIds only allowed when assigneeType is agent' },
  )
  .refine((args) => args.assigneeType === 'agent' || !args.skillParameterValues, {
    message: 'skillParameterValues only allowed when assigneeType is agent',
  })
  .refine(
    (args) =>
      !args.scheduleMode ||
      args.scheduleMode === 'none' ||
      args.assigneeType === 'agent',
    { message: 'Csak AI munkatárshoz adható ütemezés' },
  )
  .refine(
    (args) =>
      args.scheduleMode !== 'once' && args.scheduleMode !== 'recurring' || Boolean(args.runAt),
    { message: 'Az ütemezett feladathoz időpont kell' },
  )
  .refine(
    (args) => args.scheduleMode !== 'recurring' || Boolean(args.recurrence),
    { message: 'A rendszeres feladathoz gyakoriság kell' },
  )

/** Board ticket deferred dispatch — a form `{ ticketId }` kulccsal hívja (nem `{ id }`). */
export const dispatchBoardTicketSchema = z.object({
  ticketId: z.string().uuid(),
})

export const deleteBoardTicketSchema = z.object({
  ticketId: z.string().uuid(),
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


export const taskBriefingSchema = z.object({
  goal: z.string().trim().min(1).max(2000),
  source: z.string().trim().max(2000),
  constraint: z.string().trim().max(2000),
  approval: z.string().trim().max(500),
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
  briefing: taskBriefingSchema.optional(),
}).refine((v) => v.content.length > 0 || (v.attachmentDocumentIds?.length ?? 0) > 0, {
  message: 'A feladat leírása vagy legalább egy csatolmány kötelező',
})

export const listChatTaskCardsSchema = z.object({
  ticketIds: z.array(z.string().uuid()).min(1).max(50),
})

export const conversationMemoryStripSchema = z.object({
  conversationId: z.string().uuid(),
  agentId: z.string().uuid(),
})

export const createScheduledAgentTaskSchema = z.object({
  agentId: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(8000),
  conversationId: z.string().uuid().optional(),
  attachmentDocumentIds: z.array(z.string().uuid()).max(8).optional(),
  nextRunAt: z.string().datetime(),
  recurrence: z.enum(TICKET_SCHEDULE_RECURRENCES_WITH_NONE).optional(),
  intervalHours: ticketScheduleIntervalHoursSchema.optional(),
  maxRuns: ticketScheduleMaxRunsSchema.nullable().optional(),
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

export const findLatestAgentChatSessionSchema = z.object({
  agentId: z.string().uuid(),
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

export const proposeMemoryItemChangeSchema = z.discriminatedUnion('operation', [
  z.object({
    agentId: z.string().uuid(),
    operation: z.literal('add'),
    text: z.string().min(1),
    apply: z.boolean().optional(),
  }),
  z.object({
    agentId: z.string().uuid(),
    operation: z.literal('update'),
    itemIndex: z.number().int().nonnegative(),
    text: z.string().min(1),
    apply: z.boolean().optional(),
  }),
  z.object({
    agentId: z.string().uuid(),
    operation: z.literal('remove'),
    itemIndex: z.number().int().nonnegative(),
    apply: z.boolean().optional(),
  }),
])

export const listTrainingMemoryVersionsSchema = z.object({
  agentId: z.string().uuid(),
  limit: z.number().int().positive().max(50).optional(),
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

export const previewTrainingChangeSchema = z.object({
  agentId: z.string().uuid(),
  instruction: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('teach'), text: z.string().min(1) }),
    z.object({
      kind: z.literal('item_change'),
      change: z.discriminatedUnion('operation', [
        z.object({ operation: z.literal('add'), text: z.string().min(1) }),
        z.object({
          operation: z.literal('update'),
          itemIndex: z.number().int().nonnegative(),
          text: z.string().min(1),
        }),
        z.object({ operation: z.literal('remove'), itemIndex: z.number().int().nonnegative() }),
      ]),
    }),
    z.object({ kind: z.literal('full_version'), content: z.string().min(1) }),
  ]),
  compositionMode: z.enum(['build_on_pending', 'replace_pending']).nullable().optional(),
})

export const submitTrainingProposalSchema = z.object({
  previewId: z.string().min(1),
  activate: z.boolean().optional(),
})

export const activateTrainingSchema = z.object({
  ticketId: z.string().uuid(),
  revisionId: z.string().uuid(),
})

export const rejectTrainingSchema = z.object({
  ticketId: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
})

export const getTrainingWorkspaceSchema = z.object({
  agentId: z.string().uuid(),
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

export const consequenceApprovalIdSchema = z.object({
  approvalId: z.string().uuid(),
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

/** Csendes előkészítés: email + szerep, meghívó email nélkül. */
export const provisionUserSchema = z.object({
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
    modelType: modelTypeSchema.optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
  }),
})

/** Provisioning agent → új-agent vázlat (propose-not-apply); a createAgent a jóváhagyás. */
export const draftAgentFromDescriptionSchema = z.object({
  description: z.string().trim().min(1).max(4000),
})

const httpApiEndpointSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().trim().min(1).max(500),
  description: z.string().trim().max(500).optional(),
  idempotent: z.boolean().optional(),
  profile: z.string().trim().max(80).optional(),
  /** Következmény-kapu: read auto; write/danger → Jóváhagyom. */
  risk: z.enum(['read', 'write', 'danger']).optional(),
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
  /** Connector-szintű alap kockázat — write/danger → minden http_api_request kapuzott. */
  defaultRisk: z.enum(['read', 'write', 'danger']).optional(),
  githubRepositoryAccess: githubRepositoryAccessSchema.optional(),
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
    durable_memory_approval_policy: z
      .object({
        activation_mode: z.enum(['approver_required', 'operator_can_activate']),
        four_eyes_required: z.boolean(),
      })
      .strict()
      .superRefine((policy, ctx) => {
        if (policy.four_eyes_required && policy.activation_mode === 'operator_can_activate') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'A négy szem elv bekapcsolása jóváhagyót követel',
          })
        }
      })
      .optional(),
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

/** Sensitivity router per-agent teljes felmentés (§4.7.2). */
export const updateAgentSensitivityPolicySchema = z.object({
  agentId: z.string().uuid(),
  allowSensitiveExternalModel: z.boolean(),
})

/** Operator-láthatóság: admin elrejtheti az agentet az operátorok elől. */
export const updateAgentOperatorVisibilitySchema = z.object({
  agentId: z.string().uuid(),
  hiddenFromOperators: z.boolean(),
})

/**
 * Feladatkör-korlátozás (#199). UI-egyszerűsítés, nem jogosultsági korlát —
 * a kapcsolót kizárólag tenant admin állíthatja, minden váltás auditált.
 */
export const updateAgentTaskOnlySchema = z.object({
  agentId: z.string().uuid(),
  taskOnly: z.boolean(),
})

export const applyEfficiencyHintSchema = z.object({
  agentId: z.string().uuid(),
  kind: z.enum(['stricter_compaction', 'narrower_source_frame', 'narrower_tool_budget']),
  revert: z.boolean().optional(),
})

/** EFF-10 — hatékonysági kártya betöltése (governance Range mintája). */
export const getEfficiencyAdvisorCardSchema = z.object({
  agentId: z.string().uuid(),
  range: z.enum(['today', '7d', '30d', 'all']).optional(),
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
    modelType: modelTypeSchema.optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    /** Agent-szintű tartalék — a globális lánc előtt fut. */
    fallbackModels: z
      .array(z.object({ provider: modelProviderSchema, model: z.string().min(1) }))
      .optional(),
  }),
})

export const createInteractionTicketSchema = z.object({
  agentId: z.string().uuid(),
  title: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  sourceDocumentId: z.string().uuid().optional(),
})

const toolInvokeBaseSchema = {
  ticketId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  actingUserId: z.string().uuid().optional(),
}

/**
 * A tool-hívás VALIDÁTOR-VETÜLETE (issue #194, WP-4).
 *
 * A discriminated union a kanonikus `TOOL_REGISTRY`-ből GENERÁLÓDIK: minden
 * toolhoz pontosan az az args-séma tartozik, amiből a modellnek küldött JSON
 * Schema is képződik. Korábban ez egy külön, kézzel írt union volt, amiből 19
 * tool (sandbox_app.*, sandbox.*, create_html, pdf_create, repo_*, document_read,
 * tulajdoni_lap_*, reconcile_records, memory_propose, web_research_request)
 * egyszerűen KIMARADT — az agent tools API ezeket 400-zal utasította vissza,
 * hiába volt handlerük és grantjuk. Generált vetületként ez nem tud megtörténni.
 */
const toolInvokeVariantList = TOOL_NAMES.map((name) =>
  z.object({
    tool: z.literal(name),
    ...toolInvokeBaseSchema,
    args: TOOL_REGISTRY[name].argsSchema,
  }),
)

type ToolInvokeVariant = (typeof toolInvokeVariantList)[number]

export const toolInvokeSchema = z.discriminatedUnion(
  'tool',
  toolInvokeVariantList as [ToolInvokeVariant, ...ToolInvokeVariant[]],
)

/**
 * A wire-alak, amit az agent tools API elfogad. Az `args` szándékosan laza
 * ezen a szinten: a séma a KAPU (érvénytelen args-t visszadob), a tipizált
 * broker-inputot pedig a regiszter `buildToolInvokeInput`-ja ÁLLÍTJA ELŐ —
 * nem egy típus-állítás.
 */
export type ToolInvokePayload = z.infer<typeof toolInvokeSchema>

export const connectorGrantIdSchema = z.object({
  grantId: z.string().uuid(),
})

export const connectorIdSchema = z.object({
  connectorId: z.string().uuid(),
})

/**
 * Delegált OAuth-scope: provider-független alak.
 *
 * A scope-listát a SZERVER validálja a connector configjához
 * (`resolveRequestedScopes` — configon kívüli scope-ot kérni hiba), ezért itt
 * nincs beégetett szolgáltatói enum: egy új OAuth-connector (Drive, Slack,
 * saját API) scope-jai séma-módosítás nélkül átmennek. A forma-ellenőrzés csak
 * a szemetet szűri.
 */
const delegatedOAuthScopeSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:\-\/]+$/, 'invalid oauth scope')

export const startConnectorOAuthSchema = z.object({
  connectorId: z.string().uuid(),
  scopes: z.array(delegatedOAuthScopeSchema).min(1).max(20).optional(),
  /**
   * Melyik eszköz akadt el grant-hiányon. Ebből a szerver a legkisebb
   * szükséges scope-halmazt oldja fel — a kliens nem kér jogosultságot.
   */
  toolName: z.string().trim().min(1).max(120).optional(),
  returnTo: z
    .object({
      kind: z.enum(['conversation', 'ticket']),
      id: z.string().uuid(),
      agentId: z.string().uuid().optional(),
      originPath: z.string().trim().max(200).optional(),
    })
    .optional(),
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

/** Chat "thinking-trace" spec §D7/WP-6 — tenant-szintű reasoning-megjelenítés kapcsoló. */
export const setTenantThinkingTraceControlsSchema = z.object({
  enabled: z.boolean(),
})

const privacyCategoryActionSchema = z.enum(['allow', 'tokenize', 'local_only', 'block'])
const privacyOverlayValueSchema = z.union([privacyCategoryActionSchema, z.null()])
const privacyEditorLayerSchema = z.enum(['platform', 'tenant', 'agent'])
const privacyGatewayModeSchema = z.enum(['off', 'observe', 'enforce'])

/** APG-14 — kategória-policy szerkesztő + dry-run. */
export const getPrivacyAdminViewSchema = z.object({
  agentId: z.string().uuid().optional(),
  layer: privacyEditorLayerSchema.optional(),
})

/** #320 — „Szinkron most": a forrás privacy-katalógusának behúzása egy kapcsolatra. */
export const syncConnectorPrivacyCatalogSchema = z.object({
  connectorId: z.string().uuid(),
  agentId: z.string().uuid().optional(),
  layer: privacyEditorLayerSchema.optional(),
})

export const setPrivacyCategoryPolicySchema = z.object({
  layer: privacyEditorLayerSchema,
  agentId: z.string().uuid().optional(),
  categories: z.record(z.string().min(1).max(64), privacyOverlayValueSchema).optional(),
  custom: z.record(z.string().min(1).max(64), privacyOverlayValueSchema).optional(),
  confirmation: z.string().max(64).optional(),
})

export const setPrivacyGatewayModeSchema = z.object({
  layer: privacyEditorLayerSchema,
  agentId: z.string().uuid().optional(),
  mode: z.union([privacyGatewayModeSchema, z.null()]),
})

export const setSensitivityLayerModeSchema = setPrivacyGatewayModeSchema

const privacyTextPreviewSchema = z.object({
  text: z.string().max(20_000),
  agentId: z.string().uuid().optional(),
})

export const dryRunPrivacyTextSchema = privacyTextPreviewSchema

/** APG-22 — privacy observability lánc előnézet (modellhívás nélkül). */
export const previewPrivacyObservabilitySchema = privacyTextPreviewSchema

export const getChatPrivacyMarkerContextSchema = z.object({
  agentId: z.string().uuid(),
  conversationId: z.string().uuid().nullable().optional(),
})

/** Tenant kimeneti nyelv — skill/playbook desztilláló és szerző agentek. */
export const setTenantLanguageSchema = z.object({
  language: z.enum(['hu', 'en']),
})

/**
 * Menü-hozzáférés: szerepkör → elrejtett fejléc-menü kulcsok. A kulcsok érvényességét
 * (katalógusban létező-e) és a kizárási invariánst az action ellenőrzi — itt csak a
 * durva alak és a méret korlátozott, hogy egy elszabadult input ne írjon a settingsbe.
 */
const navVisibilityKeyList = z.array(z.string().min(1).max(120)).max(200)

export const setNavVisibilitySchema = z.object({
  policy: z.object({
    viewer: navVisibilityKeyList,
    operator: navVisibilityKeyList,
    approver: navVisibilityKeyList,
    admin: navVisibilityKeyList,
  }),
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

export const updatePlatformWebSearchSchema = z.object({
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
  // Tenant scope-ban nincs platform credential-fallback és nincs stub mód.
  provider: z.literal('custom_search_api'),
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

export const suitableAgentsForVersionSchema = z.object({
  playbookVersionId: z.string().uuid(),
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
