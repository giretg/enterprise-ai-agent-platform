import { createHash } from 'crypto'

/**
 * KB-v3 mag (Knowledge-Base-v3-OKF-Spec §4/§5/§8/§17).
 *
 * Ez a modul a determinisztikus, LLM-független részt tartalmazza:
 * - a `system` tenant valós UUID-je (D-E — nincs NULL-izolációs ág),
 * - egy egyszerű OKF-bundle generátor (`buildOkfBundle`) a kinyert szövegből,
 * - heading-alapú chunkoló (`chunkOkfBundle`) forrás-linkkel (§4.7, §17).
 *
 * Az LLM-alapú OKF-generálás (§7.5) és a Postgres full-text index (§10) a
 * Sprint 2/3 hatóköre — a varrat (`buildOkfBundle` kimeneti alakja) arra készül.
 */

/**
 * A `system` tenant valós UUID-je. A platform-adminisztrációs agentek
 * (Provisioning stb.) tudása ehhez a tenanthoz tartozik; a `kb_search`
 * scope-filter változatlan (`WHERE tenant_id = :t`), ennél `:t = SYSTEM_TENANT_ID`.
 */
export const SYSTEM_TENANT_ID = '00000000-0000-4000-a000-000000000000'

export type OkfSourceRef = {
  documentId?: string
  filename?: string
  /** PDF-nél oldalszám (ha kinyerhető). */
  page?: number
  /** DOCX/OKF-nél heading/section-út. */
  section?: string
  /** XLSX-nél `Sheet!R{n}C{m}` cella-hivatkozás. */
  cell?: string
  /** Best-effort rövid idézet. */
  quote?: string
}

/**
 * Egy extraction-szelet (§7.3/§7.4): normalizált szöveg + a rá mutató
 * formátumfüggő forrás-ref (PDF=oldal, DOCX=section, XLSX=cella). A
 * `sourceRef` itt még **részleges** — csak a `page`/`section`/`cell` mezőt
 * hordozza; a `documentId`/`filename` a bundle-építéskor / publikáláskor kerül rá.
 * Ezt a `kb-extraction` modul állítja elő, és a `buildOkfBundle` fogyasztja.
 */
export type ExtractedBlock = {
  heading: string
  text: string
  sourceRef: OkfSourceRef
}

export type OkfBundleFile = {
  path: string
  content: string
}

export type OkfBundle = {
  files: OkfBundleFile[]
  /** A bundle belépő oldala (mindig `index.md`). */
  indexPath: string
  contentHash: string
}

export type OkfChunk = {
  path: string
  title: string
  type: string
  section: string | null
  chunkIndex: number
  text: string
  sourceRef: OkfSourceRef | null
  contentHash: string
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 60) || 'page'
  )
}

/** YAML-frontmatter érték biztonságos idézése (elég a minimális sémához). */
function yamlString(value: string): string {
  return JSON.stringify(value)
}

/** A részleges forrás-ref (page/section/cell) csak akkor kerül frontmatterbe, ha van tartalma. */
function compactSourceRef(ref: OkfSourceRef | undefined): OkfSourceRef | null {
  if (!ref) return null
  const out: OkfSourceRef = {}
  if (typeof ref.page === 'number') out.page = ref.page
  if (ref.section) out.section = ref.section
  if (ref.cell) out.cell = ref.cell
  return Object.keys(out).length > 0 ? out : null
}

/** Gép-olvasható forrás-ref sor az OKF-oldal frontmatterében (round-trip a chunkhoz). */
function sourceRefFrontmatter(ref: OkfSourceRef | undefined): string | null {
  const compact = compactSourceRef(ref)
  return compact ? `source_ref: ${JSON.stringify(compact)}` : null
}

/** Ember-olvasható „hol a forrásban" toldalék a `## Source` sorhoz (§4.7). */
function renderSourceLocus(ref: OkfSourceRef | undefined, fallbackSection: string): string {
  if (ref && typeof ref.page === 'number') return `, oldal ${ref.page}`
  if (ref?.cell) return `, tartomány ${ref.cell}`
  const section = ref?.section || fallbackSection
  return section ? `, section „${section}"` : ''
}

