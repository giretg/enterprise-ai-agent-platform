import type { OkfBundle } from './kb-v3'

/**
 * KB-v3 §7.6 OKF-validator.
 *
 * Determinisztikus (nem LLM) ellenőrzés a generált OKF-bundle-ön, mielőtt
 * emberi review-ra kerül (§7.7). A validator NEM blokkol önmagában — az
 * eredményt a review UI (§12.2) mutatja, és az ember dönt (§7.7/D-F). A hard
 * `error`-ok (frontmatter/kötelező mező/connector-egyezés/broken link) azt
 * jelzik, hogy a bundle strukturálisan sérült; a `warning`-ok (üres/túl hosszú
 * oldal, hiányzó forrás-link, külső link, érzékeny adat) review-figyelmeztetők.
 *
 * A `sourceLinkCoverage` a legfontosabb metrika: a RAG-elhagyás egyetlen
 * biztonsági hálója a forrás-visszavezethetőség (§3.3), ezért a hiányzó
 * `## Source` link kiemelt figyelmeztetés.
 */

export type KbValidationSeverity = 'error' | 'warning'

export type KbValidationIssue = {
  severity: KbValidationSeverity
  /** Gép-olvasható kód (pl. `broken_link`, `missing_source_link`). */
  code: string
  /** Az érintett OKF-oldal path-ja (pl. `pages/01-remote-work.md`). */
  path: string
  message: string
}

export type KbValidationResult = {
  /** Nincs hard `error` (a `warning`-ok megengedettek). */
  ok: boolean
  /** Tartalmi oldalak száma (az `index.md` navigációs oldal nem számít). */
  pageCount: number
  brokenLinks: number
  externalLinks: number
  /** A `## Source` linket hordozó tartalmi oldalak aránya (0..1). §3.3 biztonsági háló. */
  sourceLinkCoverage: number
  sensitiveHits: number
  errors: number
  warnings: number
  issues: KbValidationIssue[]
}

type ValidateOptions = {
  /** A KB scope-kulcsa (D-B). A content-oldalak `connector_id`-jának ezzel kell egyeznie. */
  connectorId: string
}

/** A content-oldalakon kötelező frontmatter-mezők (§7.6). */
const REQUIRED_FIELDS = ['type', 'title', 'connector_id'] as const
/** Egy oldal fölött warningolunk (kurált tudásbázisban a túl hosszú oldal rossz szegmentálás jele). */
const MAX_PAGE_CHARS = 20_000
const INDEX_PATH = 'index.md'

/** Érzékeny adat heurisztikák (§14.5 — warning, nem enforcement). */
const SENSITIVE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'e-mail cím', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  { label: 'API-kulcs/token gyanú', re: /\b(?:sk|pk|api[_-]?key|bearer|secret)[_-]?[a-z0-9]{12,}\b/i },
  { label: 'bankkártyaszám gyanú', re: /\b(?:\d[ -]?){13,16}\b/ },
  { label: 'IBAN gyanú', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/ },
]

type Frontmatter = { fields: Record<string, string>; body: string; hasBlock: boolean }

function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { fields: {}, body: content, hasBlock: false }
  const fields: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([a-z_][a-z0-9_]*):\s*(.*)$/i)
    if (kv) fields[kv[1]] = stripQuotes(kv[2].trim())
  }
  return { fields, body: match[2], hasBlock: true }
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string
    } catch {
      return value.slice(1, -1)
    }
  }
  return value
}

/**
 * A markdown-törzsből a `## Source` szekció elhagyásával számoljuk a "tartalmi"
 * hosszt és keressük a linkeket — a Source-link maga nem tartalom (§4.7).
 */
