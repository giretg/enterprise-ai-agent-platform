import { FileEditorError } from '../workspace-storage'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function importPdfParse(): Promise<any> {
  try {
    return await import('pdf-parse')
  } catch {
    throw new FileEditorError(
      'BINARY_ADAPTER_UNAVAILABLE',
      'pdf-parse is not installed. Run: npm install pdf-parse',
    )
  }
}

function parsePageRange(pageRange?: string, totalPages?: number): { start: number; end: number } {
  if (!pageRange) return { start: 1, end: totalPages ?? Infinity }
  const [startStr, endStr] = pageRange.split('-')
  const start = Math.max(1, parseInt(startStr ?? '1', 10))
  const end = endStr ? parseInt(endStr, 10) : start
  return { start, end: Math.min(end, totalPages ?? end) }
}

export async function pdfRead(
  buffer: Buffer,
  pageRange?: string,
): Promise<{ text: string; numPages: number; pagesRead: string }> {
  const pdfParse = await importPdfParse()

  let currentPage = 0
  const range = parsePageRange(pageRange)

  const options = {
    pagerender: (pageData: { getTextContent: () => Promise<{ items: Array<{ str: string }> }> }) => {
      currentPage++
      if (currentPage < range.start || currentPage > range.end) return Promise.resolve('')
      return pageData.getTextContent().then((content: { items: Array<{ str: string }> }) =>
        content.items.map((item) => item.str).join(' '),
      )
    },
  }

  const result = await pdfParse.default(buffer, options)
  const numPages = result.numpages as number
  const actualEnd = Math.min(range.end, numPages)

  return {
    text: (result.text as string).trim(),
    numPages,
    pagesRead: range.end === Infinity ? `1-${numPages}` : `${range.start}-${actualEnd}`,
  }
}
