import type { Prisma, Tenant } from '@prisma/client'
import { settingsRecord } from '@/lib/tenant-settings'

export const TENANT_MCP_INTRO_SETTING = 'mcpIntro'

const ROLE_INSTRUCTION_PREVIEW_MAX = 240

const MCP_TOOLING_INSTRUCTIONS = [
  'Skills: use resources/list and resources/read on skill:// URIs. If the client cannot read MCP resources directly, call platform.skills.list and then platform.skills.read.',
  'Company HTTP APIs: platform.agent.get_definition lists each coworker\'s bound http_api connectors, and for each one an endpoints array (method, path, description, params) — call get_definition first and use only those paths with http_api_get / http_api_get_all / http_api_request. Do not guess paths (e.g. plausible REST conventions); an unlisted path is rejected with endpoint_not_allowed, which also echoes the allowed list. A connector with no endpoints array is unprovisioned — ask a human to complete its setup rather than guessing. Credentials stay on the connector.',
  'Gmail: gmail_search then gmail_get_message.',
  'Drive: google_drive_search then google_drive_read_file; upload/sheets/create_folder wait for human approval.',
  'Knowledge base: call kb_list_index first. Then kb_get_page for one wiki page (path index.md is the table of contents; pass artifactId) or kb_get_document for one file. Use kb_search only when the catalog does not name the source.',
  'If a tool returns authorizationUrl, show that URL to the user and retry after they finish consent.',
].join(' ')

export type McpCoworkerSummary = {
  agentId: string
  name: string
  status: string
  description?: string | null
  roleInstructionPreview?: string | null
  currentDefinitionId: string | null
  currentVersion: number | null
}

export function readTenantMcpIntro(settings: unknown): string | null {
  const raw = settingsRecord(settings)[TENANT_MCP_INTRO_SETTING]
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function withTenantMcpIntro(settings: unknown, intro: string | null): Prisma.InputJsonValue {
  const next = { ...settingsRecord(settings) }
  const trimmed = intro?.trim() ?? ''
  if (trimmed.length > 0) next[TENANT_MCP_INTRO_SETTING] = trimmed
  else delete next[TENANT_MCP_INTRO_SETTING]
  return next
}

export function previewRoleInstruction(value: string | null | undefined, max = ROLE_INSTRUCTION_PREVIEW_MAX): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1).trimEnd()}…`
}

export function tenantDisplayLabel(tenant: Pick<Tenant, 'displayName' | 'legalName' | 'slug'> | null | undefined): string {
  if (!tenant) return 'this organization'
  if (tenant.legalName?.trim()) return tenant.legalName.trim()
  if (tenant.displayName?.trim()) return tenant.displayName.trim()
  return tenant.slug
}

export function buildTenantContextPayload(input: {
  tenant: Pick<Tenant, 'displayName' | 'legalName' | 'slug' | 'settings'> | null | undefined
  tenantSlug: string
  coworkers: McpCoworkerSummary[]
}) {
  const tenant = input.tenant
  return {
    tenantSlug: input.tenantSlug,
    tenantDisplayName: tenant?.displayName ?? null,
    tenantLegalName: tenant?.legalName ?? null,
    organizationLabel: tenantDisplayLabel(tenant),
    mcpIntro: readTenantMcpIntro(tenant?.settings),
    coworkers: input.coworkers.map((coworker) => ({
      agentId: coworker.agentId,
      name: coworker.name,
      status: coworker.status,
      description: coworker.description ?? null,
      roleInstructionPreview: coworker.roleInstructionPreview ?? null,
      currentDefinitionId: coworker.currentDefinitionId,
      currentVersion: coworker.currentVersion,
    })),
  }
}

export function buildMcpServerInstructions(input: {
  tenant: Pick<Tenant, 'displayName' | 'legalName' | 'slug' | 'settings'> | null | undefined
  tenantSlug: string
  coworkers: McpCoworkerSummary[]
}): string {
  const organization = tenantDisplayLabel(input.tenant)
  const intro =
    readTenantMcpIntro(input.tenant?.settings) ??
    `This MCP endpoint serves ${organization} (${input.tenantSlug}). Published AI agents are the user's coworkers — list them with platform.agents.list, load one with platform.agent.get_definition, or check out a workspace with platform.agent.checkout.`

  const lines = [
    `You are connected to Excellence AI for ${organization} (tenant slug: ${input.tenantSlug}).`,
    '',
    'ORGANIZATION',
    intro,
    '',
    'YOUR ROLE',
    'Help the signed-in user work with this organization\'s data through published AI agents ("coworkers"). Start with platform.whoami and platform.agents.list when the user asks who you are or which coworkers are available. Before enterprise tools for a specific agent, call platform.agent.get_definition for that agentId.',
    'When you tell the user what this connection is or does, answer in plain business language: name the organization and the coworker(s) by what they help with. Never recite tool names, connector hostnames, agentIds, or other technical internals — the user does not know or need this — unless they explicitly ask for technical detail.',
    '',
    'LOCAL COWORKER WORKSPACES',
    'Each published coworker can have a dedicated local folder (Claude Desktop project, Codex workspace). Use platform.agent.checkout to fetch AGENTS.md, manifest, and instruction-only skill files, then write them to suggestedRoot.',
    'When the user says checkout / sync / set up local agents: call platform.agents.list if needed; if exactly one coworker is listed below, call platform.agent.checkout with that agentId immediately — do not ask which agent or whether to create vs update.',
    'Check whether suggestedRoot already exists on disk: missing folder = first checkout (create); existing folder = re-sync (overwrite generated paths only, per writeRecipe).',
  ]

  if (input.coworkers.length > 0) {
    lines.push('', 'AVAILABLE COWORKERS')
    for (const coworker of input.coworkers) {
      const summary =
        coworker.description?.trim() ||
        coworker.roleInstructionPreview?.trim() ||
        'No description published yet.'
      lines.push(`- ${coworker.name} (agentId ${coworker.agentId}, ${coworker.status}): ${summary}`)
    }
    if (input.coworkers.length === 1) {
      lines.push(
        `- Only one coworker is visible — default checkout target: ${input.coworkers[0]!.name} (agentId ${input.coworkers[0]!.agentId}).`,
      )
    }
  } else {
    lines.push('', 'AVAILABLE COWORKERS', '- None visible to this principal yet. Call platform.agents.list after grants are in place.')
  }

  lines.push('', 'TOOLING', MCP_TOOLING_INSTRUCTIONS)
  return lines.join('\n')
}

export function mcpServerDisplayName(tenant: Pick<Tenant, 'displayName'> | null | undefined): string {
  const name = tenant?.displayName?.trim()
  return name ? `${name} · Excellence AI` : 'Excellence AI'
}
