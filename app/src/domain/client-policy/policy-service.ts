/**
 * Hermes Managed Client — policy-snapshot service (#746 V1-1).
 * A betöltés itt van, a feloldás a tiszta `resolveEffectivePolicy`-ban. A HTTP-route (V1-2) erre épül.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { CAPABILITY_KEYS } from '@/domain/client-policy/capabilities'
import { resolveEffectivePolicy, TOOL_ACTIONS, type PolicyRow } from '@/domain/client-policy/resolve-effective-policy'
import { TOOL_CLASSES, effectiveToolCatalog, parseTenantToolCatalog, type ToolCatalogEntry } from '@/domain/client-policy/tool-catalog'

export interface ClientPolicyStore {
  /** A tenant-, a user- és (ha van) az agent-szintű sor; ami nincs, nem szerepel. */
  findRows(input: { tenantId: string; userId: string; agentId: string | null }): Promise<PolicyRow[]>
}

export const policySnapshotSchema = z.object({
  tenantId: z.string(),
  userId: z.string(),
  agentId: z.string().nullable(),
  policyVersion: z.string(),
  issuedAt: z.string(),
  capabilities: z.record(z.enum(CAPABILITY_KEYS as [string, ...string[]]), z.string()),
  tenantDeniedTools: z.array(z.string()).default([]),
  agentCeilings: z.record(z.string(), z.string()),
  models: z.array(z.string()).nullable(),
  toolRules: z.array(z.object({ pattern: z.string(), action: z.enum(TOOL_ACTIONS), source: z.enum(['tenant', 'user', 'agent']) })),
  floor: z.object({
    modelGatewayRequired: z.literal(true),
    guardRequired: z.literal(true),
    auditMinimum: z.literal('metadata'),
    enterpriseToolsServerAuthorized: z.literal(true),
  }),
  reasons: z.record(z.string(), z.object({ source: z.string(), widenedBeyondTenant: z.boolean() })),
  /** #872: eszköz → osztály; a Guard ebből dönt, a saját listája csak offline tartalék. */
  toolCatalog: z.array(z.object({ pattern: z.string(), class: z.enum(TOOL_CLASSES) })),
  catalogVersion: z.string(),
})
export type PolicySnapshot = z.infer<typeof policySnapshotSchema>

export function catalogVersion(catalog: readonly ToolCatalogEntry[]): string {
  const canonical = JSON.stringify(catalog.map((e) => [e.pattern, e.class]))
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

export async function getPolicySnapshot(
  store: ClientPolicyStore,
  input: { tenantId: string; userId: string; agentId: string | null },
  now: () => Date = () => new Date(),
): Promise<PolicySnapshot> {
  const rows = await store.findRows(input)
  const pick = (scope: PolicyRow['scope'], scopeId: string | null) =>
    (scopeId && rows.find((r) => r.scope === scope && r.scopeId === scopeId)) || null
  const tenant = pick('tenant', input.tenantId)
  const effective = resolveEffectivePolicy({
    tenant,
    user: pick('user', input.userId),
    agent: pick('agent', input.agentId),
  })
  const toolCatalog = effectiveToolCatalog(parseTenantToolCatalog(tenant?.capabilities))
  return policySnapshotSchema.parse({
    ...input, ...effective,
    tenantDeniedTools: resolveEffectivePolicy({ tenant, user: null, agent: null }).toolRules
      .filter((rule) => rule.action === 'deny').map((rule) => rule.pattern),
    toolCatalog, catalogVersion: catalogVersion(toolCatalog), issuedAt: now().toISOString(),
  })
}
