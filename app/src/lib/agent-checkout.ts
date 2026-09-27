import { dump as yamlDump } from 'js-yaml'
import { MCP_ALLOWED_TOOLS } from '@/auth/mcp-principal'
import type { AgentDefinition } from '@/domain/agent-definition'
import { hashSnapshot } from '@/domain/agent-definition'
import { CODE_EXTENSIONS } from '@/lib/skill/skill-package-adapter'
import { serializeSkillMd } from '@/lib/skill/skill-md-export'
import { skillFileUri, skillUriName } from '@/lib/skill/mcp-skill'
import type { SkillContent, SkillRequirement } from '@/lib/skill/skill-content'

const MCP_TOOL_SET = new Set<string>(MCP_ALLOWED_TOOLS)

const CHECKOUT_EXTENSIONS = new Set(['md', 'json', 'yaml'])
const MANIFEST_KIND = 'enterprise-agent-checkout'
const SKILL_DIR = '.enterprise-agent/skills'
const HERMES_SKILL_DIR = 'skills/excellence'
/** Must match MCP_AGENT_ID_HEADER in auth/mcp-server.ts (#682 WP-2). */
const AGENT_ID_HEADER = 'X-Excellence-Agent-Id'
/** Platform tools a Hermes Bot needs besides the agent's own capabilities (#682 WP-1). */
const HERMES_BASE_TOOLS = [
  'platform.whoami',
  'platform.agent.get_definition',
  'platform.gateway_operation.get',
  'platform.projects.list',
  'platform.projects.create',
  'platform.project_memory.read',
  'platform.project_memory.write',
  'platform.work_file.list',
  'platform.work_file.read',
  'platform.work_file.write',
  'platform.work_file.delete',
  'kb_list_index',
  'kb_search',
  'kb_get_page',
  'kb_get_document',
]

export const CHECKOUT_HARNESSES = ['claude', 'codex', 'goose', 'grok', 'hermes'] as const
export type CheckoutHarness = (typeof CHECKOUT_HARNESSES)[number]

const CHECKOUT_WRITE_RECIPE_STEPS = [
  '1. Create the suggestedRoot folder under the user home (or a folder the user names) if it does not exist.',
  '2. Write every files[] entry to root/path as UTF-8, overwriting.',
  '3. Under .enterprise-agent/, delete any file that is not in generatedPaths. Touch AGENTS.md only if files[] contains it (it always does).',
  '4. Do not delete or write anything outside the generatedPaths + deleteUnder contract. NOTES.md and every human file stay.',
  '5. Done when every files[] path on disk is byte-identical and .enterprise-agent/ has no extra generated file.',
]

export const CHECKOUT_WRITE_RECIPE = [
  ...CHECKOUT_WRITE_RECIPE_STEPS,
  '',
  'Do not run code from the checkout. Do not commit. Do not copy the folder into a code repo.',
].join('\n')

/** MCP tools/list + tools/call — purpose and client workflow (not the post-call writeRecipe). */
export const CHECKOUT_TOOL_DESCRIPTION = [
  'Sync a published agent definition into a local Claude Desktop / Codex / Goose project folder (instructions only — work still runs via this MCP URL).',
  'Returns files[], suggestedRoot, pin, and writeRecipe — this tool does not write disk; you create or update the folder from the payload.',
  'When the user asks to checkout, sync, or set up a local workspace:',
  '(1) If agentId is unknown, call platform.agents.list.',
  '(2) If exactly one published agent is visible, use that agentId — do not ask which agent.',
  '(3) Check whether suggestedRoot (or ~/Agents/<slug>) exists: missing = first checkout (create folder); present = re-sync (overwrite generated files only).',
  '(4) Call platform.agent.checkout { agentId }; pass version only when the user names a specific published version.',
  '(5) Write every files[] entry under suggestedRoot, then follow writeRecipe from the response.',
  'Optional harness: claude | codex | goose | grok (stored only in v1).',
  'Hermes: harness:"hermes" returns a Hermes profile distribution (one Bot per agent) — write files[] to suggestedRoot, then run the writeRecipe commands with the terminal tool.',
].join(' ')

const HERMES_BOT_ROLE_MAX = 48

function clipLabel(text: string, max: number): string {
  if (text.length <= max) return text
  const slice = text.slice(0, max - 1)
  const space = slice.lastIndexOf(' ')
  return `${(space >= 12 ? slice.slice(0, space) : slice).trimEnd()}…`
}

