/**
 * Gyűjtőindex (katalógus) felismerés + leaf-kinyerés önfrissítő connectorokhoz.
 *
 * Háttér: egyes szolgáltatók (pl. POSnavigator `openapi/catalog.yaml`) nem egyetlen
 * API leírását adják egy URL-en, hanem egy OpenAPI-dokumentumba csomagolt
 * gyűjtőindexet, aminek minden `paths`-bejegyzése egy leaf-spec fájlra mutat
 * (`/openapi/blogs.yaml`, …). Egy ilyen URL-ből létrehozott connector csak
 * dokumentáció-olvasó képességeket kapna, adatműveletet egyet sem — ezért a
 * katalógust fel kell ismerni, és leafenként külön connector kell.
 *
 * Ez a modul TISZTA: nincs DB, nincs hálózat. A heurisztika szándékosan
 * provider-független: „minden path spec-fájlra mutat" — nem posnavigatoros
 * stringekre illeszt.
 */

export type CatalogLeaf = {
  /** A katalógus-`paths` kulcsa, pl. `/openapi/blogs.yaml`. */
  key: string
  /** Javasolt connector-név (fájlnév kiterjesztés nélkül), pl. `blogs`. */
  name: string
  /** Abszolút, https leaf-spec URL. */
  specUrl: string
  /** A katalógusban szereplő leírás, ha volt. */
  summary: string | null
}

type OpenApiLike = {
  openapi?: unknown
  servers?: unknown
  paths?: unknown
}

const SPEC_FILE_SUFFIX = /\.(ya?ml|json)(\?.*)?(#.*)?$/i
const MAX_LEAVES = 50

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Egy `paths`-kulcs akkor leaf-jelölt, ha spec-fájlra mutat (nem adatművelet). */
export function isSpecFilePath(pathKey: string): boolean {
  const pathname = pathKey.split('?')[0]?.split('#')[0] ?? ''
  return SPEC_FILE_SUFFIX.test(pathname)
}

/**
 * Gyűjtőindex-e a dokumentum? Igen, ha van legalább egy `paths`-bejegyzés, és
 * MIND spec-fájlra mutat. Egy valódi API-leírás (`/api/v1/blogs`, …) sosem ilyen.
 */
export function isCatalogIndexDocument(doc: unknown): boolean {
  if (!isRecord(doc)) return false
  const paths = doc.paths
  if (!isRecord(paths)) return false
  const keys = Object.keys(paths)
  if (keys.length === 0) return false
  return keys.every(isSpecFilePath)
}

function leafNameFromKey(pathKey: string): string {
  const pathname = pathKey.split('?')[0]?.split('#')[0] ?? pathKey
  const file = pathname.split('/').filter(Boolean).pop() ?? pathname
  return file.replace(/\.(ya?ml|json)$/i, '') || file
}

function resolveBase(doc: OpenApiLike, catalogUrl: string): string {
  if (Array.isArray(doc.servers)) {
    for (const entry of doc.servers) {
      if (isRecord(entry) && typeof entry.url === 'string') {
        try {
          const url = new URL(entry.url, catalogUrl)
          if (url.protocol === 'https:') return url.toString()
        } catch {
          // relatív/hibás servers-bejegyzés: következő jelölt.
        }
      }
    }
  }
  return catalogUrl
}

function operationSummary(pathItem: unknown): string | null {
  if (!isRecord(pathItem)) return null
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const op = pathItem[method]
    if (!isRecord(op)) continue
    for (const field of ['summary', 'description']) {
      const value = op[field]
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 300)
    }
  }
  return null
}

/**
 * A katalógus leafjei abszolút URL-ekkel. A katalógus önmagára mutató
 * bejegyzését (pl. `/openapi/catalog.yaml` ugyanarról az URL-ről) kihagyjuk:
 * belőle csak újabb, ugyanilyen üres connector születne.
 */
export function extractCatalogLeaves(doc: unknown, catalogUrl: string): CatalogLeaf[] {
  if (!isCatalogIndexDocument(doc)) return []
  const record = doc as OpenApiLike & { paths: Record<string, unknown> }
  const base = resolveBase(record, catalogUrl)
  const leaves: CatalogLeaf[] = []
  for (const [key, pathItem] of Object.entries(record.paths)) {
    if (!isSpecFilePath(key)) continue
    let specUrl: string
    try {
      specUrl = new URL(key, base).toString()
    } catch {
      continue
    }
    if (!specUrl.startsWith('https://')) continue
    if (specUrl.split('#')[0] === catalogUrl.split('#')[0]) continue
    leaves.push({
      key,
      name: leafNameFromKey(key),
      specUrl,
      summary: operationSummary(pathItem),
    })
    if (leaves.length >= MAX_LEAVES) break
  }
  return leaves
}
