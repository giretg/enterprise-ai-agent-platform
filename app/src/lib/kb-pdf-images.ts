import { loadPdfParse } from './pdf-parse'

export const KB_PDF_MAX_PAGES = 5
export const KB_PDF_MAX_IMAGE_BYTES = 5 * 1024 * 1024

export class PdfPageImageError extends Error {
  constructor(public code: string, message: string) {
    super(message)
  }
}

export function parsePdfPages(selection?: string): number[] {
  if (selection === undefined) return [1]
  if (!selection.trim() || selection.length > 100) throw new PdfPageImageError('invalid_pages', 'Use pages:"1-3,7" with positive page numbers.')
  const pages = new Set<number>()
  for (const part of selection.split(',')) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim())
    if (!match) throw new PdfPageImageError('invalid_pages', 'Use pages:"1-3,7".')
    const start = Number(match[1])
    const end = Number(match[2] ?? match[1])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
      throw new PdfPageImageError('invalid_pages', 'Page numbers must be positive, ascending integers.')
    }
    if (end - start >= KB_PDF_MAX_PAGES) throw new PdfPageImageError('too_many_pages', 'Request at most 5 pages per call; continue with the next range.')
    for (let page = start; page <= end; page++) {
      pages.add(page)
      if (pages.size > KB_PDF_MAX_PAGES) throw new PdfPageImageError('too_many_pages', 'Request at most 5 pages per call; continue with the next range.')
    }
  }
  return [...pages].sort((a, b) => a - b)
}

/** Local PDF.js canvas rendering only. Bounds are checked before allocating a canvas. */
export async function renderPdfPages(buffer: Buffer, selection?: string) {
  const pages = parsePdfPages(selection)
  const PDFParse = await loadPdfParse()
  const parser = new PDFParse({ data: buffer })
  try {
    const info = await parser.getInfo({ parsePageInfo: true, partial: pages })
    if (pages.some((page) => page > info.total)) {
      throw new PdfPageImageError('invalid_pages', `Document has ${info.total} pages. Request existing pages only.`)
    }
    const images: Array<{ page: number; data: string; mimeType: 'image/png'; width: number; height: number }> = []
    let bytes = 0
    for (const page of info.pages) {
      const longest = Math.max(page.width, page.height)
      if (!Number.isFinite(longest) || longest <= 0 || Math.min(page.width, page.height) <= 0) {
        throw new PdfPageImageError('invalid_pdf_page', 'Invalid PDF page dimensions.')
      }
      const screenshot = await parser.getScreenshot({
        partial: [page.pageNumber],
        scale: Math.min(150 / 72, 1600 / longest),
        imageBuffer: true,
        imageDataUrl: false,
      })
      const image = screenshot.pages[0]
      bytes += image.data.byteLength
      if (!image.data.byteLength || bytes > KB_PDF_MAX_IMAGE_BYTES) {
        throw new PdfPageImageError('page_images_too_large', 'Request fewer pages per call (PNG limit: 5 MiB).')
      }
      images.push({ page: image.pageNumber, data: Buffer.from(image.data).toString('base64'), mimeType: 'image/png', width: image.width, height: image.height })
    }
    return { images, totalPages: info.total }
  } finally {
    await parser.destroy()
  }
}
