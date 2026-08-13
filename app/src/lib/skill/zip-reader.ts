import { inflateRawSync } from 'node:zlib'

/**
 * Minimál, függőség-mentes ZIP-olvasó a skill-csomag importhoz.
 *
 * Miért saját parser: ugyanaz az indok, mint a `skill-md-adapter` lapos
 * YAML-parserénél — az import egy TÁMADÓ-KONTROLLÁLT bájtfolyamot dolgoz fel, és
 * itt a determinisztikus, auditálható, szűk viselkedés többet ér, mint a teljes
 * formátum-lefedettség. Csak azt támogatjuk, amit a valódi skill-csomagok
 * használnak: `stored` (0) és `deflate` (8) tömörítés, sima könyvtárfa.
 *
 * A védekezés három rétege (mind KÖTELEZŐ, egyik sem opcionális):
 *   1. bájt-limitek (archívum, fájlonkénti és összesített kicsomagolt méret) —
 *      zip-bomba ellen; a deklarált méretet ÉS a tényleges kimenetet is nézzük,
 *      mert a fejléc hazudhat;
 *   2. útvonal-normalizálás — `..`, abszolút út és backslash-elválasztó
 *      elutasítva (zip-slip);
 *   3. bejegyzés-darabszám cap — a central directory végigolvasása is munka.
 */

export interface ZipEntry {
  /** Normalizált, `/`-elválasztású útvonal az archívumon belül. */
  path: string
  bytes: Uint8Array
}

export interface ZipReadLimits {
  /** Egy kicsomagolt fájl maximális mérete. */
  maxFileBytes: number
  /** Az összes kicsomagolt fájl együttes maximális mérete. */
  maxTotalBytes: number
  /** A central directoryban feldolgozott bejegyzések maximális száma. */
  maxEntries: number
}

export const DEFAULT_ZIP_LIMITS: ZipReadLimits = {
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxEntries: 4_000,
}

export class ZipReadError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not_a_zip'
      | 'unsupported'
      | 'too_many_entries'
      | 'file_too_large'
      | 'archive_too_large'
      | 'corrupt',
  ) {
    super(message)
    this.name = 'ZipReadError'
  }
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_FILE_SIGNATURE = 0x02014b50
const LOCAL_FILE_SIGNATURE = 0x04034b50
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50

/**
 * Az útvonal biztonságos alakja: `/`-elválasztás, nincs abszolút gyökér, nincs
 * `..` szegmens, nincs vezérlőkarakter. A visszatérés `null`, ha a bejegyzést el
 * kell dobni (a hívó ilyenkor kihagyja — nem hibázunk el egy egész csomagot egy
 * furcsa metaadat-bejegyzés miatt).
 */
export function normalizeZipPath(raw: string): string | null {
  if (raw.includes('\\')) return null
  if (raw.startsWith('/')) return null
  if (/^[a-zA-Z]:/.test(raw)) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(raw)) return null

  const segments = raw.split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    out.push(segment)
  }
  if (out.length === 0) return null
  return out.join('/')
}

function findEocdOffset(buf: Buffer): number {
  // Az EOCD a fájl végén van; a komment miatt maximum 64 KB-ot kell visszafelé nézni.
  const minOffset = Math.max(0, buf.length - (0xffff + 22))
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i
  }
  return -1
}

/**
 * Az archívum összes támogatott bejegyzésének kiolvasása. A könyvtár-bejegyzések
 * (`/`-re végződő nevek) kimaradnak — minket csak a fájlok érdekelnek.
 */
