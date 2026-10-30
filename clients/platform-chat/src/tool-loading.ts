/**
 * Halasztott eszköz-betöltés (#1022, a #468 mintája a workerre átültetve).
 * A modell alapból csak a mag-eszközök teljes sémáját kapja (`tools[]`); a többiből név + egysoros
 * leírás kerül a system promptba (eszköz-index). A `tool_describe` harness-eszközzel (helyben, nem
 * MCP-hívás) kéri le a többit, és a betöltött eszközt utána a saját nevén hívja — nincs burkoló, így
 * az idempotencia-kulcs, a jóváhagyás (MRTR) és az audit változatlan.
 */
import type { TurnContext } from './store.ts'

export const TOOL_DESCRIBE = 'tool_describe'
export const DESCRIBE_MAX_NAMES = 8
const SUMMARY_MAX_CHARS = 120

/** Szinte minden fordulóban kellő, kis sémájú eszközök (a worker env-ből felülírhatja). */
export const DEFAULT_CORE_TOOLS = ['platform.project_memory.read', 'kb_search', 'web_search']

/** A modell-szolgáltató a függvénynevet `^[a-zA-Z0-9_-]{1,64}$` mintához köti — a visszajátszott hívásokra is. */
export const toFunctionName = (tool: string) => tool.replace(/\./g, '__').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)

type Tool = TurnContext['tools'][number]

/** Csoportok fix sorrendben (név-előtag szerint); ami egyikbe sem esik, az „Egyéb”. */
const GROUPS: Array<[label: string, prefixes: string[]]> = [
  ['Memória és munkafájlok', ['platform.project_memory.', 'platform.work_file.', 'platform.projects.']],
  ['Tudástár', ['kb_']],
  ['Webes keresés', ['web_']],
  ['Google Drive', ['google_drive_']],
  ['Google Táblázatok', ['google_sheets_']],
  ['Gmail', ['gmail_']],
  ['Naptár', ['google_calendar_', 'calendar_']],
  ['Adattárház', ['warehouse_']],
  ['Külső API-k', ['http_api_']],
  ['Külső MCP-szerverek', ['mcp_']],
  ['Kódfuttatás', ['sandbox_']],
  ['Mini-appok', ['platform.mini_app.']],
  ['Ütemezett feladatok', ['platform.scheduled_task.']],
  ['Vállalások és átadás', ['platform.promise.', 'platform.handoff']],
  ['Skillek', ['platform.skills.']],
  ['Platform', ['platform.']],
]
const OTHER_GROUP = 'Egyéb'

export function toolGroup(name: string): string {
  const fn = toFunctionName(name)
  return GROUPS.find(([, prefixes]) => prefixes.some((p) => name.startsWith(p) || fn.startsWith(toFunctionName(p))))?.[0] ?? OTHER_GROUP
}

/** Kódpont-sorrend (nem `localeCompare`): futtató környezettől független, bájt-azonos kimenet. */
export const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** A leírás első mondata, legfeljebb 120 karakter. */
export function summary(description: string | undefined): string {
  const text = (description ?? '').replace(/\s+/g, ' ').trim()
  const first = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text
  return first.length > SUMMARY_MAX_CHARS ? `${first.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…` : first
}

