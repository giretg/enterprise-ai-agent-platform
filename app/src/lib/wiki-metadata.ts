/**
 * #1061 F3 — metaadat-mezők és nézetek, F4 — kategória-oldalsablon (DB-mentes rész).
 *
 * - beépített mezők (állapot, gazda, átnézés + ciklus) — a `WikiPage` saját oszlopai,
 * - wikinként definiált egyedi mezők értékének ellenőrzése (a `frontmatter`-ben élnek),
 * - kategória-szabályok öröklése (alkategória: a szülőé + a sajátja),
 * - átnézési esedékesség, nézet-szűrők (`kb_list_index`), kötelező fejezetek,
 * - régi frontmatter-értékek (`status`, `owner`, `last_reviewed`) átemelése bekapcsoláskor.
 *
 * A felület is használja, ezért node-modult nem importál.
 */
import { normalizeCategoryPath, type WikiCategoryRow } from './wiki-categories'

export const WIKI_DOC_STATUSES = ['draft', 'approved'] as const
export type WikiDocStatusName = (typeof WIKI_DOC_STATUSES)[number]

/** A beépített mezők (a revízió `meta` pillanatképe is ez az alak). */
export type WikiPageMeta = {
  docStatus: WikiDocStatusName | null
  ownerUserId: string | null
  /** Szabad szöveges szerep, pl. „Sales vezető”. */
  ownerRole: string | null
  /** ISO időpont; csak ember állítja („Átnéztem, rendben”). */
  reviewedAt: string | null
  reviewedByUserId: string | null
  /** Oldalszintű felülírás; `null` = a kategória ciklusa. */
  reviewCycleDays: number | null
}

export const EMPTY_WIKI_META: WikiPageMeta = {
  docStatus: null,
  ownerUserId: null,
  ownerRole: null,
  reviewedAt: null,
  reviewedByUserId: null,
  reviewCycleDays: null,
}

export const WIKI_OWNER_ROLE_MAX = 120
export const WIKI_REVIEW_CYCLE_MAX_DAYS = 3650

export function isWikiDocStatus(value: unknown): value is WikiDocStatusName {
  return value === 'draft' || value === 'approved'
}

/** Az oszlopokból (Prisma-sor) a meta-alak. */
export function metaFromColumns(row: {
  docStatus?: string | null
  ownerUserId?: string | null
  ownerRole?: string | null
  reviewedAt?: Date | null
  reviewedByUserId?: string | null
  reviewCycleDays?: number | null
}): WikiPageMeta {
  return {
    docStatus: isWikiDocStatus(row.docStatus) ? row.docStatus : null,
    ownerUserId: row.ownerUserId ?? null,
    ownerRole: row.ownerRole ?? null,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewedByUserId: row.reviewedByUserId ?? null,
    reviewCycleDays: row.reviewCycleDays ?? null,
  }
}

/** A revízió `meta` JSON-ja; `null` = a bevezetés előtti revízió (nincs pillanatkép). */
export function readWikiMeta(value: unknown): WikiPageMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const text = (key: string) => (typeof row[key] === 'string' && row[key] ? (row[key] as string) : null)
  const cycle = row.reviewCycleDays
  return {
    docStatus: isWikiDocStatus(row.docStatus) ? row.docStatus : null,
    ownerUserId: text('ownerUserId'),
    ownerRole: text('ownerRole'),
    reviewedAt: text('reviewedAt'),
    reviewedByUserId: text('reviewedByUserId'),
    reviewCycleDays: typeof cycle === 'number' && Number.isInteger(cycle) && cycle > 0 ? cycle : null,
  }
}

export function sameWikiMeta(a: WikiPageMeta, b: WikiPageMeta): boolean {
  return (
    a.docStatus === b.docStatus &&
    a.ownerUserId === b.ownerUserId &&
    a.ownerRole === b.ownerRole &&
    a.reviewedAt === b.reviewedAt &&
    a.reviewedByUserId === b.reviewedByUserId &&
    a.reviewCycleDays === b.reviewCycleDays
  )
}

// ---------------------------------------------------------------------------
// Egyedi mezők

