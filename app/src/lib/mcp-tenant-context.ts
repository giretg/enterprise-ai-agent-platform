import type { Prisma, Tenant } from '@prisma/client'
import { settingsRecord } from '@/lib/tenant-settings'

export const TENANT_MCP_INTRO_SETTING = 'mcpIntro'

const ROLE_INSTRUCTION_PREVIEW_MAX = 240

const MCP_TOOLING_INSTRUCTIONS = [
  'Skills: use resources/list and resources/read on skill:// URIs. If the client cannot read MCP resources directly, call platform.skills.list and then platform.skills.read.',
  'Company HTTP APIs (MCP only — there is no separate in-platform agent runtime): for a chosen published agent, call platform.agent.get_definition first. Use definitionId on every enterprise tool. The snapshot lists each bound http_api connector (name, connectorId, endpoints). Call http_api_get / http_api_get_all / http_api_request only with paths from connectors[].endpoints. With several HTTP connectors, the server usually picks the connector from method+path; if not, pass connectorName (connectors[].name) or connectorId. Do not guess REST paths — unlisted paths return endpoint_not_allowed with the allowed list. Missing endpoints means unfinished connector setup — ask a human. Credentials stay on the connector.',
  'Gmail: gmail_search then gmail_get_message.',
  'Drive: google_drive_search then google_drive_read_file; upload/sheets/create_folder wait for human approval.',
  'Knowledge base: call kb_list_index first. Then kb_get_page for one wiki page (path index.md is the table of contents; pass artifactId) or kb_get_document for one file. Use kb_search only when the catalog does not name the source.',
  'Project work: list or create a project with platform.projects.*, then pass the same projectKey on platform.work_file.* and platform.project_memory.* (omit projectKey for __general__). Work files are the plan/notes — write them freely, do not put them in the checkout folder. Project memory is continuity (decision, open_task, pointer to a work file), tagged with the calling user by the server. Read project memory before writing it: when a fact changes or is corrected, update the existing item (replaceId) instead of adding a second one. Approval-mode memory writes return awaiting_approval; direct mode writes immediately. Trained operating rules are never written by these tools.',
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
    `This MCP endpoint serves ${organization} (${input.tenantSlug}). Published AI agents are configured here; you reach them only through these MCP tools — list with platform.agents.list, load a snapshot with platform.agent.get_definition, or sync a local workspace with platform.agent.checkout.`

  const lines = [
    `You are connected to Excellence AI for ${organization} (tenant slug: ${input.tenantSlug}).`,
    '',
    'ORGANIZATION',
    intro,
    '',
    'YOUR ROLE',
    'You are the MCP-connected assistant (Cursor, Codex, Claude Desktop, etc.) — not a second runtime inside the platform. Help the user through published agent definitions: platform.whoami, platform.agents.list, then platform.agent.get_definition for the agentId you will use. Pass definitionId on every enterprise tool (Drive, Gmail, http_api_*, kb_*).',
    'When you tell the user what this connection is or does, answer in plain business language: name the organization and each published agent by what it helps with. Never recite tool names, connector hostnames, agentIds, or other technical internals — the user does not need this — unless they explicitly ask for technical detail.',
    '',
    'LOCAL AGENT WORKSPACES (optional)',
    'A published agent may have a local folder (Claude Desktop project, Codex workspace). Use platform.agent.checkout to fetch AGENTS.md, manifest, and instruction-only skill files, then write them to suggestedRoot. The same MCP URL and tools apply — checkout files are instructions, not a separate agent process.',
    'When the user says checkout / sync / set up local agents: call platform.agents.list if needed; if exactly one agent is listed below, call platform.agent.checkout with that agentId immediately — do not ask which agent or whether to create vs update.',
    'Check whether suggestedRoot already exists on disk: missing folder = first checkout (create); existing folder = re-sync (overwrite generated paths only, per writeRecipe).',
  ]

  if (input.coworkers.length > 0) {
    lines.push('', 'PUBLISHED AGENTS (MCP)')
    for (const coworker of input.coworkers) {
      const summary =
        coworker.description?.trim() ||
        coworker.roleInstructionPreview?.trim() ||
        'No description published yet.'
      lines.push(`- ${coworker.name} (agentId ${coworker.agentId}, ${coworker.status}): ${summary}`)
    }
    if (input.coworkers.length === 1) {
      lines.push(
        `- Only one agent is visible — default checkout target: ${input.coworkers[0]!.name} (agentId ${input.coworkers[0]!.agentId}).`,
      )
    }
  } else {
    lines.push('', 'PUBLISHED AGENTS (MCP)', '- None visible to this principal yet. Call platform.agents.list after grants are in place.')
  }

  lines.push('', 'TOOLING', MCP_TOOLING_INSTRUCTIONS)
  return lines.join('\n')
}

export function mcpServerDisplayName(tenant: Pick<Tenant, 'displayName'> | null | undefined): string {
  const name = tenant?.displayName?.trim()
  return name ? `${name} · Excellence AI` : 'Excellence AI'
}
