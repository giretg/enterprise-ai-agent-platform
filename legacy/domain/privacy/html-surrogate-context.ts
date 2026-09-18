/**
 * HTML-kontextus a megjelenítési feloldáshoz (APG-07 §10.3 kiterjesztése
 * mini-app / workspace HTML egressre).
 *
 * Az álnév csak HTML szöveg-node-ban oldható fel. Attribútumokban, scriptben,
 * style-ban és kommentben marad — különben URL/beacon exfiltráció lenne.
 */
import type { TextRange } from '@/domain/privacy/markdown-surrogate-context'

const SKIP_ELEMENT = /^(script|style|textarea)$/i

/** Forrástartományok, ahol a feloldás megengedett (látható szöveg-node). */
export function resolvableHtmlTextRanges(html: string): TextRange[] {
  if (!html) return []
  const ranges: TextRange[] = []
  let i = 0
  const n = html.length

  while (i < n) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4)
      i = end < 0 ? n : end + 3
      continue
    }

    if (html[i] === '<') {
      const tagEnd = findTagEnd(html, i)
      if (tagEnd < 0) break
      const openTag = html.slice(i, tagEnd + 1)
      const skipName = skipElementName(openTag)
      if (skipName) {
        const close = findClosingTag(html, tagEnd + 1, skipName)
        i = close < 0 ? n : close
        continue
      }
      i = tagEnd + 1
      continue
    }

    const start = i
    while (i < n && html[i] !== '<') i += 1
    if (i > start) ranges.push({ start, end: i })
  }

  return ranges
}

function skipElementName(openTag: string): string | null {
  const match = /^<\s*([a-z][\w:-]*)/i.exec(openTag)
  if (!match) return null
  const name = match[1]!
  if (!SKIP_ELEMENT.test(name)) return null
  if (/\/>\s*$/.test(openTag)) return null
  return name.toLowerCase()
}

function findTagEnd(html: string, start: number): number {
  let i = start + 1
  let quote: '"' | "'" | null = null
  while (i < html.length) {
    const ch = html[i]!
    if (quote) {
      if (ch === quote) quote = null
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      i += 1
      continue
    }
    if (ch === '>') return i
    i += 1
  }
  return -1
}

function findClosingTag(html: string, from: number, name: string): number {
  const close = new RegExp(`</\\s*${name}\\s*>`, 'i')
  close.lastIndex = from
  const match = close.exec(html)
  return match ? match.index + match[0].length : -1
}
