import { z } from 'zod'

export const selfEvolutionScopeSchema = z.enum(['memory', 'behavior', 'role'])
export const selfEvolutionApprovalModeSchema = z.enum([
  'human',
  'higher_role',
  'eval_only',
  'auto_after_eval',
])

export const selfEvolutionProfileSchema = z.object({
  scope: z.array(selfEvolutionScopeSchema).min(1).default(['memory']),
  approval_mode: selfEvolutionApprovalModeSchema.default('human'),
  diff_limit: z.number().int().positive().optional(),
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
