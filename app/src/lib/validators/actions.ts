import { z } from 'zod'

export const ticketFilterSchema = z.object({
  state: z
    .enum([
      'backlog',
      'in_review',
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

export const transitionTicketSchema = z.object({
  id: z.string().uuid(),
  toState: z.enum([
    'backlog',
    'in_review',
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

export const costSummarySchema = z.object({
  range: z.enum(['today', '7d', '30d', 'all']).optional(),
})

export const createAgentSchema = z.object({
  name: z.string().min(1),
  roleDescription: z.string().min(1),
  systemPrompt: z.string().min(1),
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
