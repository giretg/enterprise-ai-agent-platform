import { z } from 'zod'

export const selfEvolutionScopeSchema = z.enum(['memory', 'behavior', 'role'])
export const selfEvolutionApprovalModeSchema = z.enum([
  'human',
  'higher_role',
  'eval_only',
  'auto_after_eval',
])

// agent-memory-persistent-cross-conversation-spec.md §12.2 — a WP-6/WP-8 által
// bekötött memória-specifikus önfejlesztési beállítások. Minden mező opcionális:
// hiányukban a platform-default (memory-types.ts DEFAULT_*) / a maintenance
// szolgáltatás saját defaultja (DEFAULT_MAINTENANCE_TOKEN_BUDGET) érvényes.
export const memorySelfEvolutionConfigSchema = z
  .object({
    allowedTypes: z.array(z.string()).optional(),
    inlineApprovalRoles: z.array(z.string()).optional(),
    captureMode: z.literal('explicit_only').optional(),
    maintenanceMode: z.string().optional(),
    maxProjectStateTokens: z.number().int().positive().optional(),
    maxRetrievedChunkTokens: z.number().int().positive().optional(),
    maintenanceTokenBudget: z.number().int().positive().optional(),
  })
  .strict()

export const selfEvolutionProfileSchema = z.object({
  scope: z.array(selfEvolutionScopeSchema).min(1).default(['memory']),
  approval_mode: selfEvolutionApprovalModeSchema.default('human'),
  diff_limit: z.number().int().positive().optional(),
  memory: memorySelfEvolutionConfigSchema.optional(),
}).strict()

export type SelfEvolutionProfile = z.infer<typeof selfEvolutionProfileSchema>

/** NULL profil = legszigorúbb (human) — §5.12.2 */
export function resolveSelfEvolutionProfile(raw: unknown): SelfEvolutionProfile {
  if (raw === null || raw === undefined) {
    return { scope: ['memory'], approval_mode: 'human' }
  }
  return selfEvolutionProfileSchema.parse(raw)
}

export function requiresHumanApproval(profile: SelfEvolutionProfile): boolean {
  return profile.approval_mode === 'human' || profile.approval_mode === 'higher_role'
}

export function requiresEvalGate(profile: SelfEvolutionProfile): boolean {
  return profile.approval_mode === 'eval_only' || profile.approval_mode === 'auto_after_eval'
}