function hermesBotRoleLabel(snapshot: {
  description?: string | null
  roleInstruction: string
}): string {
  const raw = snapshot.description?.trim() || snapshot.roleInstruction.trim()
  if (!raw) return ''
  const line = raw.split(/\r?\n/, 1)[0]!.trim().replace(/\s+/g, ' ')
  const sentence = line.split(/(?<=[.!?])\s+/u, 1)[0] ?? line
  return clipLabel(sentence.replace(/[.]+$/u, ''), HERMES_BOT_ROLE_MAX)
}

/** Hermes Bot Mode roster label: "Zoli (POSnavigator marketing)". Profile id stays `exc-…`. */
export function hermesBotTitle(snapshot: {
  name: string
  description?: string | null
  roleInstruction: string
}): string {
  const name = snapshot.name.trim() || 'agent'
  const role = hermesBotRoleLabel(snapshot)
  if (!role || role.toLowerCase() === name.toLowerCase()) return name
  if (name.toLowerCase().includes(role.toLowerCase())) return name
  return `${name} (${role})`
}

function hermesWriteRecipe(root: string, profile: string): string {
  const home = `~/${root}`
  const dir = `~/.hermes/profiles/${profile}`
  return [
    `Hermes Bot sync. Run these with the terminal tool. ROOT=${home} (distribution source), PROFILE=${profile}.`,
    '1. Create ROOT if missing. Write every files[] entry to ROOT/path as UTF-8, overwriting. Under ROOT/.enterprise-agent/ and ROOT/skills/excellence/, delete any file that is not in generatedPaths.',
    '2. Run `hermes profile list`. If PROFILE is not listed (new Bot):',
    `   a. hermes profile install "$HOME/${root}" --name ${profile} -y`,
    `   b. If ${dir}/profile.yaml or ${dir}/config.yaml is missing, copy it from ROOT.`,
    `   c. Model key: read model.provider from ${dir}/config.yaml, or else from ~/.hermes/config.yaml. Copy only that provider's API-key line(s) (for example OPENROUTER_API_KEY) from ~/.hermes/.env into ${dir}/.env, then chmod 600 it. Never copy the whole .env and never print a key. If the provider signs in with OAuth (Codex, Copilot), tell the user to run: hermes -p ${profile} auth add <provider>`,
    `   d. hermes -p ${profile} mcp login excellence  (opens the browser once; the user approves it)`,
    '3. If PROFILE is already listed (re-sync):',
    `   a. hermes profile update ${profile} -y  (keeps the Bot's chats, memory, .env, MCP login, config.yaml and profile.yaml)`,
    `   b. Delete any folder under ${dir}/skills/excellence/ whose name is not a skills/excellence/<name>/ folder in files[]. Touch nothing else in ${dir}.`,
    `4. Apply the Bot label from ROOT/profile.yaml onto ${dir}/profile.yaml: copy display_name and ui_meta.hermes-bots.title only. If ${dir}/profile.yaml is missing, copy it from ROOT first. Keep avatar, color, section, and every other ui_meta key.`,
    '5. Never run `hermes profile delete`. If an agent is no longer in platform.agents.list, only tell the user that its Bot is no longer available.',
    '',
    'Do not run code from the checkout. Do not commit. Do not copy the folder into a code repo.',
  ].join('\n')
}

export function checkoutWriteRecipe(harness?: CheckoutHarness | null): string {
  const lines = [...CHECKOUT_WRITE_RECIPE_STEPS]
  if (harness === 'codex') {
    lines.push(
      '6. (Codex Desktop, macOS) Run `codex app "<absolute suggestedRoot>"` to open this workspace. If it does not appear in the sidebar, add it manually via “Use an existing folder”.',
    )
  }
  lines.push('', 'Do not run code from the checkout. Do not commit. Do not copy the folder into a code repo.')
  return lines.join('\n')
}

export type CheckoutSkill = {
  skillId: string
  skillVersionId: string
  name: string
  displayName?: string | null
  description: string
  license?: string | null
  content: SkillContent
  requires: SkillRequirement[]
}

export type CheckoutFile = { path: string; content: string }

export type CheckoutPin = {
  agentId: string
  definitionId: string
  version: number
  contentHash: string
  tenantSlug: string
  harness: CheckoutHarness | null
}

export type CheckoutBundle = {
  suggestedRoot: string
  mcpUrl: string
  pin: CheckoutPin
  files: CheckoutFile[]
  generatedPaths: string[]
  deleteUnder: string[]
  warnings: string[]
  writeRecipe: string
}

