/**
 * #1024: Markdown → egyszerű blokk-modell, amiből a DOCX és a PDF egyformán készül
 * (címsor, bekezdés, lista, táblázat, idézet, kódblokk, elválasztó).
 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

export type Run = { text: string; bold?: boolean; italic?: boolean; code?: boolean; link?: string }

export type Block =
  | { kind: 'heading'; level: number; runs: Run[] }
  | { kind: 'paragraph'; runs: Run[]; quote?: boolean }
  | { kind: 'list_item'; ordered: boolean; number: number; depth: number; runs: Run[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; header: Run[][]; rows: Run[][][] }
  | { kind: 'rule' }

type MdNode = {
  type: string
  value?: string
  depth?: number
  ordered?: boolean | null
  start?: number | null
  url?: string
  children?: MdNode[]
}

function inlineRuns(nodes: MdNode[] | undefined, style: Omit<Run, 'text'> = {}): Run[] {
  const runs: Run[] = []
  for (const node of nodes ?? []) {
    switch (node.type) {
      case 'text':
        runs.push({ ...style, text: node.value ?? '' })
        break
      case 'inlineCode':
        runs.push({ ...style, code: true, text: node.value ?? '' })
        break
      case 'strong':
        runs.push(...inlineRuns(node.children, { ...style, bold: true }))
        break
      case 'emphasis':
        runs.push(...inlineRuns(node.children, { ...style, italic: true }))
        break
      case 'delete':
        runs.push(...inlineRuns(node.children, style))
        break
      case 'link':
        runs.push(...inlineRuns(node.children, { ...style, link: node.url }))
        break
      case 'break':
        runs.push({ ...style, text: '\n' })
        break
      case 'image':
        // Képet nem ágyazunk be (nem érünk el külső címet); a helye szövegként marad.
        break
      default:
        if (node.children) runs.push(...inlineRuns(node.children, style))
        else if (node.value) runs.push({ ...style, text: node.value })
    }
  }
  return runs
}

function collect(nodes: MdNode[] | undefined, out: Block[], ctx: { depth: number; quote: boolean }) {
  for (const node of nodes ?? []) {
    switch (node.type) {
      case 'heading':
        out.push({ kind: 'heading', level: Math.min(Math.max(node.depth ?? 1, 1), 6), runs: inlineRuns(node.children) })
        break
      case 'paragraph':
        out.push({ kind: 'paragraph', runs: inlineRuns(node.children), ...(ctx.quote ? { quote: true } : {}) })
        break
      case 'blockquote':
        collect(node.children, out, { ...ctx, quote: true })
        break
      case 'code':
        out.push({ kind: 'code', text: node.value ?? '' })
        break
      case 'thematicBreak':
        out.push({ kind: 'rule' })
        break
      case 'list': {
        let number = node.start ?? 1
        for (const item of node.children ?? []) {
          const [first, ...rest] = item.children ?? []
          const runs = first?.type === 'paragraph' ? inlineRuns(first.children) : []
          out.push({ kind: 'list_item', ordered: node.ordered === true, number: number++, depth: ctx.depth, runs })
          collect(first?.type === 'paragraph' ? rest : item.children, out, { ...ctx, depth: ctx.depth + 1 })
        }
        break
      }
      case 'table': {
        const [head, ...body] = (node.children ?? []).map((row) => (row.children ?? []).map((cell) => inlineRuns(cell.children)))
        out.push({ kind: 'table', header: head ?? [], rows: body })
        break
      }
      case 'html':
        if (node.value?.trim()) out.push({ kind: 'paragraph', runs: [{ text: node.value }] })
        break
      default:
        if (node.children) collect(node.children, out, ctx)
    }
  }
}

export function markdownBlocks(markdown: string): Block[] {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as MdNode
  const blocks: Block[] = []
  collect(tree.children, blocks, { depth: 0, quote: false })
  return blocks
}

export function plainText(runs: Run[]): string {
  return runs.map((r) => r.text).join('')
}
