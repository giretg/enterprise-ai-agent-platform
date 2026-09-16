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
 * A védekezés négy rétege (mind KÖTELEZŐ, egyik sem opcionális):
 *   1. bájt-limitek (archívum, fájlonkénti és összesített kicsomagolt méret) —
 *      zip-bomba ellen; a deklarált méretet ÉS a tényleges kimenetet is nézzük,
 *      mert a fejléc hazudhat;
 *   2. útvonal-normalizálás — `..`, abszolút út és backslash-elválasztó
 *      elutasítva (zip-slip);
 *   3. bejegyzés-darabszám cap — a central directory végigolvasása is munka;
 *   4. tömörített `[dataStart, dataEnd)` tartományok diszjunktsága — ugyanaz a
 *      deflate-blokk nem futhat le kétszer (átfedő central-directory hivatkozás).
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

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  return crc >>> 0
})

export function zipCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

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

function insertNonOverlappingRange(ranges: Array<{ start: number; end: number }>, start: number, end: number): boolean {
  // ponytail: 4 000 bejegyzésnél a lineáris scan elfogadható; nagyobb limithez intervallumfa kell.
  if (ranges.some((range) => range.start < end && start < range.end)) return false
  ranges.push({ start, end })
  return true
}

/**
 * Az archívum összes támogatott bejegyzésének kiolvasása. A könyvtár-bejegyzések
 * (`/`-re végződő nevek) kimaradnak — minket csak a fájlok érdekelnek.
 */
export function readZipEntries(
  archive: Uint8Array,
  limits: ZipReadLimits = DEFAULT_ZIP_LIMITS,
): ZipEntry[] {
  return readZipEntriesInternal(archive, limits, true, false)
}

/**
 * ZIP-archívum ellenőrzése a bejegyzések memóriában tartása nélkül.
 *
 * Az Office-feldolgozók saját ZIP-olvasót használnak; előttük ezzel ugyanazt a
 * deklarált és tényleges kicsomagolt méretkorlátot érvényesítjük, mint a
 * skill-importnál, de nem duplázzuk meg az egész archívum memóriaigényét.
 */
export function assertZipEntriesWithinLimits(
  archive: Uint8Array,
  limits: ZipReadLimits,
): void {
  readZipEntriesInternal(archive, limits, false, true)
}

