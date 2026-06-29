/**
 * A provisioning-asszisztens által generált connector-deskriptor alakja
 * (Feature-spec — Provisioning-Assistant §4.3). Determinisztikusan ellenőrizhető
 * szerkezet; a draft `connectors.config`-jába kerül `lifecycle_state = draft`
 * állapotban. A séma maga NEM hoz biztonsági döntést — azt a determinisztikus
 * validátor (§4.4, draft-validator.ts) végzi.
 */
import { z } from 'zod'

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

/** Az írni tudó (mutáló) metódusok — ezek `access: write` jelölést kapnak (§4.3). */
export const WRITE_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
])

export const proposedToolSchema = z.object({
  name: z.string().min(1),
  method: z.enum(HTTP_METHODS),
  path: z.string().min(1),
  access: z.enum(['read', 'write']),
  description: z.string().optional(),
})
export type ProposedTool = z.infer<typeof proposedToolSchema>

export const connectorAuthSchema = z.object({
  type: z.enum(['api_key_header', 'bearer_token', 'basic', 'oauth2']),
  headerName: z.string().optional(),
  /** A secret SOSEM kerül ide — csak a Secret Managerbe szánt alias NEVE javasolt. */
  secretAliasSuggested: z.string().optional(),
})
export type ConnectorAuth = z.infer<typeof connectorAuthSchema>

export const connectorConfigSchema = z.object({
  provider: z.string().min(1),
  baseUrl: z.string().url(),
  egressHosts: z.array(z.string().min(1)).min(1),
  authMode: z.enum(['service', 'user_delegated', 'agent_owned']),
  auth: connectorAuthSchema,
  scopesSuggested: z.array(z.string()).default([]),
  rateLimit: z
    .object({ rps: z.number().nonnegative(), burst: z.number().nonnegative() })
    .optional(),
  proposedTools: z.array(proposedToolSchema).default([]),
  provenance: z
    .object({ sourceHash: z.string().optional(), extractedAt: z.string().optional() })
    .optional(),
})
export type ConnectorConfig = z.infer<typeof connectorConfigSchema>

export class ConnectorConfigParseError extends Error {
  constructor(
    message: string,
    public readonly issues: unknown,
  ) {
    super(message)
    this.name = 'ConnectorConfigParseError'
  }
}

/**
 * Az `access` jelölést a metódusból normalizáljuk: minden mutáló metódus
 * `write`, ettől eltérő bemenetet felülírunk (a draft nem tüntethet el egy
 * write-tool figyelmeztetést egy téves `read` jelöléssel). Ez determinisztikus,
 * nem LLM-döntés.
 */
export function normalizeConnectorConfig(input: unknown): ConnectorConfig {
  const parsed = connectorConfigSchema.safeParse(input)
  if (!parsed.success) {
    throw new ConnectorConfigParseError(
      'generatedConfig does not match ConnectorConfig schema',
      parsed.error.issues,
    )
  }
  const cfg = parsed.data
  return {
    ...cfg,
    proposedTools: cfg.proposedTools.map((t) => ({
      ...t,
      access: WRITE_METHODS.has(t.method) ? 'write' : t.access,
    })),
  }
}