export const WIKI_FIELD_TYPES = ['text', 'select', 'multi_select', 'date'] as const
export type WikiFieldTypeName = (typeof WIKI_FIELD_TYPES)[number]

export const WIKI_FIELD_KEY_RE = /^[a-z][a-z0-9_]*$/
export const WIKI_FIELD_MAX_KEY = 40
export const WIKI_FIELD_MAX_NAME = 80
export const WIKI_FIELD_MAX_HELP = 300
export const WIKI_FIELD_MAX_OPTIONS = 50
export const WIKI_FIELD_MAX_OPTION = 80
export const WIKI_FIELD_MAX_TEXT = 500
/** Egy wikiben ennyi egyedi mező lehet (a briefing és a felület olvasható maradjon). */
export const WIKI_FIELD_MAX_COUNT = 30

/**
 * Egyedi mező nem kaphatja ezeket a kulcsokat: a kezelt oszlopok, illetve a beépített
 * mezők régi frontmatter-nevei (bekapcsoláskor ezekből olvasunk át).
 */
export const WIKI_RESERVED_FIELD_KEYS = new Set([
  'type',
  'title',
  'summary',
  'category',
  'sources',
  'source_date',
  'status',
  'doc_status',
  'owner',
  'owner_role',
  'last_reviewed',
  'reviewed_at',
  'review_cycle_days',
])

/**
 * A beépített mezők OKF-frontmatter neve (`renderWikiPageMarkdown`). Metaadat-mezős wikin az
 * agent ezeket nem írhatja a frontmatterbe: az állapot, a gazda és az átnézés csak a saját
 * argumentumán / emberi műveleten át változhat (D5, §7).
 */
export const WIKI_BUILTIN_FRONTMATTER_KEYS = ['doc_status', 'owner_user_id', 'owner_role', 'last_reviewed', 'reviewed_at', 'review_cycle_days'] as const

/** A kötelezővé tehető beépített mező (kategóriánként). */
export const WIKI_REQUIRABLE_BUILTINS = ['owner'] as const

export type WikiFieldDef = {
  id: string
  key: string
  name: string
  type: WikiFieldTypeName
  options: string[]
  help: string | null
  sortOrder: number
}

export type WikiFieldValue = string | string[]