export function asCheckoutHarness(value: unknown): CheckoutHarness | null {
  return typeof value === 'string' && (CHECKOUT_HARNESSES as readonly string[]).includes(value)
    ? (value as CheckoutHarness)
    : null
}

export function checkoutSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z0-9]+/g)
    ?.join('-') ?? ''
  const trimmed = slug.slice(0, 60).replace(/-+$/, '')
  return trimmed || 'agent'
}

function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return name.toLowerCase()
  return name.slice(dot + 1).toLowerCase()
}

/** Fail-closed: relative, `/`-separated, no `..`, extension ∈ {md,json}, never CODE_EXTENSIONS. */
export function assertSafeCheckoutPath(path: string): void {
  const segments = path.split('/')
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Unsafe checkout path: ${path}`)
  }
  const ext = extensionOf(path)
  if (!CHECKOUT_EXTENSIONS.has(ext) || CODE_EXTENSIONS.has(ext)) {
    throw new Error(`Unsafe checkout path: ${path}`)
  }
}

function tenantSlugFromMcpUrl(mcpUrl: string): string {
  const trimmed = mcpUrl.replace(/\/+$/, '')
  return trimmed.split('/').at(-1) ?? ''
}

function skillFolderName(skill: CheckoutSkill, colliding: boolean): string {
  const slug = checkoutSlug(skill.name)
  if (!colliding) return slug
  return `${slug}--${skill.skillId.replace(/-/g, '').slice(0, 8)}`
}

const BRIEFING_MAX_SKILLS = 25
const BRIEFING_SKILL_DESCRIPTION_MAX = 240
const BRIEFING_MAX_TRIGGERS = 8

function mcpToolNames(capabilities: Array<{ toolName: string; allowed: boolean }>): string[] {
  return capabilities.filter((row) => row.allowed && MCP_TOOL_SET.has(row.toolName)).map((row) => row.toolName)
}

function sandboxMcpRule(capabilities: Array<{ toolName: string; allowed: boolean }>): string {
  const sandboxTool = mcpToolNames(capabilities).find(
    (name) => name === 'sandbox_run' || name === 'sandbox_exec',
  )
  if (sandboxTool) {
    return `- Runnable skill code runs only via \`${sandboxTool}\` with the skillVersionId. Do not run skill code on this machine, and do not upload a local file into the sandbox.`
  }
  return '- Do not run skill code on this machine.'
}

/**
 * The agent briefing (#652): one text for get_definition.briefing, the MCP
 * prompt and the checkout AGENTS.md / SOUL.md, so every channel loads the same
 * agent. Only tables of contents — besides roleInstruction its size is bounded.
 * bound: the client sends the agent-id header, so it passes no definitionId.
 */
