/**
 * Markdown-kontextus a megjelenítési feloldáshoz (APG-07, spec §10.3).
 *
 * Ugyanaz a GFM-parser, amit a ChatMarkdown használ: az álnév csak akkor
 * oldható fel, ha egy szöveg-node-ban van. Link/kép cél, HTML, kód — nem.
 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

export type TextRange = { start: number; end: number }

type Point = { offset?: number }
type MdNode = {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
  position?: { start: Point; end: Point }
}

/** Forrástartományok, ahol a feloldás megengedett (szöveg-node, nem URL-visszhang). */
export function resolvableTextRanges(markdown: string): TextRange[] {
  if (!markdown) return []
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as MdNode
  const ranges: TextRange[] = []
  walk(tree, null, (node, parent) => {
    if (node.type !== 'text') return
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start == null || end == null || start >= end) return
    if (parent && isAutolinkEcho(node, parent)) return
    ranges.push({ start, end })
  })
  return ranges
}

function isAutolinkEcho(node: MdNode, parent: MdNode): boolean {
  if (parent.type !== 'link' && parent.type !== 'image') return false
  const url = parent.url ?? ''
  const value = node.value ?? ''
  if (!url || !value) return false
  if (value === url) return true
  // GFM literal autolink a `[` karakternél megszakad; a látható szöveg a cél prefixe.
  return looksLikeAbsoluteUrl(value) && (url.startsWith(value) || value.startsWith(url))
}

function looksLikeAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('www.')
}

function walk(
  node: MdNode,
  parent: MdNode | null,
  visit: (node: MdNode, parent: MdNode | null) => void,
): void {
  visit(node, parent)
  for (const child of node.children ?? []) walk(child, node, visit)
}
