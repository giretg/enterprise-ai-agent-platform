import { fetchWebPage, type HttpGet } from '@/domain/web-fetch/fetch-page'
import {
  toReadableContent,
  type PdfReader,
  type ReadableContent,
  type WebFetchTarget,
} from '@/domain/web-fetch/web-fetch'
import { loadPdfParse } from '@/lib/pdf-parse'

export type WebFetchPage = ReadableContent & { finalUrl: string; host: string; bytes: number; redirects: number }

const readPdf: PdfReader = async (bytes) => {
  const PDFParse = await loadPdfParse()
  const parser = new PDFParse({ data: bytes })
  try {
    const { pages } = await parser.getText({ pageJoiner: '' })
    return { pages: pages.map((page) => page.text) }
  } finally {
    await parser.destroy()
  }
}

/** #1021: letöltés (SSRF-őr, átirányításonként a hívó szabálya) → olvasható szöveg (HTML, PDF, szöveg). */
export async function executeWebFetch(
  target: WebFetchTarget,
  checkRedirect: (target: WebFetchTarget) => string | null,
  opts: { httpGet?: HttpGet; readPdf?: PdfReader } = {},
): Promise<WebFetchPage> {
  const page = await fetchWebPage(target, { checkRedirect, httpGet: opts.httpGet })
  const content = await toReadableContent({
    bytes: page.bytes,
    contentType: page.contentType,
    url: page.finalUrl,
    readPdf: opts.readPdf ?? readPdf,
  })
  return { ...content, finalUrl: page.finalUrl, host: page.host, bytes: page.bytes.length, redirects: page.redirects }
}