export function renderAgentBriefing(input: {
  definition: AgentDefinition
  skills: CheckoutSkill[]
  bound?: boolean
}): string {
  const { agentId, snapshot } = input.definition
  const description = snapshot.description?.trim()
  const httpApis = snapshot.connectors.filter((row) => row.type === 'http_api')
  const loaded = new Map(input.skills.map((skill) => [skill.skillVersionId, skill]))
  const skills = snapshot.skills
    .flatMap((pin) => {
      const skill = loaded.get(pin.skillVersionId)
      return skill ? [{ pin, skill }] : []
    })
    .sort((a, b) => Number(Boolean(b.pin.entry)) - Number(Boolean(a.pin.entry)))
  const entry = skills[0]?.pin.entry ? skills[0].pin : null
  const skillUri = (name: string) => `\`${skillFileUri(skillUriName(name), 'SKILL.md')}\``
  const start = [
    input.bound
      ? 'Call platform.agent.get_definition (no arguments) and read generalMemory — this agent\'s memory. If you are reading this in that response, it is already loaded.'
      : `Call platform.agent.get_definition { "agentId": "${agentId}" } and read generalMemory — this agent's memory. If you are reading this in that response, it is already loaded.`,
    'Check open work: platform.work_file.list for plans and open tasks.',
    ...(entry
      ? [`For every new task, first read the entry skill ${entry.name} (${skillUri(entry.name)}) and follow it — it tells you which other skill to use.`]
      : []),
    'Then continue with the user\'s request.',
  ]
  const lines = [
    '## Who you are',
    '',
    `You are now ${snapshot.name}${description ? ` — ${description}` : ''}. Take on this agent's role for the whole conversation and work by the rules below. Do not ask which agent to use; introduce yourself in this role in your first reply.`,
    '',
    snapshot.roleInstruction,
    '',
    '## Rules you must not break',
    '',
    '- This agent\'s memory is the source of company facts, decisions and locations. It overrides search results: if Drive, KB or API results contradict it, follow the memory and tell the user about the conflict.',
    '- Never bypass approval: writes wait for a human in the Control Plane (see Approvals and handoffs).',
    input.bound
      ? `- This client is bound to this agent by the ${AGENT_ID_HEADER} header on every MCP request: do not pass definitionId or agentId — the server uses the agent's current published definition.`
      : '- Pass definitionId from platform.agent.get_definition on every enterprise tool (Drive, Gmail, http_api_*, kb_*).',
    ...(httpApis.length > 0
      ? ['- HTTP APIs: use only the method+path values listed in platform.agent.get_definition → snapshot.connectors[].endpoints.']
      : []),
    sandboxMcpRule(snapshot.capabilities),
    '- Keep durable work on the platform: no local memory (file or client memory), no durable work in a local folder. Credentials stay on the server.',
    '',
    '## Start',
    '',
    ...start.map((step, index) => `${index + 1}. ${step}`),
    '',
    '## Knowledge, memory, skills',
    '',
    'All work for this agent runs through this MCP server — there is no separate in-platform chat runtime.',
    '',
    '- Memory: generalMemory in platform.agent.get_definition. Read it before answering company questions or searching. More: platform.project_memory.read / write (omit projectKey for general memory).',
    '- Work files (plans, notes, open tasks): platform.work_file.* under a projectKey.',
    '- Knowledge base: call kb_list_index first (one row per source). Then kb_get_page for one wiki page, or kb_get_document for one file. Use kb_search only when the catalog does not name the source.',
  ]

  const tools = mcpToolNames(snapshot.capabilities)
  if (tools.length > 0) lines.push(`- MCP tools: ${tools.join(', ')}.`)
  if (snapshot.connectors.some((row) => row.type === 'google_drive')) {
    lines.push('- Google Drive connector: use the Drive MCP tools by name.')
  }
  if (httpApis.length > 0) {
    lines.push(
      '- HTTP API connectors (with several, pass connectors[].name as connectorName or connectorId when method+path is ambiguous):',
    )
    for (const row of httpApis) {
      lines.push(`  - ${row.name?.trim() || row.connectorId} (${row.accessMode}, connectorId ${row.connectorId})`)
    }
  }

  if (skills.length > 0) {
    lines.push(
      '',
      `Skills — only these belong to this agent; read the SKILL.md before you do that kind of work (resources/read, or platform.skills.read { uri${input.bound ? '' : ', definitionId'} }):`,
      '',
    )
    for (const { pin, skill } of skills.slice(0, BRIEFING_MAX_SKILLS)) {
      const triggers = skill.content.triggerKeywords.slice(0, BRIEFING_MAX_TRIGGERS)
      const trigger = triggers.length > 0 ? ` Triggers: ${triggers.join(', ')}.` : ''
      const text = clipLabel(skill.description.trim().replace(/\s+/g, ' '), BRIEFING_SKILL_DESCRIPTION_MAX)
      const label = pin.entry ? ' (entry skill — read first on every new task)' : ''
      lines.push(`- ${pin.name}${label}: ${text}${trigger} ${skillUri(pin.name)}`)
    }
    if (skills.length > BRIEFING_MAX_SKILLS) {
      lines.push(`- …and ${skills.length - BRIEFING_MAX_SKILLS} more in platform.agent.get_definition → snapshot.skills.`)
    }
  }

  lines.push(
    '',
    '## Closing',
    '',
    'When a task is done or the conversation ends:',
    '1. Save new company facts and decisions with platform.project_memory.write; when the user corrected a fact, update it.',
    '2. Update the plan and open tasks in the work file (platform.work_file.write).',
    '',
    '## Approvals and handoffs',
    '',
    'Writes (for example creating a Drive folder or http_api_request) do not run until a human approves them in the Control Plane: the tool returns status awaiting_approval and an approvalUrl. Show that link to the user; do not poll or retry.',
  )
  return lines.join('\n')
}