function readZipEntriesInternal(
  archive: Uint8Array,
  limits: ZipReadLimits,
  collectEntries: boolean,
  rejectInvalidPaths: boolean,
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
  let declaredTotalUncompressed = 0
  const compressedRanges: Array<{ start: number; end: number }> = []
  let cursor = centralOffset
  // A központi könyvtárat a DEKLARÁLT MÉRET szerint járjuk végig — NEM az EOCD
  // entryCount mezője szerint. Az EOCD alábecsülhető (JSZip/ExcelJS/Mammoth a
  // teljes CD-t látja), és akkor a régi ciklus átugrotta a rejtett zip-bomba
  // bejegyzéseket. A méret-határ + entryCount egyezés együtt zárja a rést.
  const centralEnd = centralOffset + centralSize
  let recordsSeen = 0

  while (cursor < centralEnd) {
    if (cursor + 46 > centralEnd) throw new ZipReadError('Sérült központi könyvtár.', 'corrupt')
    if (buf.readUInt32LE(cursor) !== CENTRAL_FILE_SIGNATURE) {
      throw new ZipReadError('Sérült központi könyvtár (rossz aláírás).', 'corrupt')
    }

    recordsSeen += 1
    if (recordsSeen > limits.maxEntries) {
      throw new ZipReadError(
        `Túl sok bejegyzés a csomagban (${recordsSeen} > ${limits.maxEntries}).`,
        'too_many_entries',
      )
    }

    const flags = buf.readUInt16LE(cursor + 8)
    const method = buf.readUInt16LE(cursor + 10)
    const crc = buf.readUInt32LE(cursor + 16)
    const compressedSize = buf.readUInt32LE(cursor + 20)
    const uncompressedSize = buf.readUInt32LE(cursor + 24)
    const nameLength = buf.readUInt16LE(cursor + 28)
    const extraLength = buf.readUInt16LE(cursor + 30)
    const commentLength = buf.readUInt16LE(cursor + 32)
    const localOffset = buf.readUInt32LE(cursor + 42)
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength
    if (recordEnd > centralEnd) throw new ZipReadError('Sérült központi könyvtár.', 'corrupt')
    const rawName = buf.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor = recordEnd

    const path = normalizeZipPath(rawName)
    if (path === null) {
      if (rejectInvalidPaths) throw new ZipReadError('Sérült ZIP (érvénytelen bejegyzésnév).', 'corrupt')
      continue // zip-slip vagy értelmezhetetlen név → skill-importban kihagyjuk
    }
    if (rawName.endsWith('/')) continue // könyvtár-bejegyzés

    // A DEKLARÁLT méret gyors kapuja — a valódi ellenőrzés a kicsomagolás után jön.
    if (uncompressedSize > limits.maxFileBytes) {
      throw new ZipReadError(
        `Túl nagy fájl a csomagban: ${path} (${uncompressedSize} bájt).`,
        'file_too_large',
      )
    }
    declaredTotalUncompressed += uncompressedSize
    if (declaredTotalUncompressed > limits.maxTotalBytes) {
      throw new ZipReadError(
        `A csomag deklarált kicsomagolt mérete túllépi a keretet (${limits.maxTotalBytes} bájt).`,
        'archive_too_large',
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
    const localFlags = buf.readUInt16LE(localOffset + 6)
    const localMethod = buf.readUInt16LE(localOffset + 8)
    const localCrc = buf.readUInt32LE(localOffset + 14)
    const localCompressedSize = buf.readUInt32LE(localOffset + 18)
    const localUncompressedSize = buf.readUInt32LE(localOffset + 22)
    const localNameLength = buf.readUInt16LE(localOffset + 26)
    const localExtraLength = buf.readUInt16LE(localOffset + 28)
    const localRawName = buf.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength)
    if (localFlags !== flags || localMethod !== method || localRawName !== rawName) {
      throw new ZipReadError('Sérült ZIP (eltérő lokális fejléc).', 'corrupt')
    }
    // Data descriptornál (bit 3) a lokális méretek/CRC szándékosan nullák lehetnek.
    if (
      (flags & 0x08) === 0 &&
      (localCrc !== crc || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize)
    ) {
      throw new ZipReadError('Sérült ZIP (eltérő lokális méretek).', 'corrupt')
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buf.length) throw new ZipReadError('Sérült ZIP (csonka adat).', 'corrupt')
    if (!insertNonOverlappingRange(compressedRanges, dataStart, dataEnd)) {
      throw new ZipReadError('Sérült ZIP (átfedő tömörített fájladat).', 'corrupt')
    }

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
    if (bytes.byteLength !== uncompressedSize || zipCrc32(bytes) !== crc) {
      throw new ZipReadError(`Sérült ZIP (hibás kicsomagolt adat): ${path}`, 'corrupt')
    }
    totalUncompressed += bytes.byteLength
    if (totalUncompressed > limits.maxTotalBytes) {
      throw new ZipReadError(
        `A csomag kicsomagolt mérete túllépi a keretet (${limits.maxTotalBytes} bájt).`,
        'archive_too_large',
      )
    }

    if (collectEntries) entries.push({ path, bytes: new Uint8Array(bytes) })
  }

  if (cursor !== centralEnd) {
    throw new ZipReadError('Sérült ZIP (a központi könyvtár mérete nem egyezik).', 'corrupt')
  }
  if (recordsSeen !== entryCount) {
    throw new ZipReadError(
      'Sérült ZIP (az EOCD bejegyzésszáma nem egyezik a központi könyvtárral).',
      'corrupt',
    )
  }

  return entries
}
