/**
 * #1070: fájl-válasz egy kapcsolt rendszertől (Excel, PDF, CSV-letöltés). A törzset bájtként olvassuk,
 * mert `res.text()` a bináris fájlt visszafordíthatatlanul elrontaná, és a modell kontextusába sem
 * kerülhet. A fájl a letölthető-fájl tárolóba megy (lásd `document-export`), a modell csak a
 * metaadatot és a linket kapja.
 */
import { createHash } from 'node:crypto'

export const HTTP_API_FILE_MAX_BYTES = 25 * 1024 * 1024

/**
 * A nem-fájl (szöveges/JSON) válasz törzsének felső korlátja. A fájl-válasznál (bájt-út) ez a
 * `HTTP_API_FILE_MAX_BYTES`; a szöveges úton eddig NEM volt plafon (`res.text()` az egész törzset
 * memóriába húzta), így egy hibás/rosszindulatú kapcsolt rendszer tetszőlegesen nagy JSON-/
 * szövegtörzzsel kiüthette a közös, több-bérlős workert (OOM — vö. a Cloud Run OOM mintával). A
 * plafon bőven a letölthetőre (10 MB mentett válasz) és a fájl-átadásra (25 MB) hozott határok fölött
 * van, így semmilyen jelenleg is kézbesíthető válasz nem regresszálódik; az ennél nagyobb törzs
 * strukturált `response_too_large` hibát ad, nem OOM-ot. */
export const HTTP_API_MAX_RESPONSE_BYTES = 32 * 1024 * 1024

export type HttpApiFile = {
  bytes: Buffer
  fileName: string
  /** A content-type paraméterek nélkül (pl. `application/pdf`). */
  mimeType: string
  /** A fájlnév kiterjesztése, kisbetűvel (`xlsx`, `pdf`…), vagy `bin`. */
  format: string
  sha256: string
}

/** Ezek a típusok mindig fájlok; minden más csak `attachment` disposition-nel. */
const FILE_MIME_PATTERNS: RegExp[] = [
  /^application\/vnd\.openxmlformats-/,
  /^application\/vnd\.oasis\.opendocument\./,
  /^application\/vnd\.ms-(excel|powerpoint)$/,
  /^application\/msword$/,
  /^application\/pdf$/,
  /^application\/octet-stream$/,
  /^application\/(zip|x-zip-compressed|gzip|x-gzip)$/,
  /^image\//,
]

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-excel': 'xls',
  'application/msword': 'doc',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/gzip': 'gz',
  'application/x-gzip': 'gz',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'application/json': 'json',
  'image/png': 'png',
  'image/jpeg': 'jpg',
}

function baseMime(contentType: string | null): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase()
}

function dispositionParam(disposition: string, name: string): string | null {
  const match = disposition.match(new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*("((?:[^"\\\\]|\\\\.)*)"|[^;]*)`, 'i'))
  if (!match) return null
  return (match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[1]).trim() || null
}

/**
 * Az eredeti fájlnév a `content-disposition`-ből: előbb az RFC 5987 `filename*`, utána a `filename`.
 * Az undici a fejlécet latin-1-ként adja vissza, ezért a nyers UTF-8 ékezetes nevet visszaalakítjuk.
 */
export function contentDispositionFileName(disposition: string | null): string | null {
  if (!disposition) return null
  const extended = dispositionParam(disposition, 'filename\\*')
  if (extended) {
    const m = extended.match(/^([\w-]+)'[^']*'(.*)$/)
    try {
      if (m) {
        return m[1].toLowerCase() === 'utf-8'
          ? decodeURIComponent(m[2])
          : m[2].replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      }
    } catch {
      // hibás kódolás — a sima filename marad
    }
  }
  const plain = dispositionParam(disposition, 'filename')
  if (!plain) return null
  if (/[\u0080-ÿ]/.test(plain) && !/[^\u0000-ÿ]/.test(plain)) {
    const utf8 = Buffer.from(plain, 'latin1').toString('utf8')
    if (!utf8.includes('�')) return utf8
  }
  return plain
}

function safeFileName(raw: string | null, mimeType: string): string {
  const cleaned = (raw ?? '')
    .normalize('NFC')
    .replace(/^.*[/\\]/, '')
    .replace(/[\u0000-\u001f\u007f:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(-160)
  const ext = EXTENSION_BY_MIME[mimeType]
  if (!cleaned) return `letoltes.${ext ?? 'bin'}`
  return ext && !/\.[a-z0-9]{1,8}$/i.test(cleaned) ? `${cleaned}.${ext}` : cleaned
}

/** Fájl-e a válasz; ha igen, a név és a típus. Szöveges/JSON válasz (`attachment` nélkül) nem fájl. */
export function detectHttpApiFile(headers: Headers): { fileName: string; mimeType: string; format: string } | null {
  const declaredMimeType = baseMime(headers.get('content-type'))
  const disposition = headers.get('content-disposition')
  const attachment = disposition ? /^\s*attachment\b/i.test(disposition) : false
  if (!attachment && !FILE_MIME_PATTERNS.some((p) => p.test(declaredMimeType))) return null
  const mimeType = declaredMimeType || 'application/octet-stream'
  const fileName = safeFileName(contentDispositionFileName(disposition), mimeType)
  const format = fileName.match(/\.([a-z0-9]{1,8})$/i)?.[1].toLowerCase() ?? 'bin'
  return { fileName, mimeType, format }
}

/** A törzs bájtjai legfeljebb `maxBytes`-ig; nagyobb fájlnál `null` (a maradékot nem töltjük le). */
export async function readBodyBytes(res: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
