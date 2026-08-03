import { createHash } from 'crypto'
import type { SkillContent, SkillProvenance, SkillRequirement } from './skill-content'
import { SKILL_ATTACHMENT_DESCRIPTION_MAX } from './skill-content'

/**
 * `SKILL.md` import-adapter (spec §D6, WP-2). Az Anthropic Agent Skills formátum:
 * YAML frontmatter (`name`, `description`, opcionális `license`, `allowed-tools`)
 * + markdown törzs. Ez az ELSŐ adapter a kanonikus belső sémára — nem a natív
 * formátum. Későbbi formátumok ugyanerre a `SkillContent`-re képeznek.
 *
 * Szándékosan nem húzunk be YAML-függőséget: a frontmatter lapos kulcs-érték
 * (skalár vagy egyszerű lista), amit determinista, tesztelhető parserrel bontunk.
 */

export interface ParsedSkillMd {
  name: string
  description: string
  content: SkillContent
  /** Frontmatter `allowed-tools`-ból levezetett capability-javaslat (requires). */
  suggestedRequires: SkillRequirement[]
  license: string | null
  provenance: SkillProvenance
  /** Az eredeti bájtok SHA-256 hash-e (fork-on-import provenience). */
  originalHash: string
  /** Nyers frontmatter kulcs-érték párok (validátor/diagnosztika számára). */
  frontmatter: Record<string, string | string[]>
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/** Minimális, lapos YAML-frontmatter parser (skalár + inline/blokk lista). */
export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string | string[]>
  body: string
} {
  const match = FRONTMATTER_RE.exec(raw)
  if (!match) return { frontmatter: {}, body: raw.trim() }

  const [, fmBlock, body] = match
  const frontmatter: Record<string, string | string[]> = {}
  const lines = fmBlock.split(/\r?\n/)
  let currentListKey: string | null = null

  for (const line of lines) {
    if (line.trim() === '') continue
    // Blokk-lista elem: "  - value"
    const listItem = /^\s*-\s+(.*)$/.exec(line)
    if (listItem && currentListKey) {
      const arr = frontmatter[currentListKey]
      const value = stripQuotes(listItem[1].trim())
      if (Array.isArray(arr)) arr.push(value)
      else frontmatter[currentListKey] = [value]
      continue
    }

    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1].trim()
    const rest = kv[2].trim()
    currentListKey = null

    if (rest === '') {
      // Következő sorok blokk-lista elemei lehetnek.
      currentListKey = key
      frontmatter[key] = []
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      // Inline lista: [a, b, c]
      frontmatter[key] = rest
        .slice(1, -1)
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter((s) => s.length > 0)
    } else {
      frontmatter[key] = stripQuotes(rest)
    }
  }

  return { frontmatter, body: body.trim() }
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

function asString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(', ')
  return value ?? ''
}

function asList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  }
  return []
}

function parseOptionalInt(value: string | string[] | undefined): number | undefined {
  const raw = asString(value).trim()
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? Math.round(n) : undefined
}

/** Frontmatter → opcionális boolean (`true`/`false`/`yes`/`no`; egyéb → undefined). */
function parseOptionalBoolean(value: string | string[] | undefined): boolean | undefined {
  const raw = asString(value).trim().toLowerCase()
  if (!raw) return undefined
  if (raw === 'true' || raw === 'yes' || raw === '1') return true
  if (raw === 'false' || raw === 'no' || raw === '0') return false
  return undefined
}

/**
 * Frontmatter → runtimeHints (`max-wall-clock-ms`, `max-tool-calls`,
 * `preferred-mode`, `allow-attachments`).
 */