/** MCP prompt text (#651): the first message that puts the client AI into this agent's role. */
export function renderAgentPrompt(input: {
  definition: AgentDefinition
  skills: CheckoutSkill[]
  task?: string
  bound?: boolean
}): string {
  const { agentId, definitionId, version } = input.definition
  const lines = [
    `agentId: ${agentId}`,
    `definitionId: ${definitionId} (version ${version})`,
    '',
    renderAgentBriefing(input),
  ]
  const task = input.task?.trim()
  if (task) lines.push('', "## Today's task", '', task)
  return `${lines.join('\n')}\n`
}

function renderAgentsMd(input: {
  definition: AgentDefinition
  contentHash: string
  mcpUrl: string
  skills: CheckoutSkill[]
  hermes?: boolean
}): string {
  const lines = [
    `# ${input.definition.snapshot.name}`,
    '',
    `agentId: ${input.definition.agentId}`,
    `version: ${input.definition.version}`,
    `contentHash: ${input.contentHash}`,
    `mcpUrl: ${input.mcpUrl}`,
    '',
    renderAgentBriefing({ definition: input.definition, skills: input.skills, bound: input.hermes }),
  ]
  if (input.skills.length > 0) {
    lines.push('', `Local copies of these skills: \`${input.hermes ? HERMES_SKILL_DIR : SKILL_DIR}/<name>/SKILL.md\`.`)
  }

  if (input.hermes) {
    lines.push(
      '',
      '## Stale',
      '',
      'At the start of every session call `platform.agent.get_definition` (no arguments).',
      'If the returned `contentHash` differs from the contentHash above, tell the user once: this Bot\'s role or skills changed on the platform — run "Sync my Excellence agents" in the default Hermes profile. Keep working meanwhile: tools already use the current definition.',
    )
  } else {
    lines.push(
      '',
      '## Stale',
      '',
      'Before any enterprise tool (Drive, Gmail, http_api_*, kb_*), call `platform.agent.get_definition` for this agentId and use its definitionId. Exempt: `platform.whoami`, `platform.agents.list`, `platform.agent.get_definition`, `platform.agent.checkout`.',
      'If the returned `contentHash` differs from the pin above, call `platform.agent.checkout`, overwrite generated paths, then retry.',
      'Enterprise tools reject stale pins with `agent_stale` until checkout completes and the manifest `definitionId` matches the current published version.',
    )
  }

  return `${lines.join('\n')}\n`
}