type BuildOkfBundleInput = {
  filename: string
  extractedText: string | null
  connectorId: string
  sourceDocumentId?: string | null
  createdByAgentId?: string | null
  storageRef?: string | null
  classification?: string
  /**
   * §7.3 formátumfüggő extraction-szeletek. Ha meg van adva, minden szelet
   * egy OKF-oldal lesz a **saját** forrás-refjével (PDF=oldal, DOCX=section,
   * XLSX=cella). Ha nincs (legacy / paste-út), a törzs heading-split-tel
   * szekciózódik, section-szintű forrás-linkkel.
   */
  blocks?: ExtractedBlock[]
}

type BuildSection = { title: string; body: string; sourceRef: OkfSourceRef }

/**
 * Determinisztikus OKF-bundle a kinyert szövegből (§17.3). NEM LLM —
 * a formátumfüggő extraction-szeletek (vagy fallbackként a markdown headingek)
 * mentén szekciózza a törzset, és minden oldal `## Source` szekciója a
 * forrásdokumentum konkrét helyére (oldal/section/cella) mutató linket hordoz
 * (§4.7, D-G/D-H). Az LLM-generátor (§7.5) ezt a kimeneti alakot váltja majd ki.
 */
export function buildOkfBundle(input: BuildOkfBundleInput): OkfBundle {
  const sections: BuildSection[] =
    input.blocks && input.blocks.length > 0
      ? input.blocks
          .map((b) => ({ title: b.heading.trim(), body: b.text.trim(), sourceRef: b.sourceRef }))
          .filter((b) => b.body)
      : splitByHeadings((input.extractedText ?? '').trim()).map((s) => ({
          title: s.title,
          body: s.body,
          sourceRef: { section: s.title },
        }))
  const timestamp = new Date().toISOString()
  const classification = input.classification ?? 'internal'

  const files: OkfBundleFile[] = []
  const pageEntries: Array<{ title: string; path: string }> = []

  sections.forEach((section, idx) => {
    const title = section.title || `Section ${idx + 1}`
    const slug = `${String(idx + 1).padStart(2, '0')}-${slugify(title)}`
    const path = `pages/${slug}.md`
    const srLine = sourceRefFrontmatter(section.sourceRef)
    const frontmatter = [
      '---',
      'type: Section',
      `title: ${yamlString(title)}`,
      `resource: ${yamlString(input.storageRef ?? input.filename)}`,
      `timestamp: ${timestamp}`,
      input.sourceDocumentId ? `source_document_id: ${yamlString(input.sourceDocumentId)}` : null,
      `connector_id: ${yamlString(input.connectorId)}`,
      input.createdByAgentId
        ? `created_by_agent_id: ${yamlString(input.createdByAgentId)}`
        : null,
      srLine,
      `classification: ${classification}`,
      'confidence: draft_generated',
      '---',
    ]
      .filter((line): line is string => line !== null)
      .join('\n')

    const sourceLine = `- Forrás: \`${input.filename}\`${renderSourceLocus(section.sourceRef, title)} — [ellenőrzés]`
    const content = `${frontmatter}\n\n# ${title}\n\n${section.body}\n\n## Source\n${sourceLine}\n`
    files.push({ path, content })
    pageEntries.push({ title, path })
  })

  const indexContent = buildIndex(input.filename, classification, timestamp, pageEntries)
  files.unshift({ path: 'index.md', content: indexContent })

  const contentHash = sha256(files.map((f) => `${f.path}\n${f.content}`).join('\n---\n'))
  return { files, indexPath: 'index.md', contentHash }
}

function buildIndex(
  filename: string,
  classification: string,
  timestamp: string,
  pages: Array<{ title: string; path: string }>,
): string {
  const frontmatter = [
    '---',
    'type: Index',
    `title: ${yamlString(filename)}`,
    `timestamp: ${timestamp}`,
    `classification: ${classification}`,
    '---',
  ].join('\n')
  const links =
    pages.length > 0
      ? pages.map((p) => `- [${p.title}](${p.path})`).join('\n')
      : '- (nincs szekció)'
  return `${frontmatter}\n\n# ${filename}\n\n## Pages\n${links}\n`
}

