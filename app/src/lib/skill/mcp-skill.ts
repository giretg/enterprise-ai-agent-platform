import { serializeSkillMd } from './skill-md-export'
import { hashAttachmentBytes, type SkillAttachment } from './skill-attachments'
import type { SkillContent, SkillRequirement } from './skill-content'

/** Agent Skills név: kisbetű, szám, kötőjel; max 64. */
const SKILL_URI_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export type McpSkillFile = {
  path: string
  text: string
  sha256: string
  mimeType: string
}

export type McpSkillPackage = {
  name: string
  uriName: string
  description: string
  license: string | null
  skillId: string
  skillVersionId: string
  files: McpSkillFile[]
}

export type McpSkillListEntry = {
  uri: string
  frontmatter: { name: string; description: string; license?: string }
  resources: Array<{ uri: string; digest: string }>
}

export function skillUriName(name: string): string {
  if (SKILL_URI_NAME_RE.test(name)) return name
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || 'skill'
}

export function skillFileUri(uriName: string, filePath: string): string {
  const rel = filePath.replace(/\\/g, '/').replace(/^\/+/, '')
  return `skill://${uriName}/${rel}`
}

export function parseSkillResourceUri(
  uri: string,
): { uriName: string; filePath: string } | null {
  if (!uri.startsWith('skill://')) return null
  const rest = uri.slice('skill://'.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return rest ? { uriName: rest, filePath: 'SKILL.md' } : null
  const uriName = rest.slice(0, slash)
  const filePath = rest.slice(slash + 1) || 'SKILL.md'
  if (!uriName || filePath.includes('..')) return null
  return { uriName, filePath }
}

export function mimeForSkillPath(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown'
  if (lower.endsWith('.py')) return 'text/x-python'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html'
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'text/yaml'
  if (lower.endsWith('.csv')) return 'text/csv'
  if (lower.endsWith('.sh')) return 'text/x-shellscript'
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return 'text/javascript'
  }
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'text/typescript'
  return 'text/plain'
}

export function buildMcpSkillPackage(input: {
  skillId: string
  skillVersionId: string
  name: string
  displayName?: string | null
  description: string
  license?: string | null
  content: SkillContent
  requires: SkillRequirement[]
  attachments: SkillAttachment[]
}): McpSkillPackage {
  const uriName = skillUriName(input.name)
  const skillMd = serializeSkillMd(input)
  const files: McpSkillFile[] = [
    {
      path: 'SKILL.md',
      text: skillMd,
      sha256: hashAttachmentBytes(new TextEncoder().encode(skillMd)),
      mimeType: 'text/markdown',
    },
    ...[...input.attachments]
      .map((attachment) => ({
        path: attachment.path.replace(/\\/g, '/').replace(/^\/+/, ''),
        text: attachment.text,
        sha256: attachment.sha256,
        mimeType: mimeForSkillPath(attachment.path),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  ]
  return {
    name: input.name,
    uriName,
    description: input.description,
    license: input.license ?? null,
    skillId: input.skillId,
    skillVersionId: input.skillVersionId,
    files,
  }
}

export function toSkillsListEntry(pkg: McpSkillPackage): McpSkillListEntry {
  const frontmatter: McpSkillListEntry['frontmatter'] = {
    name: pkg.uriName,
    description: pkg.description,
  }
  if (pkg.license) frontmatter.license = pkg.license
  return {
    uri: skillFileUri(pkg.uriName, 'SKILL.md'),
    frontmatter,
    resources: pkg.files.map((file) => ({
      uri: skillFileUri(pkg.uriName, file.path),
      digest: `sha256:${file.sha256}`,
    })),
  }
}

export function findPackageByUri(
  packages: readonly McpSkillPackage[],
  uri: string,
): McpSkillPackage | undefined {
  const parsed = parseSkillResourceUri(uri)
  if (!parsed) return undefined
  return packages.find((pkg) => pkg.uriName === parsed.uriName)
}

/**
 * MCP `skill://` URI-név ütközés feloldása.
 * Bemenet sorrendje: újabb → régebbi (`createdAt desc`).
 * - Tenant skill felülírja a platform (tenantId null) skillt ugyanarra az URI-ra.
 * - Azonos hatókörű ütközés (tenant–tenant vagy platform–platform): fail-closed —
 *   egyik csomag sem kerül ki, hogy ne szolgáljunk ki csendben rossz scriptet.
 */
export type McpSkillPackageCandidate = McpSkillPackage & { tenantId: string | null }

export function dedupeMcpSkillPackagesByUri(
  candidates: readonly McpSkillPackageCandidate[],
): McpSkillPackage[] {
  const byUri = new Map<string, McpSkillPackageCandidate>()
  const collided = new Set<string>()
  for (const candidate of candidates) {
    const { uriName } = candidate
    if (collided.has(uriName)) continue
    const existing = byUri.get(uriName)
    if (!existing) {
      byUri.set(uriName, candidate)
      continue
    }
    // Platform sosem ír felül tenantot / meglévő platformot (utóbbi → collision alább)
    if (candidate.tenantId === null && existing.tenantId !== null) continue
    // Tenant felülírja a platformot
    if (candidate.tenantId !== null && existing.tenantId === null) {
      byUri.set(uriName, candidate)
      continue
    }
    // Azonos hatókör: fail-closed — mindkettőt eldobjuk
    byUri.delete(uriName)
    collided.add(uriName)
  }
  return [...byUri.values()]
    .map(({ tenantId: _tenantId, ...pkg }) => pkg)
    .sort((a, b) => a.uriName.localeCompare(b.uriName))
}

export function findSkillFile(
  pkg: McpSkillPackage,
  filePath: string,
): McpSkillFile | undefined {
  const wanted = filePath.replace(/\\/g, '/').replace(/^\/+/, '')
  return pkg.files.find((file) => file.path === wanted)
}