export function renderAgentCheckout(input: {
  definition: AgentDefinition
  skills: CheckoutSkill[]
  mcpUrl: string
  harness?: CheckoutHarness | null
}): CheckoutBundle {
  const warnings: string[] = []
  const snapshot = input.definition.snapshot
  if (!snapshot.roleInstruction.trim()) warnings.push('empty roleInstruction')

  const loaded = new Map(input.skills.map((skill) => [skill.skillVersionId, skill]))
  const pins = [...snapshot.skills].sort((a, b) => a.skillId.localeCompare(b.skillId))
  const resolved: CheckoutSkill[] = []
  for (const pin of pins) {
    const skill = loaded.get(pin.skillVersionId)
    if (!skill || skill.skillId !== pin.skillId) {
      warnings.push(`missing skill version ${pin.skillVersionId}`)
      continue
    }
    resolved.push({ ...skill, name: pin.name })
  }

  const slugCounts = new Map<string, number>()
  for (const skill of resolved) {
    const slug = checkoutSlug(skill.name)
    slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1)
  }
  for (const [slug, count] of slugCounts) {
    if (count > 1) warnings.push(`skill name collision: ${slug}`)
  }

  const skillFiles: CheckoutFile[] = []
  const skillPointers: Array<{
    name: string
    path: string
    skillId: string
    skillVersionId: string
  }> = []
  const hermes = input.harness === 'hermes'
  for (const skill of resolved) {
    const folder = skillFolderName(skill, (slugCounts.get(checkoutSlug(skill.name)) ?? 0) > 1)
    const path = `${hermes ? HERMES_SKILL_DIR : SKILL_DIR}/${folder}/SKILL.md`
    assertSafeCheckoutPath(path)
    skillFiles.push({
      path,
      content: serializeSkillMd({
        // Hermes: name must be the folder slug (^[a-z0-9][a-z0-9._-]*$), the label goes to title.
        name: hermes ? folder : skill.name,
        displayName: hermes ? skill.displayName?.trim() || skill.name : skill.displayName,
        description: skill.description,
        license: skill.license,
        content: skill.content,
        requires: skill.requires,
      }),
    })
    skillPointers.push({
      name: hermes ? folder : skill.name,
      path,
      skillId: skill.skillId,
      skillVersionId: skill.skillVersionId,
    })
  }

  const contentHash = hashSnapshot(snapshot)
  const pin: CheckoutPin = {
    agentId: input.definition.agentId,
    definitionId: input.definition.definitionId,
    version: input.definition.version,
    contentHash,
    tenantSlug: tenantSlugFromMcpUrl(input.mcpUrl),
    harness: input.harness ?? null,
  }

  const tenantSlug = pin.tenantSlug
  const slug = checkoutSlug(snapshot.name)
  const profile = `exc-${slug}`
  const suggestedRoot = hermes ? `.hermes/excellence/${tenantSlug}/${slug}` : `Agents/${slug}`
  const instructionsPath = hermes ? 'SOUL.md' : 'AGENTS.md'
  const manifestPath = '.enterprise-agent/manifest.json'
  const hermesFiles: CheckoutFile[] = hermes
    ? renderHermesProfileFiles({
        definition: input.definition,
        mcpUrl: input.mcpUrl,
        profile,
        tenantSlug,
      })
    : []
  const generatedPaths = [
    instructionsPath,
    manifestPath,
    ...hermesFiles.map((file) => file.path),
    ...skillFiles.map((file) => file.path),
  ]
  for (const path of generatedPaths) assertSafeCheckoutPath(path)

  const manifest = {
    kind: MANIFEST_KIND,
    schemaVersion: 1,
    pin: {
      agentId: pin.agentId,
      definitionId: pin.definitionId,
      version: pin.version,
      contentHash: pin.contentHash,
      tenantSlug: pin.tenantSlug,
      harness: pin.harness,
    },
    mcpUrl: input.mcpUrl,
    generatedPaths,
    skills: skillPointers.map((skill) => ({
      skillId: skill.skillId,
      skillVersionId: skill.skillVersionId,
      name: skill.name,
      path: skill.path,
    })),
  }

  const files: CheckoutFile[] = [
    {
      path: instructionsPath,
      content: renderAgentsMd({
        definition: input.definition,
        contentHash,
        mcpUrl: input.mcpUrl,
        skills: resolved,
        hermes,
      }),
    },
    { path: manifestPath, content: `${JSON.stringify(manifest, null, 2)}\n` },
    ...hermesFiles,
    ...skillFiles,
  ]

  return {
    suggestedRoot,
    mcpUrl: input.mcpUrl,
    pin,
    files,
    generatedPaths,
    deleteUnder: hermes ? ['.enterprise-agent', HERMES_SKILL_DIR] : ['.enterprise-agent'],
    warnings,
    writeRecipe: hermes ? hermesWriteRecipe(suggestedRoot, profile) : checkoutWriteRecipe(input.harness),
  }
}

/**
 * Hermes profile distribution (#682 WP-1): `hermes profile install <dir>` reads
 * these. config.yaml and profile.yaml stay out of distribution_owned so
 * `hermes profile update` never overwrites the user's model pin or Bot UI meta.
 */
function renderHermesProfileFiles(input: {
  definition: AgentDefinition
  mcpUrl: string
  profile: string
  tenantSlug: string
}): CheckoutFile[] {
  const snapshot = input.definition.snapshot
  const description = snapshot.description?.trim() || snapshot.name
  const title = hermesBotTitle(snapshot)
  const tools = [
    ...new Set([
      ...HERMES_BASE_TOOLS,
      ...snapshot.capabilities.filter((row) => row.allowed).map((row) => row.toolName),
    ]),
  ]
  const yaml = (value: unknown) => yamlDump(value, { lineWidth: -1 })
  return [
    {
      path: 'distribution.yaml',
      content: yaml({
        name: input.profile,
        version: `${input.definition.version}.0.0`,
        description,
        author: `Excellence AI — ${input.tenantSlug}`,
        hermes_requires: '>=0.21.0',
        distribution_owned: ['SOUL.md', `${HERMES_SKILL_DIR}/`, '.enterprise-agent/', 'distribution.yaml'],
      }),
    },
    {
      path: 'profile.yaml',
      content: yaml({
        display_name: title,
        description,
        ui_meta: { 'hermes-bots': { title } },
      }),
    },
    {
      path: 'config.yaml',
      content: yaml({
        memory: { memory_enabled: false, user_profile_enabled: false },
        mcp_servers: {
          excellence: {
            url: input.mcpUrl,
            auth: 'oauth',
            headers: { [AGENT_ID_HEADER]: input.definition.agentId },
            tools: { include: tools },
          },
        },
      }),
    },
  ]
}
