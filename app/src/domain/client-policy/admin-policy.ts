import { z } from 'zod'
import { CAPABILITY_KEYS, PRESET_IDS, capabilityLevels, strictnessOf, type CapabilityKey, type PresetId } from './capabilities'
import { resolveEffectivePolicy, type PolicyRow } from './resolve-effective-policy'
import type { AuditAppendInput } from '@/lib/audit/types'

export const adminPolicyTargetSchema = z.object({
  scope: z.enum(['tenant', 'user', 'agent']),
  scopeId: z.string().uuid(),
}).strict()

export const adminPolicySaveSchema = adminPolicyTargetSchema.extend({
  preset: z.enum(PRESET_IDS).nullable(),
  capabilities: z.record(z.string(), z.string()).superRefine((values, ctx) => {
    for (const [key, value] of Object.entries(values)) {
      if (!(CAPABILITY_KEYS as readonly string[]).includes(key) || strictnessOf(key as CapabilityKey, value) < 0) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'Ismeretlen képesség vagy szint.' })
      }
    }
  }),
  version: z.number().int().min(0).max(2_147_483_646),
  confirmWidening: z.boolean().default(false),
}).strict()

export type AdminPolicyTarget = z.infer<typeof adminPolicyTargetSchema>
export type AdminPolicySave = z.infer<typeof adminPolicySaveSchema>
export type AdminPolicyActor = { tenantId: string; userId: string; role: string }
export type AdminPolicy = { preset: PresetId | null; version: number; capabilities: Record<string, string> }

export function adminPolicyView(row: Pick<PolicyRow, 'preset' | 'version' | 'capabilities'> | null): AdminPolicy | null {
  if (!row) return null
  const raw = row.capabilities && typeof row.capabilities === 'object' && !Array.isArray(row.capabilities)
    ? row.capabilities as Record<string, unknown> : {}
  return {
    preset: (PRESET_IDS as readonly unknown[]).includes(row.preset) ? row.preset as PresetId : null,
    version: row.version,
    capabilities: Object.fromEntries(CAPABILITY_KEYS.filter((key) => Object.hasOwn(raw, key)).map((key) =>
      [key, typeof raw[key] === 'string' && strictnessOf(key, raw[key]) >= 0 ? raw[key] : capabilityLevels(key)[0]])),
  }
}

export interface AdminPolicyTransaction {
  targetExists(target: AdminPolicyTarget): Promise<boolean>
  find(target: AdminPolicyTarget): Promise<PolicyRow | null>
  /** Expected version check, write, and both audit records run in this same transaction. */
  save(row: PolicyRow, expectedVersion: number, actorId: string): Promise<boolean>
  audit(event: AuditAppendInput): Promise<unknown>
}

export interface AdminPolicyStore {
  /** Serialize policy writers within a tenant so the D3 check sees the current tenant policy. */
  transaction<T>(tenantId: string, run: (tx: AdminPolicyTransaction) => Promise<T>): Promise<T>
}

export class AdminPolicyError extends Error {
  constructor(public code: 'forbidden' | 'not_found' | 'version_conflict' | 'confirmation_required', public capabilities: string[] = []) {
    super(code)
  }
}

export async function saveAdminPolicy(store: AdminPolicyStore, actor: AdminPolicyActor, input: AdminPolicySave): Promise<AdminPolicy> {
  if (actor.role !== 'admin') throw new AdminPolicyError('forbidden')
  return store.transaction(actor.tenantId, async (tx) => {
    if (!await tx.targetExists(input)) throw new AdminPolicyError('not_found')
    const current = await tx.find(input)
    if ((current?.version ?? 0) !== input.version) throw new AdminPolicyError('version_conflict')
    const raw = current?.capabilities && typeof current.capabilities === 'object' && !Array.isArray(current.capabilities)
      ? current.capabilities as Record<string, unknown> : {}
    // The capability editor never changes a separately configured model list or tool rules.
    const next: PolicyRow = {
      scope: input.scope, scopeId: input.scopeId, preset: input.preset,
      capabilities: { ...(Object.hasOwn(raw, 'models') ? { models: raw.models } : {}), ...input.capabilities },
      toolOverrides: current?.toolOverrides ?? {}, version: input.version + 1,
    }
    let widened: string[] = []
    if (input.scope === 'user') {
      const tenant = await tx.find({ scope: 'tenant', scopeId: actor.tenantId })
      const effective = resolveEffectivePolicy({ tenant, user: next, agent: null })
      widened = CAPABILITY_KEYS.filter((key) => effective.reasons[key].widenedBeyondTenant)
      if (widened.length && !input.confirmWidening) throw new AdminPolicyError('confirmation_required', widened)
    }
    if (!await tx.save(next, input.version, actor.userId)) throw new AdminPolicyError('version_conflict')
    const audit: AuditAppendInput = {
      actorType: 'human', actorId: actor.userId, tenantId: actor.tenantId,
      action: 'client_policy.save', targetType: `client_policy_${input.scope}`, targetId: input.scopeId,
      policyDecision: 'allowed',
      metadata: { scope: input.scope, preset: input.preset, version: next.version, previousVersion: input.version, capabilityLevels: input.capabilities },
    }
    await tx.audit(audit)
    if (widened.length) {
      await tx.audit({ ...audit, action: 'client_policy.user_exception', metadata: { version: next.version, confirmed: true, capabilities: widened } })
    }
    return adminPolicyView(next)!
  })
}
