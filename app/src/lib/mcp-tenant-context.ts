import type { Prisma, Tenant } from '@prisma/client'
import {
  KNOWLEDGE_PLACEMENT_TABLE_REF,
  renderKnowledgePlacementBlock,
} from '@/lib/agent-knowledge-placement'
import { HERMES_SYNC_PROMPT } from '@/lib/mcp-client-setup'
import { settingsRecord } from '@/lib/tenant-settings'

export const TENANT_MCP_INTRO_SETTING = 'mcpIntro'

const ROLE_INSTRUCTION_PREVIEW_MAX = 240

const MCP_TOOLING_INSTRUCTIONS = [
  'Skills: use resources/list and resources/read on skill:// URIs. If the client cannot read MCP resources directly, call platform.skills.list and then platform.skills.read.',
  'Use tools/list as the callable tool list; an agent definition may also contain capabilities from other runtimes.',
  'Company HTTP APIs (MCP only — there is no separate in-platform agent runtime): for a chosen published agent, call platform.agent.get_definition first. Use definitionId on every enterprise tool. The platform injects CRM/API trace headers (X-Agent-Id, X-Acting-User, X-Connector-Call-Id) from that definition — do not pass agentId, credentials, or those headers. The snapshot lists each bound http_api connector (name, connectorId, endpoints). Call http_api_get / http_api_get_all / http_api_request only with paths from connectors[].endpoints. Use http_api_get_all only when the endpoint has pagination; otherwise it returns an error. With several HTTP connectors, the server usually picks the connector from method+path; if not, pass connectorName (connectors[].name) or connectorId. Do not guess REST paths — unlisted paths return endpoint_not_allowed with the allowed list. Missing endpoints means unfinished connector setup — ask a human. Credentials stay on the connector.',
  'Gmail: gmail_search, then gmail_get_message or gmail_get_thread. To send or reply call gmail_send (reply: replyToMessageId + body keeps the thread); gmail_create_draft saves without sending; gmail_modify_labels marks read/archives/stars; gmail_trash moves to trash. Gmail writes wait for human approval — never answer that email sending is unavailable without trying gmail_send.',
  'Drive: google_drive_search then google_drive_read_file; upload/sheets/create_folder wait for human approval.',
  'Knowledge base: call kb_list_index first. Then kb_get_page for one wiki page (path index.md is the table of contents; pass artifactId) or kb_get_document for one file. Use kb_search only when the catalog does not name the source.',
  'Pinned skill scripts run only via sandbox_run with skillVersionId and entry from the published definition. Optional inputs are comma-separated work-file paths from this project; they appear at /work/in/<path>. The sandbox has no network and no credentials. Do not run skill code on this machine. Outputs land in work files under sandbox-output/.',
  `Project work: ${KNOWLEDGE_PLACEMENT_TABLE_REF} List or create a project with platform.projects.*, then pass the same projectKey on platform.work_file.* and platform.project_memory.* (omit projectKey for __general__). Work files are plans/notes/drafts; project memory is short company facts and decisions (replaceId when corrected). kind "focus" and kind "session_log" follow their rows in the table. Read project memory before writing it. Approval-mode memory writes return awaiting_approval; direct mode writes immediately. The server rejects memory writes that look like an operating rule or a long document — use the table instead.`,
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

function coworkerScope(coworker: McpCoworkerSummary): string {
  return (
    coworker.description?.trim() ||
    coworker.roleInstructionPreview?.trim() ||
    'No description published yet.'
  )
}

function coworkerInstructionLine(coworker: McpCoworkerSummary): string {
  return `- ${coworker.name} (agentId ${coworker.agentId}, ${coworker.status}): Call when: ${coworkerScope(coworker)}`
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

/**
 * `bound`: the client sends the agent-id header, so `coworkers` is already narrowed to that one
 * agent — it must not be told to pick or hand off to a teammate it cannot call.
 */
export function buildMcpServerInstructions(input: {
  tenant: Pick<Tenant, 'displayName' | 'legalName' | 'slug' | 'settings'> | null | undefined
  tenantSlug: string
  coworkers: McpCoworkerSummary[]
  bound?: boolean
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
    'MEMORY FIRST',
    `This server holds the AI agents' memory and knowledge about ${organization}. You can only answer company questions correctly with it. At the start of every conversation call platform.agent.get_definition — its memoryIndex catalog (and focus) is the agent's current memory. Load full text with platform.project_memory.read (ids or query; omit projectKey for general memory). Before answering any company-specific question (where is X, who owns Y, how do we do Z) and before searching Drive, Gmail, KB or APIs, check that memory. Memory overrides search results: if a search finds something else, follow the memory, search for the name it gives, and tell the user about the conflict. When the user corrects a fact, update the memory.`,
    '',
    renderKnowledgePlacementBlock(),
    '',
    'YOUR ROLE',
    'You are the MCP-connected assistant (Cursor, Codex, Claude Desktop, etc.) — not a second runtime inside the platform. Help the user through published agent definitions: platform.whoami, platform.agents.list, then platform.agent.get_definition for the agentId you picked (this also loads its memory). Pass definitionId on every enterprise tool (Drive, Gmail, http_api_*, kb_*).',
    'When you tell the user what this connection is or does, answer in plain business language: name the organization and each published agent by what it helps with. Never recite tool names, connector hostnames, agentIds, or other technical internals — the user does not need this — unless they explicitly ask for technical detail.',
    '',
    'LOCAL AGENT WORKSPACES (optional)',
    'A published agent may have a local folder (Claude Desktop project, Codex workspace). Use platform.agent.checkout to fetch AGENTS.md, manifest, and instruction-only skill files, then write them to suggestedRoot. The same MCP URL and tools apply — checkout files are instructions, not a separate agent process.',
    'When the user says checkout / sync / set up local agents: call platform.agents.list if needed; if exactly one agent is listed below, call platform.agent.checkout with that agentId immediately — do not ask which agent or whether to create vs update.',
    'Check whether suggestedRoot already exists on disk: missing folder = first checkout (create); existing folder = re-sync (overwrite generated paths only, per writeRecipe).',
  ]
  if (!input.bound) {
    lines.push(
      `Hermes: "${HERMES_SYNC_PROMPT}" means one Bot per agent — for every agent in platform.agents.list call platform.agent.checkout with harness:"hermes", write files[] to suggestedRoot, then run the writeRecipe commands with the terminal tool.`,
    )
  }

  if (input.coworkers.length > 0) {
    lines.push('', 'PUBLISHED AGENTS (MCP)')
    for (const coworker of input.coworkers) {
      lines.push(coworkerInstructionLine(coworker))
    }
    if (input.bound) {
      const only = input.coworkers[0]!
      lines.push(
        '',
        'BOUND TO ONE AGENT',
        `This client is bound to ${only.name} by the X-Excellence-Agent-Id header on every request: work as ${only.name} for the whole conversation and call platform.agent.get_definition with no arguments. The organization has other agents, but this client cannot call them — a request that belongs to another teammate is a handoff you tell the user about, never another agentId. Do not run "${HERMES_SYNC_PROMPT}" from this Bot — that belongs in the default Hermes profile.`,
      )
    } else if (input.coworkers.length === 1) {
      const only = input.coworkers[0]!
      lines.push(
        `- Only one agent is visible — load ${only.name} (agentId ${only.agentId}) with platform.agent.get_definition and stay in that role. Default checkout target: ${only.name}.`,
      )
    } else {
      lines.push(
        '',
        'CHOOSE AND STAY',
        'Pick the agent whose "Call when" matches the user\'s request. Do not ask which agent to use. Call platform.agent.get_definition for that agentId, then work in that role for the rest of the conversation. Introduce yourself in business language — name the teammate and what they help with (example: "Kati, the marketing teammate, will take this."). Do not mix roles. If a later request belongs to another agent, tell the user and hand off — do not switch silently.',
        'A slash prompt named after an agent is an explicit choice — load that agent.',
      )
    }
  } else if (input.bound) {
    lines.push(
      '',
      'PUBLISHED AGENTS (MCP)',
      '- The X-Excellence-Agent-Id header on this client names an agent that is not published or not visible to you. Every tool call will be refused until a tenant admin fixes the binding — tell the user that.',
    )
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
