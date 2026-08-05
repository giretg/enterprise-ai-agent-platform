/**
 * GitHub Contents API válaszok modell-baráttá tétele.
 *
 * Két dolgot old meg, mert a nyers válaszból a modell egyiket sem tudja
 * megbízhatóan kihozni:
 *  1. FÁJL: a `encoding: "base64"` + `content` párost UTF-8 szöveggé dekódolja.
 *  2. KÖNYVTÁR: a listából kiveszi a bejegyzésenkénti 3 redundáns URL-t
 *     (`url`, `git_url`, `_links`) — ugyanaz a fa nagyjából feleannyi tokenből
 *     olvasható, és pont ez az a válasz, ami repo-böngészésnél túlcsordul.
 *
 * Minden más body érintetlenül megy tovább.
 */

const MAX_DECODE_BYTES = 2_000_000

/**
 * A `Buffer.from(x, 'base64')` a nem base64 karaktereket NÉMÁN eldobja, így egy
 * véletlenül base64-nek címkézett szövegből olvashatatlan kását csinálna. Ezért
 * előbb a karakterkészletet ellenőrizzük.
 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/

/** A modellnek semmit nem adnak hozzá: a `download_url` és `html_url` marad. */
const REDUNDANT_ENTRY_FIELDS = ['url', 'git_url', '_links'] as const

const CONTENTS_ENTRY_TYPES = new Set(['file', 'dir', 'symlink', 'submodule'])

type GitHubContentsFile = {
  type?: unknown
  encoding?: unknown
  content?: unknown
  name?: unknown
  path?: unknown
  size?: unknown
  download_url?: unknown
  sha?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isGitHubFileContents(body: unknown): body is GitHubContentsFile {
  if (!isRecord(body)) return false
  if (body.encoding !== 'base64') return false
  if (typeof body.content !== 'string' || body.content.length === 0) return false
  // Contents file: type=file, vagy legalább download_url / path a GitHub alakból.
  if (body.type === 'file') return true
  if (typeof body.download_url === 'string') return true
  if (typeof body.path === 'string' && typeof body.sha === 'string') return true
  return false
}

/** GitHub Contents könyvtárlista: csupa `{ type, name, path }` alakú bejegyzés. */
function isGitHubContentsListing(body: unknown): body is Array<Record<string, unknown>> {
  if (!Array.isArray(body) || body.length === 0) return false
  return body.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.name === 'string' &&
      typeof entry.path === 'string' &&
      typeof entry.type === 'string' &&
      CONTENTS_ENTRY_TYPES.has(entry.type),
  )
}

function stripRedundantEntryFields(entry: Record<string, unknown>): Record<string, unknown> {
  const trimmed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entry)) {
    if ((REDUNDANT_ENTRY_FIELDS as readonly string[]).includes(key)) continue
    trimmed[key] = value
  }
  return trimmed
}

/** Null bájt vagy sok vezérlőkarakter → bináris; ilyet nem tolunk UTF-8 szövegként. */
export function isProbablyBinaryBuffer(buf: Buffer): boolean {
  if (buf.length === 0) return false
  const sample = buf.subarray(0, Math.min(buf.length, 8192))
  if (sample.includes(0)) return true
  let weird = 0
  for (const b of sample) {
    // TAB/LF/CR OK; többi C0 vezérlő gyanús.
    if (b < 9 || (b > 13 && b < 32)) weird++
  }
  return weird / sample.length > 0.3
}

/**
 * GitHub Contents válasz normalizálása a modell csatornájára: fájlnál base64 →
 * UTF-8 (binárisnál a content elhagyva + jelzés), könyvtárlistánál a redundáns
 * URL-mezők elhagyása. Minden más body ugyanaz a referencia marad — a hívó ebből
 * tudja, hogy nem nyúltunk hozzá.
 */
export function decodeGitHubContentsBody(body: unknown): unknown {
  if (isGitHubContentsListing(body)) return body.map(stripRedundantEntryFields)
  if (!isGitHubFileContents(body)) return body

  const rawB64 = (body.content as string).replace(/\s+/g, '')
  if (!BASE64_PATTERN.test(rawB64)) return body
  const decoded = Buffer.from(rawB64, 'base64')
  if (decoded.length === 0) return body

  const trimmed = stripRedundantEntryFields(body as Record<string, unknown>)
  if (decoded.length > MAX_DECODE_BYTES) {
    return {
      ...trimmed,
      content: null,
      encoding: 'omitted',
      byteLength: decoded.length,
      decodeNote:
        `A fájl dekódolva ${decoded.length} bájt — ekkora tartalom a modell kontextusába nem fér be. ` +
        'Kérd a fájl egy kisebb, konkrét részét (pl. másik útvonal / kisebb modul), vagy dolgozz a repo ' +
        'fastruktúrájából; ezt a választ ne próbáld darabokban visszaolvasni.',
    }
  }

  if (isProbablyBinaryBuffer(decoded)) {
    return {
      ...trimmed,
      content: null,
      encoding: 'binary',
      byteLength: decoded.length,
      decodeNote:
        'Bináris fájl — a tartalom nincs szövegként dekódolva. ' +
        'Szöveges forrást (md/ts/json/html) kérj, vagy a download_url-t használd külső letöltéshez ha elérhető.',
    }
  }

  return {
    ...trimmed,
    content: decoded.toString('utf8'),
    encoding: 'utf-8',
    byteLength: decoded.length,
  }
}
