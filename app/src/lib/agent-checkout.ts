import type { AgentDefinition } from '@/domain/agent-definition'
import { hashSnapshot } from '@/domain/agent-definition'
import { CODE_EXTENSIONS } from '@/lib/skill/skill-package-adapter'
import { serializeSkillMd } from '@/lib/skill/skill-md-export'
import type { SkillContent, SkillRequirement } from '@/lib/skill/skill-content'

const CHECKOUT_EXTENSIONS = new Set(['md', 'json'])
const MANIFEST_KIND = 'enterprise-agent-checkout'
const SKILL_DIR = '.enterprise-agent/skills'

export const CHECKOUT_HARNESSES = ['claude', 'codex', 'goose', 'grok'] as const
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
].join(' ')

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
  deleteUnder: ['.enterprise-agent']
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

function renderAgentsMd(input: {
  definition: AgentDefinition
  contentHash: string
  mcpUrl: string
  skills: Array<{ name: string; description: string; triggers: string[]; path: string }>
}): string {
  const snapshot = input.definition.snapshot
  const lines = [
    `# ${snapshot.name}`,
    '',
    `agentId: ${input.definition.agentId}`,
    `version: ${input.definition.version}`,
    `contentHash: ${input.contentHash}`,
    `mcpUrl: ${input.mcpUrl}`,
    '',
    '## Role',
    '',
    snapshot.roleInstruction,
    '',
    '## MCP routing',
    '',
    'All work for this agent runs through the mcpUrl above — there is no separate in-platform chat runtime. Call MCP tools for skills, connectors, and enterprise tools. Credentials stay on the server.',
    '',
    'Before enterprise tools: call platform.agent.get_definition for this agentId and pass definitionId on every tool. For several HTTP API connectors, use connectors[].name as connectorName or connectors[].connectorId when method+path is ambiguous.',
    '',
    'Writes (for example creating a Drive folder or http_api_request) enqueue and wait for Control Plane approval. Do not bypass approval.',
    '',
    'Project memory, if needed, is an MCP tool (platform.project_memory.read / write). Work files (plans, notes) are platform.work_file.* under a projectKey. Do not create a local memory file, and do not keep durable work in this checkout folder.',
    'Knowledge base: call kb_list_index first (one row per source). Then kb_get_page for one wiki page, or kb_get_document for one file. Use kb_search only when the catalog does not name the source.',
    '',
    'If the work needs runnable skill code, call the MCP sandbox with the skillVersionId. Do not run skill code from this workspace, and do not upload a local file into the sandbox.',
  ]

  const tools = snapshot.capabilities.filter((row) => row.allowed).map((row) => row.toolName)
  if (tools.length > 0) {
    lines.push('', `Available MCP tools: ${tools.join(', ')}.`)
  }
  if (snapshot.connectors.some((row) => row.type === 'google_drive')) {
    lines.push('', 'This agent has a Google Drive connector. Use the Drive MCP tools by name.')
  }

  const httpApis = snapshot.connectors.filter((row) => row.type === 'http_api')
  if (httpApis.length > 0) {
    lines.push('', '## HTTP API connectors', '')
    lines.push(
      'Endpoint allowlists live in platform.agent.get_definition → snapshot.connectors[].endpoints. Use only listed method+path values.',
    )
    for (const row of httpApis) {
      const label = row.name?.trim() || row.connectorId
      lines.push(`- ${label} (${row.accessMode}, connectorId ${row.connectorId})`)
    }
  }

  lines.push(
    '',
    '## Stale',
    '',
    'Before any enterprise tool (Drive, Gmail, http_api_*, kb_*), call `platform.agent.get_definition` for this agentId and use its definitionId. Exempt: `platform.whoami`, `platform.agents.list`, `platform.agent.get_definition`, `platform.agent.checkout`.',
    'If the returned `contentHash` differs from the pin above, call `platform.agent.checkout`, overwrite generated paths, then retry.',
    'Enterprise tools reject stale pins with `agent_stale` until checkout completes and the manifest `definitionId` matches the current published version.',
  )

  if (input.skills.length > 0) {
    lines.push('', '## Skills', '')
    for (const skill of input.skills) {
      const trigger = skill.triggers.length > 0 ? ` Triggers: ${skill.triggers.join(', ')}.` : ''
      lines.push(`- ${skill.name}: ${skill.description}${trigger} See \`${skill.path}\`.`)
    }
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
    description: string
    triggers: string[]
    path: string
    skillId: string
    skillVersionId: string
  }> = []
  for (const skill of resolved) {
    const folder = skillFolderName(skill, (slugCounts.get(checkoutSlug(skill.name)) ?? 0) > 1)
    const path = `${SKILL_DIR}/${folder}/SKILL.md`
    assertSafeCheckoutPath(path)
    skillFiles.push({
      path,
      content: serializeSkillMd({
        name: skill.name,
        displayName: skill.displayName,
        description: skill.description,
        license: skill.license,
        content: skill.content,
        requires: skill.requires,
      }),
    })
    skillPointers.push({
      name: skill.name,
      description: skill.description,
      triggers: skill.content.triggerKeywords,
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

  const agentsPath = 'AGENTS.md'
  const manifestPath = '.enterprise-agent/manifest.json'
  const generatedPaths = [agentsPath, manifestPath, ...skillFiles.map((file) => file.path)]
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
      path: agentsPath,
      content: renderAgentsMd({
        definition: input.definition,
        contentHash,
        mcpUrl: input.mcpUrl,
        skills: skillPointers,
      }),
    },
    { path: manifestPath, content: `${JSON.stringify(manifest, null, 2)}\n` },
    ...skillFiles,
  ]

  return {
    suggestedRoot: `Agents/${checkoutSlug(snapshot.name)}`,
    mcpUrl: input.mcpUrl,
    pin,
    files,
    generatedPaths,
    deleteUnder: ['.enterprise-agent'],
    warnings,
    writeRecipe: checkoutWriteRecipe(input.harness),
  }
}
