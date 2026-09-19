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

export const CHECKOUT_WRITE_RECIPE = [
  '1. Create the suggestedRoot folder under the user home (or a folder the user names) if it does not exist.',
  '2. Write every files[] entry to root/path as UTF-8, overwriting.',
  '3. Under .enterprise-agent/, delete any file that is not in generatedPaths. Touch AGENTS.md only if files[] contains it (it always does).',
  '4. Do not delete or write anything outside the generatedPaths + deleteUnder contract. NOTES.md and every human file stay.',
  '5. Done when every files[] path on disk is byte-identical and .enterprise-agent/ has no extra generated file.',
  '',
  'Do not run code from the checkout. Do not commit. Do not copy the folder into a code repo.',
].join('\n')

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
  harness: string | null
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
    'Call MCP tools for resources, connectors, and enterprise tools. Credentials stay on the server.',
    '',
    'Writes (for example creating a Drive folder) enqueue and wait for Control Plane approval. Do not bypass approval.',
    '',
    'Project memory and knowledge base, if needed, are MCP tools. Do not create a local memory file.',
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

  lines.push(
    '',
    '## Stale',
    '',
    'At the start of work, call `platform.agent.get_definition` for this agentId. If the SHA-256 of the returned snapshot (canonical JSON with recursively sorted object keys) differs from contentHash above, call `platform.agent.checkout` and overwrite generated paths. Done when the pin matches.',
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
  harness?: string | null
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
    writeRecipe: CHECKOUT_WRITE_RECIPE,
  }
}
