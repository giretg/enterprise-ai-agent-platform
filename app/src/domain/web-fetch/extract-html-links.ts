/**
 * Hop-jelölt kinyerés a nyers HTML-ből, sanitizálás ELŐTT. A nyers HTML nem
 * hagyja el a fetch-service-t — csak sapkázott `{ url, text }` lista.
 *
 * Csak `href` attribútum (a[href] és link[href]), relatív feloldás a szülőre,
 * fragment levágva. `javascript:` / `data:` / `mailto:` és nem-HTTPS kiesik.
 */
import { normalizeFetchUrl } from './normalize-fetch-url'

export type ExtractedHtmlLink = { url: string; text: string }

export const WEB_FETCH_MAX_EXTRACTED_LINKS = 200

const OPEN_TAG_RE = /<(a|link)\b([^>]*)>/gi
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i

function decodeHref(raw: string): string {
  return raw
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim()
}

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function isPdfPath(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf')
  } catch {
    return false
  }
}

function isBlockedScheme(href: string): boolean {
  return /^(javascript|data|mailto|file|ftp|blob):/i.test(href.trim())
}

export function extractHtmlPdfLinks(html: string, parentUrl: string): ExtractedHtmlLink[] {
  const out: ExtractedHtmlLink[] = []
  const seen = new Set<string>()
  OPEN_TAG_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = OPEN_TAG_RE.exec(html)) && out.length < WEB_FETCH_MAX_EXTRACTED_LINKS) {
    const tag = match[1]!.toLowerCase()
    const attrs = match[2] ?? ''
    const hrefMatch = HREF_RE.exec(attrs)
    const href = decodeHref(hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? '')
    if (!href || isBlockedScheme(href)) continue
    let resolved: URL
    try {
      resolved = new URL(href, parentUrl)
    } catch {
      continue
    }
    if (resolved.protocol !== 'https:') continue
    const normalized = normalizeFetchUrl(resolved.toString())
    if (!normalized || !isPdfPath(normalized) || seen.has(normalized)) continue
    seen.add(normalized)
    let text = ''
    if (tag === 'a') {
      const close = html.toLowerCase().indexOf('</a>', match.index + match[0].length)
      if (close !== -1) text = visibleText(html.slice(match.index + match[0].length, close))
    }
    out.push({ url: normalized, text })
  }
  return out
}
