/**
 * Mini app élő adat-kötése (#1083 §4): a kötés a mini app verziójához tartozik, és
 * rögzíti a mentett lekérdezés verzióját. Az eredmény megnyitáskor, szerveroldalon
 * kerül a HTML-be, a tárolt forrás és a tartalom-hash adat nélküli marad. Tiszta
 * függvények, adatbázis nélkül.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'

export const MINI_APP_BINDINGS_MAX = 5
export const MINI_APP_BINDING_DEFAULT_ROWS = 1_000
export const MINI_APP_BINDING_MAX_ROWS = 5_000
/** Egy megnyitáskor az összes kötés együtt legfeljebb ennyi bájt adatot ad. */
export const MINI_APP_LIVE_DATA_MAX_BYTES = 2 * 1024 * 1024
/** D6: kötött app gyors linkje legfeljebb 1 óráig él. */
export const MINI_APP_LIVE_LINK_TTL_MS = 60 * 60 * 1000
export const MINI_APP_DATA_ELEMENT_ID = 'platform-data'
/** A CSP-fejléc mérete miatt: ennyi beágyazott szkriptnél több nem engedélyezhető. */
export const MINI_APP_INLINE_SCRIPTS_MAX = 50

const bindingParamValue = z.union([
  z.string().max(1_000),
  z.number(),
  z.boolean(),
  z.object({ relative: z.string().max(40) }).strict(),
])

export const miniAppDataBindingInputSchema = z
  .object({
    alias: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/),
    queryId: z.string().uuid(),
    params: z.record(z.string().max(41), bindingParamValue).optional(),
    maxRows: z.number().int().min(1).max(MINI_APP_BINDING_MAX_ROWS).optional(),
  })
  .strict()

export const miniAppDataBindingsInputSchema = z.array(miniAppDataBindingInputSchema).max(MINI_APP_BINDINGS_MAX)

export type MiniAppDataBindingInput = z.infer<typeof miniAppDataBindingInputSchema>

/** A verzióhoz tárolt kötés: a lekérdezés verziója rögzített (D7). */
export type MiniAppDataBinding = {
  alias: string
  queryId: string
  queryVersion: number
  params: Record<string, unknown>
  maxRows: number
}

export type MiniAppLiveBlock =
  | {
      status: 'ok'
      columns: string[]
      columnLabels: string[]
      rows: unknown[][]
      truncated: boolean
      dataAsOf: string | null
      warnings: Array<{ code: string; dataset: string; detail?: unknown }>
    }
  | { status: 'error'; code: string }

/** JSON-szöveg → bemeneti kötések; az alias egyedi. Hibánál `ok: false` + ok. */
export function parseDataBindingsInput(raw: string): { ok: true; bindings: MiniAppDataBindingInput[] } | { ok: false; detail: string } {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false, detail: 'dataBindings must be a JSON array' }
  }
  const parsed = miniAppDataBindingsInputSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, detail: `${issue?.path.join('.') || 'dataBindings'}: ${issue?.message ?? 'invalid'}` }
  }
  const aliases = parsed.data.map((binding) => binding.alias)
  if (new Set(aliases).size !== aliases.length) return { ok: false, detail: 'alias must be unique' }
  return { ok: true, bindings: parsed.data }
}

/** Kötés-lista az adatbázisból: a hibás sor nem futhat, ezért az a sor kimarad. */
export function readStoredBindings(value: unknown): MiniAppDataBinding[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): MiniAppDataBinding[] => {
    const row = item as Partial<MiniAppDataBinding> | null
    if (!row || typeof row.alias !== 'string' || typeof row.queryId !== 'string' || typeof row.queryVersion !== 'number') return []
    return [{
      alias: row.alias,
      queryId: row.queryId,
      queryVersion: row.queryVersion,
      params: row.params && typeof row.params === 'object' ? row.params : {},
      maxRows: typeof row.maxRows === 'number' ? Math.min(row.maxRows, MINI_APP_BINDING_MAX_ROWS) : MINI_APP_BINDING_DEFAULT_ROWS,
    }]
  })
}

/** Azonos kötés-e (a kulcsok sorrendje nem számít): a változás új app-verziót hoz. */
export function sameBindings(a: MiniAppDataBinding[], b: MiniAppDataBinding[]): boolean {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]))
    }
    return value
  }
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b))
}

// A két jel nyers formában a forrásszöveget is eltörné, ezért kóddal hivatkozunk rájuk.
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g')

/**
 * A beágyazott JSON szövege: a `<` és a sortörő unicode-jelek escape-elve vannak, így
 * cellaérték nem tud kitörni a `<script>` blokkból, és a tartalma ugyanaz marad.
 */
export function serializeLiveData(data: Record<string, MiniAppLiveBlock>): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LINE_SEPARATORS, (char) => `\\u${char.charCodeAt(0).toString(16)}`)
}

