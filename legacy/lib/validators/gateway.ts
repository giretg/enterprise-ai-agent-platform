import { z } from 'zod'

export const openAiChatCompletionSchema = z.object({
  model: z.string().optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z.string().nullable().optional(),
        tool_call_id: z.string().optional(),
        name: z.string().optional(),
      }),
    )
    .min(1),
  tools: z
    .array(
      z.object({
        type: z.string().optional(),
        function: z.object({ name: z.string().optional() }).optional(),
      }),
    )
    .optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
})
