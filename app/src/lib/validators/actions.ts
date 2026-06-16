import { z } from 'zod'

export const ticketFilterSchema = z.object({
  state: z
    .enum([
      'backlog',
      'ready',
      'approved',
      'in_progress',
      'awaiting_human',
      'done',
      'rejected',
    ])
    .optional(),
})

export const ticketIdSchema = z.object({
  id: z.string().uuid(),
})

export const sandboxAppIdSchema = z.object({
  appId: z.string().uuid(),
})

export const createSandboxReportSchema = z.object({
  ticketId: z.string().uuid(),
})

export const transitionTicketSchema = z.object({
  id: z.string().uuid(),
  toState: z.enum([
    'backlog',
    'ready',
    'approved',
    'in_progress',
    'awaiting_human',
    'done',
    'rejected',
  ]),
  note: z.string().optional(),
})

export const processDocumentSchema = z.object({
  documentId: z.string().uuid(),
  agentId: z.string().uuid(),
})

export const processDocumentForWikiSchema = z.object({
  documentId: z.string().uuid(),
  agentId: z.string().uuid(),
})

export const askWikiSchema = z.object({
  agentId: z.string().uuid(),
  question: z.string().trim().min(1).max(2000),
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

export const agentIdSchema = z.object({
  id: z.string().uuid(),
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

export const changeUserRoleSchema = z.object({
  targetUserId: z.string().uuid(),
  newRole: userRoleSchema,
})

export const setUserStatusSchema = z.object({
  targetUserId: z.string().uuid(),
  status: z.enum(['active', 'suspended', 'pending']),
})

export const costSummarySchema = z.object({
  range: z.enum(['today', '7d', '30d', 'all']).optional(),
})

export const createAgentSchema = z.object({
  name: z.string().min(1),
  roleInstruction: z.string().min(1),
  behaviorProfile: z.string().min(1),
  modelConfig: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
  }),
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

export const toolInvokeSchema = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('kb_search'),
    ticketId: z.string().uuid().optional(),
    args: z.object({
      query: z.string().min(1),
      k: z.number().int().min(1).max(10).optional(),
    }),
  }),
  z.object({
    tool: z.literal('board_write'),
    ticketId: z.string().uuid().optional(),
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
])

export const harnessCompletionSchema = z.object({
  lockToken: z.string().uuid(),
  status: z.enum(['succeeded', 'failed']),
  jobId: z.string().trim().min(1).max(300).optional(),
  executionName: z.string().trim().min(1).max(500).optional(),
  error: z.string().trim().max(1000).optional(),
})