function splitBody(body: string): { content: string; sourceSection: string } {
  const idx = body.search(/\n##\s+Source\b/i)
  if (idx === -1) return { content: body.trim(), sourceSection: '' }
  return { content: body.slice(0, idx).trim(), sourceSection: body.slice(idx) }
}

/** Egy markdown link relatív célját a bundle gyökeréhez normalizálja (`..`/`.` feloldással). */
function resolveLink(fromPath: string, target: string): string {
  const clean = target.split('#')[0].split('?')[0]
  const baseDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : ''
  const parts = (baseDir ? baseDir.split('/') : []).concat(clean.split('/'))
  const stack: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return stack.join('/')
}

const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g

/**
 * §7.6 — a determinisztikus OKF-bundle validátora. Tiszta függvény (nincs DB),
 * így a `KnowledgeBaseService` a draft-generáláskor lefuttatja, és a
 * `validationResult`-be menti; a review UI ugyanezt a struktúrát jeleníti meg.
 */
export function validateOkfBundle(bundle: OkfBundle, options: ValidateOptions): KbValidationResult {
  const issues: KbValidationIssue[] = []
  const knownPaths = new Set(bundle.files.map((f) => f.path))

  const contentPages = bundle.files.filter((f) => f.path !== INDEX_PATH)
  let brokenLinks = 0
  let externalLinks = 0
  let sensitiveHits = 0
  let pagesWithSource = 0

  const add = (severity: KbValidationSeverity, code: string, path: string, message: string) =>
    issues.push({ severity, code, path, message })

  for (const file of bundle.files) {
    const isIndex = file.path === INDEX_PATH
    const fm = parseFrontmatter(file.content)

    if (!fm.hasBlock) {
      add('error', 'frontmatter_missing', file.path, 'Hiányzó YAML frontmatter blokk.')
    } else if (!isIndex) {
      for (const field of REQUIRED_FIELDS) {
        if (!fm.fields[field]) {
          add('error', 'missing_field', file.path, `Hiányzó kötelező frontmatter-mező: \`${field}\`.`)
        }
      }
      if (fm.fields.connector_id && fm.fields.connector_id !== options.connectorId) {
        add(
          'error',
          'connector_mismatch',
          file.path,
          `A frontmatter connector_id (\`${fm.fields.connector_id}\`) nem egyezik a KB connectorral (\`${options.connectorId}\`).`,
        )
      }
    }

    const { content, sourceSection } = splitBody(fm.body)

    // Linkek (broken relatív + külső). Az index navigációs linkjeit is nézzük.
    LINK_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = LINK_RE.exec(fm.body)) !== null) {
      const target = m[1].trim()
      if (/^(?:https?:)?\/\//i.test(target) || /^mailto:/i.test(target)) {
        externalLinks++
        add('warning', 'external_link', file.path, `Külső link a tudásban: \`${target}\`.`)
      } else if (target.endsWith('.md')) {
        const resolved = resolveLink(file.path, target)
        if (!knownPaths.has(resolved)) {
          brokenLinks++
          add('error', 'broken_link', file.path, `Törött belső link: \`${target}\`.`)
        }
      }
    }

    if (isIndex) continue

    // Üres / túl hosszú tartalmi oldal.
    const stripped = content.replace(/^#\s+.*\n?/, '').trim()
    if (!stripped || stripped === '(üres dokumentum)' || stripped === '(nincs tartalom)') {
      add('warning', 'empty_page', file.path, 'Az oldalnak nincs érdemi tartalma.')
    } else if (content.length > MAX_PAGE_CHARS) {
      add(
        'warning',
        'page_too_long',
        file.path,
        `Az oldal túl hosszú (${content.length} karakter) — érdemes tovább szegmentálni.`,
      )
    }

    // Source-link coverage (§3.3 biztonsági háló).
    if (/-\s*Forrás:/i.test(sourceSection)) {
      pagesWithSource++
    } else {
      add(
        'warning',
        'missing_source_link',
        file.path,
        'Nincs `## Source` forrás-link — a válasz nem vezethető vissza a forrásra.',
      )
    }

    // Érzékeny adat (§14.5 — csak figyelmeztetés).
    const found = SENSITIVE_PATTERNS.filter((p) => p.re.test(content)).map((p) => p.label)
    if (found.length > 0) {
      sensitiveHits += found.length
      add('warning', 'sensitive_data', file.path, `Érzékeny adat gyanúja: ${found.join(', ')}.`)
    }
  }

  const errors = issues.filter((i) => i.severity === 'error').length
  const warnings = issues.length - errors
  const pageCount = contentPages.length
  const sourceLinkCoverage = pageCount === 0 ? 1 : pagesWithSource / pageCount

  return {
    ok: errors === 0,
    pageCount,
    brokenLinks,
    externalLinks,
    sourceLinkCoverage: Math.round(sourceLinkCoverage * 100) / 100,
    sensitiveHits,
    errors,
    warnings,
    issues,
  }
}
