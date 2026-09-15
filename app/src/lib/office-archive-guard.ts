import { assertZipEntriesWithinLimits } from './skill/zip-reader'

// A 25/50 MB-os feltöltési plafon mellett ez még életszerű Office-dokumentumokat
// enged, de a tömörítetlen XML-/média-adat nem nőhet korlátlanra a közös processzben.
export const OFFICE_ARCHIVE_ZIP_LIMITS = {
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntries: 2_000,
} as const

export class OfficeArchiveError extends Error {
  constructor() {
    super('A DOCX/XLSX fájl tömörítetlen tartalma túl nagy vagy sérült')
    this.name = 'OfficeArchiveError'
  }
}

/** Az Office ZIP-et a tényleges parser előtt, deklarált és valós méretekkel ellenőrzi. */
export function assertSafeOfficeArchive(buffer: Buffer): void {
  try {
    assertZipEntriesWithinLimits(buffer, OFFICE_ARCHIVE_ZIP_LIMITS)
  } catch {
    throw new OfficeArchiveError()
  }
}
