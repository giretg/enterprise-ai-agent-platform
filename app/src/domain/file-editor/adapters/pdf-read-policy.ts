/**
 * Nagy PDF-ek tool-loop védelme: egy pdf_read hívás ne tudja bedobni a teljes
 * dokumentumot a modell-kontextusba (lásd tulajdoni-lap postmortem: 237 oldal /
 * ~479k karakter → wallclock + token explosion).
 */

/** Oldalszám, ami felett kötelező a page_range (különben csak a prefix jön). */
export const PDF_READ_UNRANGED_PAGE_CAP = 12

/** Egyetlen pdf_read hívásban maximálisan visszaadható oldalak száma. */
export const PDF_READ_MAX_PAGES_PER_CALL = 25

export type PdfReadWindow = {
  start: number
  end: number
  /** true, ha a kért / implicit tartományt levágtuk. */
  truncated: boolean
  /** Agentnek szóló útmutató — null, ha nem történt vágás. */
  notice: string | null
}

function parsePageRange(pageRange: string, totalPages: number): { start: number; end: number } {
  const [startStr, endStr] = pageRange.split('-')
  const start = Math.max(1, parseInt(startStr ?? '1', 10) || 1)
  const endRaw = endStr ? parseInt(endStr, 10) : start
  const end = Number.isFinite(endRaw) ? endRaw : start
  return {
    start: Math.min(start, totalPages),
    end: Math.min(Math.max(end, start), totalPages),
  }
}

/**
 * Eldönti, melyik oldaltartományt olvassuk ténylegesen.
 * - page_range nélkül: max {@link PDF_READ_UNRANGED_PAGE_CAP} oldal (prefix)
 * - page_range-dzsel: max {@link PDF_READ_MAX_PAGES_PER_CALL} oldal / hívás
 */
export function resolvePdfReadWindow(input: {
  numPages: number
  pageRange?: string | null
}): PdfReadWindow {
  const numPages = Math.max(0, Math.floor(input.numPages))
  if (numPages <= 0) {
    return { start: 1, end: 0, truncated: false, notice: null }
  }

  if (!input.pageRange?.trim()) {
    if (numPages <= PDF_READ_UNRANGED_PAGE_CAP) {
      return { start: 1, end: numPages, truncated: false, notice: null }
    }
    const end = PDF_READ_UNRANGED_PAGE_CAP
    return {
      start: 1,
      end,
      truncated: true,
      notice:
        `A PDF ${numPages} oldalas — page_range nélkül csak az 1-${end}. oldalt adom vissza. ` +
        `Célzott szeleteket kérj page_range-dzsel (pl. "13-37", max ${PDF_READ_MAX_PAGES_PER_CALL} oldal / hívás). ` +
        `Ne olvasd be egyszerre a teljes dokumentumot.`,
    }
  }

  const requested = parsePageRange(input.pageRange.trim(), numPages)
  const span = requested.end - requested.start + 1
  if (span <= PDF_READ_MAX_PAGES_PER_CALL) {
    return {
      start: requested.start,
      end: requested.end,
      truncated: false,
      notice: null,
    }
  }

  const end = requested.start + PDF_READ_MAX_PAGES_PER_CALL - 1
  return {
    start: requested.start,
    end,
    truncated: true,
    notice:
      `A kért tartomány (${requested.start}-${requested.end}) túl nagy: egy hívásban max ` +
      `${PDF_READ_MAX_PAGES_PER_CALL} oldal. Most ${requested.start}-${end} jön vissza — ` +
      `a folytatáshoz újabb pdf_read a következő szelettel.`,
  }
}
