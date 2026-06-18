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
  conversationId: z.string().uuid().optional(),
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

export const loadAgentChatSchema = z.object({
  conversationId: z.string().uuid(),
  agentId: z.string().uuid(),
})

export const listAgentChatSessionsSchema = z.object({
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
  role: z.enum(['worker', 'orchestrator']).optional(),
  modelConfig: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
  }),
})

export const updateAgentSelfEvolutionProfileSchema = z.object({
  agentId: z.string().uuid(),
  profile: z.object({
    scope: z.array(z.enum(['memory', 'behavior', 'role'])).min(1),
    approval_mode: z.enum(['human', 'higher_role', 'eval_only', 'auto_after_eval']),
    diff_limit: z.number().int().positive().optional(),
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

export const updateAgentModelConfigSchema = z.object({
  agentId: z.string().uuid(),
  modelConfig: z.object({
    provider: z.string().min(1),
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
      changes: z.array(
        z.object({
          cell: z.string().min(1).max(20),
          value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
        }),
      ).min(1).max(500),
    }),
  }),
  z.object({
    tool: z.literal('xlsx_append_rows'),
    ...toolInvokeBaseSchema,
    args: z.object({
      path: z.string().min(1).max(500),
      sheet: z.string().max(200).optional(),
      rows: z.array(z.record(z.string(), z.unknown())).min(1).max(1000),
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
])

export const connectorGrantIdSchema = z.object({
  grantId: z.string().uuid(),
})

export const connectorIdSchema = z.object({
  connectorId: z.string().uuid(),
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
})