export function isValidFieldKey(key: string): boolean {
  return key.length <= WIKI_FIELD_MAX_KEY && WIKI_FIELD_KEY_RE.test(key) && !WIKI_RESERVED_FIELD_KEYS.has(key)
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function isValidIsoDate(value: string): boolean {
  const match = DATE_RE.exec(value)
  if (!match) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** Üres érték = a mező nincs kitöltve (`null`, `""`, `[]`). */
export function isFieldValueEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.every((item) => isFieldValueEmpty(item))
  return false
}

/**
 * Az érték a definíció szerint, kanonikus alakra hozva (a választólista értéke a
 * definícióbeli írásmóddal; a több-választós lista tömb). Hibánál angol üzenet (az agent olvassa).
 */
export function normalizeFieldValue(
  def: Pick<WikiFieldDef, 'key' | 'type' | 'options'>,
  raw: unknown,
): { ok: true; value: WikiFieldValue | null } | { ok: false; message: string } {
  if (isFieldValueEmpty(raw)) return { ok: true, value: null }
  const pick = (value: string) => def.options.find((option) => option.toLowerCase() === value.trim().toLowerCase())
  const allowed = () => def.options.join(', ') || '(no options defined yet)'
  if (def.type === 'text') {
    const value = typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : raw
    if (typeof value !== 'string') return { ok: false, message: `${def.key} must be text.` }
    if (value.trim().length > WIKI_FIELD_MAX_TEXT) return { ok: false, message: `${def.key} is longer than ${WIKI_FIELD_MAX_TEXT} characters.` }
    return { ok: true, value: value.trim() }
  }
  if (def.type === 'date') {
    if (typeof raw !== 'string' || !isValidIsoDate(raw.trim())) return { ok: false, message: `${def.key} must be a date (YYYY-MM-DD).` }
    return { ok: true, value: raw.trim() }
  }
  if (def.type === 'select') {
    if (typeof raw !== 'string') return { ok: false, message: `${def.key} takes one value: ${allowed()}.` }
    const value = pick(raw)
    if (!value) return { ok: false, message: `"${raw}" is not an allowed value of ${def.key}. Allowed: ${allowed()}.` }
    return { ok: true, value }
  }
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null
  if (!items || items.some((item) => typeof item !== 'string')) {
    return { ok: false, message: `${def.key} takes a list of values: ${allowed()}.` }
  }
  const out: string[] = []
  for (const item of items as string[]) {
    if (!item.trim()) continue
    const value = pick(item)
    if (!value) return { ok: false, message: `"${item.trim()}" is not an allowed value of ${def.key}. Allowed: ${allowed()}.` }
    if (!out.includes(value)) out.push(value)
  }
  return { ok: true, value: out.length ? out : null }
}

/** Egy mező értéke egyezik-e a szűrő valamelyik értékével (kis-nagybetű nélkül). */
export function fieldValueMatches(value: unknown, wanted: string[]): boolean {
  const have = (Array.isArray(value) ? value : [value])
    .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    .map((item) => String(item).trim().toLowerCase())
  return wanted.some((item) => have.includes(item.trim().toLowerCase()))
}

// ---------------------------------------------------------------------------
// Kategória-szabályok (F3 ciklus + kötelező mezők, F4 sablon)

export type WikiSectionRuleName = 'warn' | 'error'

export type WikiCategoryRules = {
  reviewCycleDays: number | null
  requiredFields: string[]
  requiredSections: string[]
  sectionRule: WikiSectionRuleName
  /** Induló váz az új oldalhoz (az agent ebből indul). */
  templateMd: string | null
}

export const EMPTY_CATEGORY_RULES: WikiCategoryRules = {
  reviewCycleDays: null,
  requiredFields: [],
  requiredSections: [],
  sectionRule: 'warn',
  templateMd: null,
}

export const WIKI_SECTION_MAX = 120
export const WIKI_SECTIONS_MAX_COUNT = 20
export const WIKI_TEMPLATE_MAX_CHARS = 5_000

function ownRules(row: WikiCategoryRow): WikiCategoryRules {
  return {
    reviewCycleDays: row.reviewCycleDays ?? null,
    requiredFields: row.requiredFields ?? [],
    requiredSections: row.requiredSections ?? [],
    sectionRule: row.sectionRule === 'error' ? 'error' : 'warn',
    templateMd: row.templateMd ?? null,
  }
}

/**
 * Egy kulcsút (`partners/payment`) hatásos szabályai: az alkategória a szülő kötelező
 * mezőit és fejezeteit is örökli, a ciklusa és a váza felülírja a szülőét, a fejezet-
 * szabály a szigorúbb. Ismeretlen / üres kulcsút → `null`.
 */
export function categoryRulesFor(categoryPath: string | null | undefined, rows: WikiCategoryRow[]): WikiCategoryRules | null {
  const path = normalizeCategoryPath(categoryPath)
  if (!path) return null
  const [rootKey, childKey] = path.split('/')
  const content = rows.filter((row) => !row.linkedConnectorId)
  const root = content.find((row) => row.key === rootKey && !row.parentId)
  if (!root) return null
  const base = ownRules(root)
  if (!childKey) return base
  const child = content.find((row) => row.key === childKey && row.parentId === root.id)
  if (!child) return null
  const own = ownRules(child)
  return {
    reviewCycleDays: own.reviewCycleDays ?? base.reviewCycleDays,
    requiredFields: [...new Set([...base.requiredFields, ...own.requiredFields])],
    requiredSections: uniqueSections([...base.requiredSections, ...own.requiredSections]),
    sectionRule: base.sectionRule === 'error' || own.sectionRule === 'error' ? 'error' : 'warn',
    templateMd: own.templateMd ?? base.templateMd,
  }
}

function headingKey(value: string): string {
  return value.replace(/^#+\s*/, '').trim().toLowerCase()
}

/** Fejezetnevek a felületről / argumentumból: `## ` nélkül, egyedi, üres nélkül. */
export function uniqueSections(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const name = raw.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().slice(0, WIKI_SECTION_MAX)
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push(name)
  }
  return out
}

/** F4: a kötelező fejezetek közül azok, amelyek címsora (bármely szinten) hiányzik a törzsből. */
export function missingSections(body: string, required: string[]): string[] {
  if (!required.length) return []
  const present = new Set<string>()
  for (const match of body.matchAll(/^#{1,6}[ \t]+(.+?)\s*#*\s*$/gm)) present.add(headingKey(match[1]))
  return required.filter((section) => !present.has(headingKey(section)))
}

/** Induló váz a kötelező fejezetekből, ha a kategóriának nincs saját váza. */
export function skeletonFor(rules: WikiCategoryRules): string | null {
  if (rules.templateMd?.trim()) return rules.templateMd.trim()
  if (!rules.requiredSections.length) return null
  return rules.requiredSections.map((section) => `## ${section}\n\n`).join('').trim()
}

// ---------------------------------------------------------------------------
// Átnézés

const DAY_MS = 24 * 60 * 60 * 1000

/** Hatásos ciklus: oldalszintű felülírás, különben a kategóriáé; `null` = nincs átnézési rend. */
export function effectiveReviewCycle(meta: Pick<WikiPageMeta, 'reviewCycleDays'>, rules: WikiCategoryRules | null): number | null {
  return meta.reviewCycleDays ?? rules?.reviewCycleDays ?? null
}

/**
 * Esedékesség: utolsó átnézés + ciklus. Soha át nem nézett oldalnál a létrehozástól
 * számolunk (egy ma írt oldal nem lejárt); ciklus nélkül nincs esedékesség.
 */
export function reviewDueAt(input: { reviewedAt: string | null; createdAt: Date; cycleDays: number | null }): Date | null {
  if (!input.cycleDays) return null
  const base = input.reviewedAt ? new Date(input.reviewedAt) : input.createdAt
  if (Number.isNaN(base.getTime())) return null
  return new Date(base.getTime() + input.cycleDays * DAY_MS)
}

/** „utolsó átnézés + ciklus < ma” — naptári napra (UTC), a mai esedékesség még nem lejárt. */
export function isReviewOverdue(dueAt: Date | null, now: Date): boolean {
  return !!dueAt && dueAt.toISOString().slice(0, 10) < now.toISOString().slice(0, 10)
}

/** Hány napja járt le (0 = nem járt le). */
export function overdueDays(dueAt: Date | null, now: Date): number {
  if (!isReviewOverdue(dueAt, now)) return 0
  const due = Date.parse(`${dueAt!.toISOString().slice(0, 10)}T00:00:00Z`)
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)
  return Math.round((today - due) / DAY_MS)
}

// ---------------------------------------------------------------------------
// Átállás: régi frontmatter-értékek (bekapcsoláskor, előnézettel)

const DRAFT_WORDS = new Set(['draft', 'tervezet', 'vazlat', 'vázlat', 'wip', 'in progress', 'folyamatban'])
const APPROVED_WORDS = new Set(['approved', 'jovahagyott', 'jóváhagyott', 'final', 'végleges', 'vegleges', 'published', 'kész', 'kesz'])

export type WikiLegacyMeta = {
  docStatus?: WikiDocStatusName
  /** A gazda szövegként (e-mail vagy név) — a hívó párosítja platform-felhasználóhoz. */
  owner?: string
  reviewedAt?: string
  /** A frontmatter kulcsai, amelyekből átolvastunk (ezek kikerülnek a frontmatterből). */
  consumedKeys: string[]
}

/** A `status` / `owner` / `last_reviewed` régi kulcsok értelmezhető értékei. */
export function legacyMetaFromFrontmatter(frontmatter: Record<string, unknown>): WikiLegacyMeta {
  const out: WikiLegacyMeta = { consumedKeys: [] }
  const status = frontmatter.status
  if (typeof status === 'string') {
    const word = status.trim().toLowerCase()
    if (DRAFT_WORDS.has(word)) out.docStatus = 'draft'
    else if (APPROVED_WORDS.has(word)) out.docStatus = 'approved'
    if (out.docStatus) out.consumedKeys.push('status')
  }
  const owner = frontmatter.owner
  if (typeof owner === 'string' && owner.trim()) {
    out.owner = owner.trim()
    out.consumedKeys.push('owner')
  }
  for (const key of ['last_reviewed', 'lastReviewed', 'reviewed']) {
    const value = frontmatter[key]
    if (typeof value !== 'string') continue
    const text = value.trim()
    const date = isValidIsoDate(text) ? new Date(`${text}T00:00:00Z`) : new Date(text)
    if (!text || Number.isNaN(date.getTime())) continue
    out.reviewedAt = date.toISOString()
    out.consumedKeys.push(key)
    break
  }
  return out
}

// ---------------------------------------------------------------------------
// Nézet-szűrők (`kb_list_index`, „Nézetek” fül)

export type WikiViewFilter = {
  docStatus?: Array<WikiDocStatusName | 'none'>
  /** Felhasználó-azonosító, e-mail vagy `me`; a hívó oldja fel azonosítóra. */
  owner?: string[]
  reviewOverdue?: boolean
  category?: string[]
  fields?: Array<{ key: string; values: string[] }>
  orphans?: boolean
}

export const WIKI_VIEW_PARAM_KEYS = ['docStatus', 'owner', 'reviewOverdue', 'category', 'fields', 'orphans'] as const

function splitList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return [...new Set(items.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
}

function truthy(value: unknown): boolean | undefined {
  if (value === true || value === 'true' || value === '1' || value === 'yes') return true
  if (value === false || value === 'false' || value === '0' || value === 'no') return false
  return undefined
}

const STATUS_WORDS: Record<string, WikiDocStatusName | 'none'> = {
  draft: 'draft',
  tervezet: 'draft',
  approved: 'approved',
  jovahagyott: 'approved',
  'jóváhagyott': 'approved',
  none: 'none',
  unset: 'none',
}

/**
 * A hívás szűrő-paraméterei. A séma nem hordozhat tömböt (Claude.ai), ezért a több
 * érték vesszővel elválasztott szöveg: `docStatus`, `owner`, `category`, `field.<kulcs>`
 * (vagy `fields: "country=HU,SK;product=Card"`). Szűrő nélkül `null`.
 */
export function parseWikiViewFilter(args: Record<string, unknown>): WikiViewFilter | null {
  const filter: WikiViewFilter = {}
  const docStatus = splitList(args.docStatus)
    .map((word) => STATUS_WORDS[word.toLowerCase()])
    .filter((value): value is WikiDocStatusName | 'none' => !!value)
  if (docStatus.length) filter.docStatus = [...new Set(docStatus)]
  const owner = splitList(args.owner)
  if (owner.length) filter.owner = owner
  const overdue = truthy(args.reviewOverdue)
  if (overdue !== undefined) filter.reviewOverdue = overdue
  const category = splitList(args.category).map(normalizeCategoryPath).filter(Boolean)
  if (category.length) filter.category = [...new Set(category)]
  const orphans = truthy(args.orphans)
  if (orphans) filter.orphans = true
  const fields = new Map<string, string[]>()
  const addField = (rawKey: string, values: string[]) => {
    const key = rawKey.trim().toLowerCase()
    if (!WIKI_FIELD_KEY_RE.test(key) || !values.length) return
    fields.set(key, [...new Set([...(fields.get(key) ?? []), ...values])])
  }
  if (typeof args.fields === 'string') {
    for (const pair of args.fields.split(';')) {
      const eq = pair.indexOf('=')
      if (eq > 0) addField(pair.slice(0, eq), splitList(pair.slice(eq + 1)))
    }
  }
  for (const [name, value] of Object.entries(args)) {
    if (name.startsWith('field.')) addField(name.slice('field.'.length), splitList(value))
  }
  if (fields.size) filter.fields = [...fields.entries()].map(([key, values]) => ({ key, values }))
  return Object.keys(filter).length ? filter : null
}

/** Egy oldal kategóriája a szűrt kategóriák egyike (vagy annak alkategóriája). */
export function categoryMatches(category: string | null, wanted: string[]): boolean {
  const path = normalizeCategoryPath(category)
  if (!path) return false
  return wanted.some((item) => path === item || path.startsWith(`${item}/`))
}