/** Mag-eszközök a definícióból (opcionális `preloadTools`, a definíció tetején vagy a `snapshot`-ban). */
export function definitionCoreTools(definition: string): string[] {
  try {
    const parsed = JSON.parse(definition) as { preloadTools?: unknown; snapshot?: { preloadTools?: unknown } }
    const list = parsed?.preloadTools ?? parsed?.snapshot?.preloadTools
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
}

/** A forduló eleji halmazok: mag (worker-lista ∪ a definíció mag-listája), betöltött = mag ∪ az előző forduló betöltöttjei (ragadós). */
export function initialLoading(tools: Tool[], input: { core: readonly string[]; definition: string; sticky: readonly string[] }) {
  const names = tools.map((t) => t.name)
  const coreSet = new Set([...input.core, ...definitionCoreTools(input.definition)])
  const core = names.filter((n) => coreSet.has(n)).sort()
  const sticky = new Set(input.sticky)
  return { core, loaded: names.filter((n) => coreSet.has(n) || sticky.has(n)).sort() }
}

/** Régi (#1022 előtti) kontextusban nincs `loaded`: ott minden eszköz betöltött, mint eddig. */
export function isLoaded(context: TurnContext, name: string): boolean {
  return !context.loaded || context.loaded.includes(name)
}

/**
 * Van-e eszköz-index (és vele `tool_describe`): csak a mag-listától függ, a betöltött halmaztól nem. Így a
 * `tool_describe` akkor is a `tools[]`-ben marad, ha már minden be van töltve — a fordulóban korábban kiadott
 * `tool_describe`-hívások visszajátszásához definiált függvény kell, és az index is erre hivatkozik.
 */
export function hasIndex(context: TurnContext): boolean {
  if (!context.loaded) return false
  const core = new Set(context.core ?? [])
  return context.tools.some((t) => !core.has(t.name))
}

/** Eszköz keresése eredeti vagy modell-oldali (függvény-) néven. */
export function findTool(context: TurnContext, name: string): Tool | undefined {
  return context.tools.find((t) => t.name === name) ?? context.tools.find((t) => toFunctionName(t.name) === name)
}

/**
 * Eszköz-index a system promptba: minden nem-mag eszköz csoportosítva, stabil sorrendben. Csak a mag-listától
 * függ (a betöltött halmaztól nem), így fordulón belül és fordulók között is bájt-azonos — a prompt-cache tart.
 */
export function toolIndex(context: TurnContext): string {
  if (!hasIndex(context)) return ''
  const core = new Set(context.core ?? [])
  const deferred = context.tools.filter((t) => !core.has(t.name))
  const groups = new Map<string, Tool[]>()
  for (const t of deferred) groups.set(toolGroup(t.name), [...(groups.get(toolGroup(t.name)) ?? []), t])
  const order = [...GROUPS.map(([label]) => label), OTHER_GROUP]
  const lines = [
    '--- TOVÁBBI ESZKÖZÖK (eszköz-index) ---',
    `Ezeknek az eszközöknek a paraméter-sémája még nincs nálad. Ha valamelyikre szükséged van, ELŐBB hívd a ${TOOL_DESCRIBE} ` +
      `eszközt a nevükkel (egyszerre legfeljebb ${DESCRIBE_MAX_NAMES}), utána a saját nevükön hívd őket. ` +
      'Ha egy eszköz már a függvény-listádban van, hívd közvetlenül.',
  ]
  for (const label of order) {
    const list = groups.get(label)
    if (!list) continue
    lines.push('', label)
    for (const t of [...list].sort(byName)) {
      const line = summary(t.description)
      lines.push(`- ${toFunctionName(t.name)}${line ? ` — ${line}` : ''}`)
    }
  }
  return lines.join('\n')
}

export const TOOL_DESCRIBE_DEFINITION = {
  type: 'function',
  function: {
    name: TOOL_DESCRIBE,
    description:
      'Az eszköz-indexben szereplő eszközök teljes paraméter-sémájának betöltése. A következő lépéstől a betöltött ' +
      'eszközök a függvény-listádban vannak: a saját nevükön hívd őket. A már betöltött eszközöknél felesleges.',
    parameters: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, maxItems: DESCRIBE_MAX_NAMES, description: 'Az eszközök neve az indexből.' },
      },
      required: ['names'],
    },
  },
} as const

/** A `tool_describe` helyi végrehajtása: a kért eszközök bekerülnek a betöltött halmazba. */
export function describeTools(context: TurnContext, args: Record<string, unknown>): { text: string; isError: boolean; loaded: string[] } {
  const loaded = new Set(context.loaded ?? context.tools.map((t) => t.name))
  const requested = Array.isArray(args.names) ? args.names.filter((n): n is string => typeof n === 'string') : []
  if (requested.length === 0) return { text: 'Error: add meg a betöltendő eszközök nevét a names listában.', isError: true, loaded: [...loaded].sort() }
  const ok: string[] = []
  const unknown: string[] = []
  for (const name of requested.slice(0, DESCRIBE_MAX_NAMES)) {
    const tool = findTool(context, name)
    if (!tool) unknown.push(name)
    else {
      loaded.add(tool.name)
      ok.push(toFunctionName(tool.name))
    }
  }
  const parts: string[] = []
  if (ok.length) parts.push(`Betöltve: ${ok.join(', ')}. A következő lépéstől a függvény-listádban vannak — hívd őket a saját nevükön.`)
  if (unknown.length) parts.push(`Nem elérhető eszköz: ${unknown.join(', ')}. Csak az eszköz-indexben szereplő nevek tölthetők be.`)
  if (requested.length > DESCRIBE_MAX_NAMES) parts.push(`Egyszerre legfeljebb ${DESCRIBE_MAX_NAMES} eszköz tölthető be; a többit kérd külön.`)
  return { text: parts.join('\n'), isError: ok.length === 0, loaded: [...loaded].sort() }
}