type RawSection = { title: string; body: string }

/**
 * Markdown törzs szekciózása `#`/`##` headingek mentén. Ha nincs heading,
 * egyetlen „Document" szekció keletkezik — így üres/heading nélküli fájl is
 * kap egy chunkot.
 */
function splitByHeadings(body: string): RawSection[] {
  if (!body) return [{ title: 'Document', body: '(üres dokumentum)' }]

  const lines = body.split('\n')
  const sections: RawSection[] = []
  let current: RawSection | null = null

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.*)$/)
    if (heading) {
      if (current) sections.push(current)
      current = { title: heading[1].trim(), body: '' }
    } else {
      if (!current) current = { title: 'Document', body: '' }
      current.body += (current.body ? '\n' : '') + line
    }
  }
  if (current) sections.push(current)

  return sections
    .map((s) => ({ title: s.title, body: s.body.trim() || '(nincs tartalom)' }))
    .filter((s) => s.title || s.body)
}

/**
 * A publikált OKF-bundle chunkolása (§4.6, §17.4). Oldal/section granularitás,
 * forrás-linkkel; a chunk full-text indexelhető egysége lesz. Az `index.md`
 * nem chunkolódik (navigációs oldal).
 */
export function chunkOkfBundle(bundle: OkfBundle, source: OkfSourceRef): OkfChunk[] {
  const chunks: OkfChunk[] = []
  let chunkIndex = 0

  for (const file of bundle.files) {
    if (file.path === 'index.md') continue
    const parsed = parseOkfPage(file.content)
    const text = parsed.body.trim()
    if (!text) continue
    // A doc-szintű forrás (documentId/filename) + az oldal saját formátumfüggő
    // helye (page/section/cell). Ha az oldalnak nincs saját locus-a, a title
    // section-ként szolgál (backward-compatible, §4.7 DOCX-fallback).
    const pageRef = parsed.sourceRef ?? {}
    const sourceRef: OkfSourceRef = { ...source, ...pageRef }
    if (sourceRef.page === undefined && !sourceRef.cell && !sourceRef.section) {
      sourceRef.section = parsed.title
    }
    chunks.push({
      path: file.path,
      title: parsed.title,
      type: parsed.type,
      section: parsed.title,
      chunkIndex: chunkIndex++,
      text,
      sourceRef,
      contentHash: sha256(text),
    })
  }

  return chunks
}

type ParsedOkfPage = { title: string; type: string; body: string; sourceRef: OkfSourceRef | null }

/** Minimális OKF-oldal parser: frontmatter `type`/`title`/`source_ref` + törzs (Source nélkül). */
function parseOkfPage(content: string): ParsedOkfPage {
  let type = 'Section'
  let title = 'Untitled'
  let body = content
  let sourceRef: OkfSourceRef | null = null

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (fmMatch) {
    const fm = fmMatch[1]
    body = fmMatch[2]
    const typeMatch = fm.match(/^type:\s*(.+)$/m)
    if (typeMatch) type = typeMatch[1].trim()
    const titleMatch = fm.match(/^title:\s*(.+)$/m)
    if (titleMatch) title = stripQuotes(titleMatch[1].trim())
    const srMatch = fm.match(/^source_ref:\s*(.+)$/m)
    if (srMatch) {
      try {
        const parsed = JSON.parse(srMatch[1].trim()) as OkfSourceRef
        sourceRef = compactSourceRef(parsed)
      } catch {
        sourceRef = null
      }
    }
  }

  // A `## Source` szekció a forrás-link, nem tartalmi text — kivágjuk a chunkból.
  body = body.replace(/\n##\s+Source[\s\S]*$/i, '').trim()
  // A vezető `# Title` heading redundáns a title mezővel — eltávolítjuk.
  body = body.replace(/^#\s+.*\n?/, '').trim()
  return { title, type, body, sourceRef }
}

function stripQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string
    } catch {
      return value.slice(1, -1)
    }
  }
  return value
}