const NAME_END = /[\s/>]/
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'])

type HtmlAttribute = { name: string; value: string }

/**
 * Egy nyitó tag végét és attribútumait olvassa a HTML-elemző szabályai szerint.
 * Lineáris; a lezáratlan tagnál `end: -1`.
 */
function readStartTag(html: string, nameEnd: number): { end: number; attributes: HtmlAttribute[] } {
  const attributes: HtmlAttribute[] = []
  let at = nameEnd
  for (;;) {
    while (at < html.length && (/\s/.test(html[at]!) || html[at] === '/')) at += 1
    if (at >= html.length) return { end: -1, attributes }
    if (html[at] === '>') return { end: at, attributes }
    const start = at
    at += 1
    while (at < html.length && !/[\s/>=]/.test(html[at]!)) at += 1
    const attribute: HtmlAttribute = { name: html.slice(start, at).toLowerCase(), value: '' }
    attributes.push(attribute)
    while (at < html.length && /\s/.test(html[at]!)) at += 1
    if (html[at] !== '=') continue
    at += 1
    while (at < html.length && /\s/.test(html[at]!)) at += 1
    const quote = html[at]
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, at + 1)
      if (close < 0) return { end: -1, attributes }
      attribute.value = html.slice(at + 1, close)
      at = close + 1
    } else {
      const valueStart = at
      while (at < html.length && !/[\s>]/.test(html[at]!)) at += 1
      attribute.value = html.slice(valueStart, at)
    }
  }
}

export type HtmlScan = {
  /** A beágyazott szkriptek szövege, ahogy a böngésző hasheli (a sorvég normalizálva); külső forrású nincs köztük. */
  scripts: string[]
  /** Van-e `on*` attribútum valamelyik elemen. */
  eventHandler: boolean
  /** Van-e automatikus átirányítás (`<meta http-equiv=refresh>`). */
  metaRefresh: boolean
}

/**
 * Lineáris HTML-bejárás a kötött verzióhoz: agent-írta bemeneten fut, ezért nem regex.
 * A rosszul olvasott szerkezet legfeljebb azt okozza, hogy egy szkript nem fut le, a beszúrt
 * kód soha nem kap engedélyt.
 */
export function scanHtml(html: string): HtmlScan {
  // Csak az ASCII kisbetűsítés őrzi meg az indexeket: a teljes `toLowerCase` hosszt is változtathat.
  const lowered = html.replace(/[A-Z]/g, (char) => char.toLowerCase())
  const scan: HtmlScan = { scripts: [], eventHandler: false, metaRefresh: false }
  let at = 0
  while (at < html.length) {
    const open = html.indexOf('<', at)
    if (open < 0) break
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4)
      if (end < 0) break
      at = end + 3
      continue
    }
    if (html[open + 1] === '!' || html[open + 1] === '?' || html[open + 1] === '/') {
      const end = html.indexOf('>', open + 1)
      if (end < 0) break
      at = end + 1
      continue
    }
    if (!/[a-zA-Z]/.test(html[open + 1] ?? '')) {
      at = open + 1
      continue
    }
    let nameEnd = open + 1
    while (nameEnd < html.length && !NAME_END.test(html[nameEnd]!)) nameEnd += 1
    const name = lowered.slice(open + 1, nameEnd)
    if (name === 'plaintext') break
    const tag = readStartTag(html, nameEnd)
    if (tag.end < 0) break
    if (tag.attributes.some((attribute) => /^on[a-z]/.test(attribute.name))) scan.eventHandler = true
    if (name === 'meta' && tag.attributes.some((attribute) => attribute.name === 'http-equiv' && attribute.value.trim().toLowerCase() === 'refresh')) scan.metaRefresh = true
    if (!RAW_TEXT_ELEMENTS.has(name)) {
      at = tag.end + 1
      continue
    }
    const close = skipRawText(lowered, name, tag.end + 1)
    if (name === 'script' && !tag.attributes.some((attribute) => attribute.name === 'src' || attribute.name === 'href' || attribute.name === 'xlink:href')) {
      scan.scripts.push(html.slice(tag.end + 1, close).replace(/\r\n?/g, '\n'))
    }
    at = close
  }
  return scan
}

export function inlineScriptBodies(html: string): string[] {
  return scanHtml(html).scripts
}

export function scriptHashSource(body: string): string {
  return `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`
}

/** A nyers szövegű elem záró tagjáig ugrik; nincs ilyen → a dokumentum vége. */
function skipRawText(lowered: string, name: string, from: number): number {
  const close = `</${name}`
  let at = from
  for (;;) {
    const found = lowered.indexOf(close, at)
    if (found < 0) return lowered.length
    const after = lowered[found + close.length]
    if (after === undefined || NAME_END.test(after)) return found
    at = found + close.length
  }
}
