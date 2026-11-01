import { z } from 'zod'
import { CAPABILITY_KEYS, PRESET_IDS, capabilityLevels, strictnessOf, type CapabilityKey, type PresetId } from './capabilities'
import { resolveEffectivePolicy, TOOL_ACTIONS, type PolicyRow, type ToolAction } from './resolve-effective-policy'
import { TOOL_CLASSES, isToolName, parseTenantToolCatalog } from './tool-catalog'
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
  /** #872: eszközönkénti kivétel. A kulcs eszköznév, vagy előtag-minta (`mcp__crm__*`); a `*` csak a végén. */
  toolOverrides: z.record(z.string(), z.enum(TOOL_ACTIONS)).superRefine((values, ctx) => {
    for (const key of Object.keys(values)) {
      if (!isToolCatalogKey(key)) ctx.addIssue({ code: 'custom', path: [key], message: 'Ismeretlen eszköz.' })
    }
  }).optional(),
  version: z.number().int().min(0).max(2_147_483_646),
  confirmWidening: z.boolean().default(false),
}).strict()

export function isToolCatalogKey(key: string): boolean {
  return isToolName(key.endsWith('*') ? key.slice(0, -1) : key)
}

export const toolClassifySchema = z.object({
  tool: z.string().refine(isToolName),
  class: z.enum(TOOL_CLASSES),
}).strict()
export type ToolClassify = z.infer<typeof toolClassifySchema>

export type AdminPolicyTarget = z.infer<typeof adminPolicyTargetSchema>
export type AdminPolicySave = z.infer<typeof adminPolicySaveSchema>
export type AdminPolicyActor = { tenantId: string; userId: string; role: string }
export type AdminPolicy = {
  preset: PresetId | null
  version: number
  capabilities: Record<string, string>
  toolOverrides: Record<string, ToolAction>
}

const asRecord = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}

export function adminPolicyView(row: (Pick<PolicyRow, 'preset' | 'version' | 'capabilities'> & { toolOverrides?: unknown }) | null): AdminPolicy | null {
  if (!row) return null
  const raw = asRecord(row.capabilities)
  return {
    preset: (PRESET_IDS as readonly unknown[]).includes(row.preset) ? row.preset as PresetId : null,
    version: row.version,
    capabilities: Object.fromEntries(CAPABILITY_KEYS.filter((key) => Object.hasOwn(raw, key)).map((key) =>
      [key, typeof raw[key] === 'string' && strictnessOf(key, raw[key]) >= 0 ? raw[key] : capabilityLevels(key)[0]])),
    // A feloldás a hibás akciót tiltásnak veszi, a nézet is azt mutassa.
    toolOverrides: Object.fromEntries(Object.entries(asRecord(row.toolOverrides)).map(([k, v]) =>
      [k, (TOOL_ACTIONS as readonly unknown[]).includes(v) ? v as ToolAction : 'deny'])),
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
    const raw = asRecord(current?.capabilities)
    // The capability editor never changes a separately configured model list or tool catalog;
    // tool rules only when the request carries them.
    const keep = Object.fromEntries((['models', 'toolCatalog'] as const).filter((k) => Object.hasOwn(raw, k)).map((k) => [k, raw[k]]))
    const next: PolicyRow = {
      scope: input.scope, scopeId: input.scopeId, preset: input.preset,
      capabilities: { ...keep, ...input.capabilities },
      toolOverrides: input.toolOverrides ?? current?.toolOverrides ?? {}, version: input.version + 1,
    }
    let widened: string[] = []
    if (input.scope === 'user') {
      const tenant = await tx.find({ scope: 'tenant', scopeId: actor.tenantId })
      const effective = resolveEffectivePolicy({ tenant, user: next, agent: null })
      widened = CAPABILITY_KEYS.filter((key) => effective.reasons[key].widenedBeyondTenant)
      // ponytail: minden user-szintű „engedélyez” kivételnek számít (D3); finomabb, ha a tenant-döntés is számít.
      widened.push(...effective.toolRules.filter((r) => r.source === 'user' && r.action === 'allow').map((r) => `tool:${r.pattern}`))
      if (widened.length && !input.confirmWidening) throw new AdminPolicyError('confirmation_required', widened)
    }
    if (!await tx.save(next, input.version, actor.userId)) throw new AdminPolicyError('version_conflict')
    const audit: AuditAppendInput = {
      actorType: 'human', actorId: actor.userId, tenantId: actor.tenantId,
      action: 'client_policy.save', targetType: `client_policy_${input.scope}`, targetId: input.scopeId,
      policyDecision: 'allowed',
      metadata: {
        scope: input.scope, preset: input.preset, version: next.version, previousVersion: input.version,
        capabilityLevels: input.capabilities, ...(input.toolOverrides ? { toolOverrides: input.toolOverrides } : {}),
      },
    }
    await tx.audit(audit)
    if (widened.length) {
      await tx.audit({ ...audit, action: 'client_policy.user_exception', metadata: { version: next.version, confirmed: true, capabilities: widened } })
    }
    return adminPolicyView(next)!
  })
}

/**
 * #872: egy besorolatlan eszköz tenant-szintű besorolása (vagy végleges tiltása) egy kattintással.
 * Csak a tenant-sor `capabilities.toolCatalog` kulcsát írja; a Guard a következő revalidálásnál látja.
 */
export async function classifyTenantTool(store: AdminPolicyStore, actor: AdminPolicyActor, input: ToolClassify): Promise<AdminPolicy> {
  if (actor.role !== 'admin') throw new AdminPolicyError('forbidden')
  return store.transaction(actor.tenantId, async (tx) => {
    const target = { scope: 'tenant' as const, scopeId: actor.tenantId }
    const current = await tx.find(target)
    const version = current?.version ?? 0
    const capabilities = asRecord(current?.capabilities)
    const next: PolicyRow = {
      ...target, preset: current?.preset ?? null,
      capabilities: { ...capabilities, toolCatalog: { ...parseTenantToolCatalog(capabilities), [input.tool]: input.class } },
      toolOverrides: current?.toolOverrides ?? {}, version: version + 1,
    }
    if (!await tx.save(next, version, actor.userId)) throw new AdminPolicyError('version_conflict')
    await tx.audit({
      actorType: 'human', actorId: actor.userId, tenantId: actor.tenantId,
      action: 'client_policy.tool_classified', targetType: 'client_policy_tenant', targetId: actor.tenantId,
      policyDecision: 'allowed', metadata: { tool: input.tool, toolClass: input.class, version: next.version },
    })
    return adminPolicyView(next)!
  })
}