function parseRuntimeHints(
  frontmatter: Record<string, string | string[]>,
): import('./skill-content').SkillRuntimeHints | undefined {
  const maxWallClockMs = parseOptionalInt(
    frontmatter['max-wall-clock-ms'] ?? frontmatter.maxWallClockMs,
  )
  const maxToolCalls = parseOptionalInt(
    frontmatter['max-tool-calls'] ?? frontmatter.maxToolCalls,
  )
  const modeRaw = asString(
    frontmatter['preferred-mode'] ?? frontmatter.preferredMode,
  )
    .trim()
    .toLowerCase()
  const preferredMode =
    modeRaw === 'task' || modeRaw === 'chat' ? (modeRaw as 'chat' | 'task') : undefined
  // Csak a TILTÁST tároljuk: a hiányzó érték amúgy is engedettet jelent, így az
  // importált skillek hash-e és diffje nem zajosodik feleslegesen.
  const allowAttachmentsRaw = parseOptionalBoolean(
    frontmatter['allow-attachments'] ?? frontmatter.allowAttachments,
  )
  const allowAttachments = allowAttachmentsRaw === false ? false : undefined
  const attachmentDescriptionRaw = asString(
    frontmatter['attachment-description'] ?? frontmatter.attachmentDescription,
  ).trim()
  const attachmentDescription =
    allowAttachments !== false && attachmentDescriptionRaw
      ? attachmentDescriptionRaw.slice(0, SKILL_ATTACHMENT_DESCRIPTION_MAX)
      : undefined
  if (
    maxWallClockMs == null &&
    maxToolCalls == null &&
    preferredMode == null &&
    allowAttachments == null &&
    attachmentDescription == null
  ) {
    return undefined
  }
  return {
    ...(maxWallClockMs != null ? { maxWallClockMs } : {}),
    ...(maxToolCalls != null ? { maxToolCalls } : {}),
    ...(preferredMode != null ? { preferredMode } : {}),
    ...(allowAttachments != null ? { allowAttachments } : {}),
    ...(attachmentDescription != null ? { attachmentDescription } : {}),
  }
}

/**
 * A markdown törzset instrukció-blokkokra bontja a `##`/`#` fejlécek mentén.
 * Fejléc nélküli, összefüggő törzs egyetlen blokk marad.
 */
export function splitInstructions(body: string): string[] {
  if (!body.trim()) return []
  const sections: string[] = []
  const lines = body.split(/\r?\n/)
  let buffer: string[] = []

  const flush = () => {
    const text = buffer.join('\n').trim()
    if (text) sections.push(text)
    buffer = []
  }

  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line) && buffer.some((l) => l.trim() !== '')) {
      flush()
    }
    buffer.push(line)
  }
  flush()
  return sections.length > 0 ? sections : [body.trim()]
}

export function parseSkillMd(raw: string, source?: { url?: string }): ParsedSkillMd {
  const originalHash = createHash('sha256').update(raw, 'utf8').digest('hex')
  const { frontmatter, body } = parseFrontmatter(raw)

  const name = asString(frontmatter.name).trim() || 'Untitled skill'
  const description = asString(frontmatter.description).trim()
  const license = asString(frontmatter.license).trim() || null
  const triggerKeywords = asList(frontmatter['trigger-keywords'] ?? frontmatter.triggers)
  const allowedTools = asList(frontmatter['allowed-tools'] ?? frontmatter.tools)
  const runtimeHints = parseRuntimeHints(frontmatter)

  const content: SkillContent = {
    instructions: splitInstructions(body),
    triggerKeywords,
    parameters: [],
    ...(runtimeHints ? { runtimeHints } : {}),
  }

  const suggestedRequires: SkillRequirement[] = allowedTools.map((toolName) => ({
    toolName,
    reason: 'SKILL.md allowed-tools',
  }))

  const provenance: SkillProvenance = {
    origin: 'skill_md',
    format: 'SKILL.md',
    originalHash,
    ...(source?.url ? { sourceUrl: source.url } : {}),
  }

  return {
    name,
    description,
    content,
    suggestedRequires,
    license,
    provenance,
    originalHash,
    frontmatter,
  }
}
