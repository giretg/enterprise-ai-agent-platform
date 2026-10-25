/**
 * Issue #659: one decision table for where client AI stores agent knowledge.
 */

export type KnowledgePlacementTarget =
  | 'project_memory'
  | 'skill'
  | 'knowledge_base'
  | 'agent_wiki'
  | 'work_file'
  | 'drive'
  | 'session_log'
  | 'focus'

/** A tábla sorai. A `key` az agentenkénti felülírás azonosítója — ne nevezd át. */
export const PLACEMENT_ROW_KEYS = [
  'fact',
  'rule',
  'reference',
  'plan',
  'deliverable',
  'session_log',
  'focus',
  'wiki',
] as const
export type PlacementRowKey = (typeof PLACEMENT_ROW_KEYS)[number]

type PlacementRow = { key: PlacementRowKey; what: string; where: string; tool: string }

export const KNOWLEDGE_PLACEMENT_ROWS: readonly PlacementRow[] = [
  { key: 'fact', what: 'Company fact, decision, location (true now)', where: 'memory', tool: '`platform.project_memory.write` (replaceId when it changed)' },
  { key: 'rule', what: 'Operating rule or procedure ("how we do it")', where: 'skill — propose for approval', tool: '`platform.skills.submit`' },
  { key: 'reference', what: 'Reference document, knowledge material', where: 'knowledge base', tool: '`kb_ingest` (`raw_text_only`)' },
  { key: 'plan', what: 'Work plan, notes, draft', where: 'work file', tool: '`platform.work_file.write` (growing log: `platform.work_file.append`)' },
  { key: 'deliverable', what: 'Finished deliverable for humans', where: 'agent Drive folder', tool: '`google_drive_upload_file`' },
  { key: 'session_log', what: 'What happened today', where: 'session log', tool: '`platform.project_memory.write` kind `session_log`' },
  { key: 'focus', what: 'What we are working on now', where: 'focus', tool: '`platform.project_memory.write` kind `focus`' },
  { key: 'wiki', what: 'Knowledge to learn and connect', where: 'agent wiki', tool: '`kb_ingest` (wiki) → `kb_wiki_write`' },
]

/** Admin által agentenként felülírt sorok: sor-kulcs → saját szabály (a „Where + Tool” helyett). */
export type PlacementOverrides = Partial<Record<PlacementRowKey, string>>

export const PLACEMENT_OVERRIDE_MAX = 300

const ROW_KEY_SET: ReadonlySet<string> = new Set(PLACEMENT_ROW_KEYS)

/** Ismeretlen kulcsot, nem szöveget és üreset eldob; a hosszt vágja. Üres eredmény = nincs felülírás. */
export function parsePlacementOverrides(value: unknown): PlacementOverrides {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: PlacementOverrides = {}
  for (const key of PLACEMENT_ROW_KEYS) {
    const raw = (value as Record<string, unknown>)[key]
    if (typeof raw !== 'string') continue
    const text = raw.replace(/\s+/g, ' ').trim().slice(0, PLACEMENT_OVERRIDE_MAX)
    if (text) out[key] = text
  }
  return out
}

export function hasPlacementOverrides(overrides: PlacementOverrides | undefined): boolean {
  return Object.keys(overrides ?? {}).some((key) => ROW_KEY_SET.has(key))
}

function renderPlacementTable(rows: readonly PlacementRow[], overrides: PlacementOverrides = {}): string {
  const lines = rows.map((row) => {
    const own = overrides[row.key]
    return own
      ? `| ${row.what} | ${own} | agent rule |`
      : `| ${row.what} | ${row.where} | ${row.tool} |`
  })
  return ['| What | Where | Tool |', '|---|---|---|', ...lines].join('\n')
}

export const KNOWLEDGE_PLACEMENT_TABLE = renderPlacementTable(
  KNOWLEDGE_PLACEMENT_ROWS.filter((row) => row.key !== 'wiki'),
)

export const KNOWLEDGE_PLACEMENT_TABLE_REF =
  'Use the "Where to save what" table in server instructions and the agent briefing — pick the row before any write.'

export function renderKnowledgePlacementBlock(
  input: { wikiCapable?: boolean; overrides?: PlacementOverrides } = {},
): string {
  const overrides = input.overrides ?? {}
  const rows = KNOWLEDGE_PLACEMENT_ROWS.filter((row) => row.key !== 'wiki' || input.wikiCapable || overrides.wiki)
  return [
    'WHERE TO SAVE WHAT',
    'When the user asks to remember, save, or store something, pick exactly one row — do not put operating rules in memory, plans in memory, or reference documents in memory.',
    ...(hasPlacementOverrides(overrides)
      ? ['A row marked "agent rule" is this agent\'s own choice: it replaces the default for that row.']
      : []),
    '',
    renderPlacementTable(rows, overrides),
  ].join('\n')
}

export type MisplacedMemoryWrite = {
  suggest: KnowledgePlacementTarget
  reason: 'procedure' | 'document'
}

/** Facts in memory stay short; long or procedural text belongs elsewhere (#659). */
export const MEMORY_FACT_SOFT_MAX = 1_200

const PROCEDURE_LINE =
  /^\s*(?:\d+[\.)]|[-*•])\s+(?:mindig|soha|never|always|ellenőriz|check|must|kötelező|ensure|verify)/im

function procedureScore(text: string): number {
  const lines = text.split(/\r?\n/)
  let score = 0
  for (const line of lines) {
    if (PROCEDURE_LINE.test(line)) score++
    if (/^\s*\d+[\.)]\s/.test(line)) score++
  }
  const folded = text.toLowerCase()
  if (/\b(eljárás|szabály|procedure|policy|operating rule|how we do)\b/u.test(folded)) score += 2
  if (/\b(mindig|soha|must always|never skip|kötelező)\b/u.test(folded)) score += 1
  return score
}

export function detectMisplacedMemoryWrite(input: {
  kind: string
  title: string
  body: string
  wikiCapable?: boolean
}): MisplacedMemoryWrite | null {
  if (input.kind === 'focus' || input.kind === 'session_log') return null
  const text = `${input.title}\n${input.body}`.trim()
  const proc = procedureScore(text)
  if (proc >= 4) return { suggest: 'skill', reason: 'procedure' }
  if (input.body.length > MEMORY_FACT_SOFT_MAX) {
    const planLike = /\b(terv|plan|todo|feladatlista|outline|draft|jegyzet)\b/i.test(text)
    return { suggest: planLike ? 'work_file' : input.wikiCapable ? 'agent_wiki' : 'knowledge_base', reason: 'document' }
  }
  if (proc >= 2 && input.body.length > 400) return { suggest: 'skill', reason: 'procedure' }
  return null
}

export function suggestToolForPlacement(target: KnowledgePlacementTarget): string {
  switch (target) {
    case 'project_memory':
      return 'platform.project_memory.write'
    case 'skill':
      return 'platform.skills.submit'
    case 'agent_wiki':
      return 'kb_wiki_write'
    case 'knowledge_base':
      return 'kb_ingest'
    case 'work_file':
      return 'platform.work_file.write'
    case 'drive':
      return 'google_drive_upload_file'
    case 'session_log':
      return 'platform.project_memory.write (kind session_log)'
    case 'focus':
      return 'platform.project_memory.write (kind focus)'
  }
}