export function readZipEntries(
  archive: Uint8Array,
  limits: ZipReadLimits = DEFAULT_ZIP_LIMITS,
): ZipEntry[] {
  const buf = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  if (buf.length < 22) throw new ZipReadError('A fájl túl rövid ahhoz, hogy ZIP legyen.', 'not_a_zip')

  const eocd = findEocdOffset(buf)
  if (eocd < 0) throw new ZipReadError('Nem ZIP-fájl (hiányzik a záró rekord).', 'not_a_zip')

  // Zip64: a 4 GB / 65535 bejegyzés fölötti archívumot nem támogatjuk. Ekkora
  // csomag amúgy is jóval a limitjeink fölött van, tehát a korrekt válasz az
  // elutasítás, nem a részleges feldolgozás.
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR_SIGNATURE) {
    throw new ZipReadError('Zip64 archívum — túl nagy csomag.', 'unsupported')
  }

  const entryCount = buf.readUInt16LE(eocd + 10)
  const centralSize = buf.readUInt32LE(eocd + 12)
  const centralOffset = buf.readUInt32LE(eocd + 16)
  if (centralOffset + centralSize > buf.length) {
    throw new ZipReadError('Sérült ZIP (a központi könyvtár a fájlon kívülre mutat).', 'corrupt')
  }
  if (entryCount > limits.maxEntries) {
    throw new ZipReadError(
      `Túl sok bejegyzés a csomagban (${entryCount} > ${limits.maxEntries}).`,
      'too_many_entries',
    )
  }

  const entries: ZipEntry[] = []
  let totalUncompressed = 0
  let cursor = centralOffset

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > buf.length) throw new ZipReadError('Sérült központi könyvtár.', 'corrupt')
    if (buf.readUInt32LE(cursor) !== CENTRAL_FILE_SIGNATURE) {
      throw new ZipReadError('Sérült központi könyvtár (rossz aláírás).', 'corrupt')
    }

    const method = buf.readUInt16LE(cursor + 10)
    const compressedSize = buf.readUInt32LE(cursor + 20)
    const uncompressedSize = buf.readUInt32LE(cursor + 24)
    const nameLength = buf.readUInt16LE(cursor + 28)
    const extraLength = buf.readUInt16LE(cursor + 30)
    const commentLength = buf.readUInt16LE(cursor + 32)
    const localOffset = buf.readUInt32LE(cursor + 42)
    const rawName = buf.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength

    if (rawName.endsWith('/')) continue // könyvtár-bejegyzés
    const path = normalizeZipPath(rawName)
    if (path === null) continue // zip-slip vagy értelmezhetetlen név → kihagyjuk

    // A DEKLARÁLT méret gyors kapuja — a valódi ellenőrzés a kicsomagolás után jön.
    if (uncompressedSize > limits.maxFileBytes) {
      throw new ZipReadError(
        `Túl nagy fájl a csomagban: ${path} (${uncompressedSize} bájt).`,
        'file_too_large',
      )
    }
    if (method !== 0 && method !== 8) {
      throw new ZipReadError(
        `Nem támogatott tömörítés a csomagban: ${path} (method ${method}).`,
        'unsupported',
      )
    }

    // Lokális fejléc: a név/extra hossza itt eltérhet a központitól, ezért innen olvassuk.
    if (localOffset + 30 > buf.length) throw new ZipReadError('Sérült lokális fejléc.', 'corrupt')
    if (buf.readUInt32LE(localOffset) !== LOCAL_FILE_SIGNATURE) {
      throw new ZipReadError('Sérült lokális fejléc (rossz aláírás).', 'corrupt')
    }
    const localNameLength = buf.readUInt16LE(localOffset + 26)
    const localExtraLength = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buf.length) throw new ZipReadError('Sérült ZIP (csonka adat).', 'corrupt')

    const compressed = buf.subarray(dataStart, dataEnd)
    let bytes: Buffer
    if (method === 0) {
      bytes = Buffer.from(compressed)
    } else {
      try {
        // A `maxOutputLength` a zlib szintjén állítja meg a zip-bombát — nem
        // arra hagyatkozunk, hogy a fejlécben deklarált méret igazat mond.
        bytes = inflateRawSync(compressed, { maxOutputLength: limits.maxFileBytes + 1 })
      } catch {
        throw new ZipReadError(`Kicsomagolási hiba: ${path}`, 'corrupt')
      }
    }

    if (bytes.byteLength > limits.maxFileBytes) {
      throw new ZipReadError(
        `Túl nagy fájl a csomagban: ${path} (${bytes.byteLength} bájt).`,
        'file_too_large',
      )
    }
    totalUncompressed += bytes.byteLength
    if (totalUncompressed > limits.maxTotalBytes) {
      throw new ZipReadError(
        `A csomag kicsomagolt mérete túllépi a keretet (${limits.maxTotalBytes} bájt).`,
        'archive_too_large',
      )
    }

    entries.push({ path, bytes: new Uint8Array(bytes) })
  }

  return entries
}
