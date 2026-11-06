/**
 * Markdown munkafájl letöltése emberi formában: önálló HTML és Word (.docx).
 * Szerver oldalon fut (letöltési action), a markdownt a repo meglévő
 * mdast-parserével olvassa. A nyers HTML nem kerül át, a külső kép nem töltődik
 * be (markdown-url-policy), a veszélyes linkek sima szöveggé válnak.
 */
import type { Blockquote, Code, List, ListItem, PhrasingContent, Root, RootContent, Table } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table as DocxTable,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from 'docx'
import { isSafeMarkdownImageSrc, isSafeMarkdownLinkHref } from '@/lib/markdown-url-policy'
import { splitFrontmatter } from '@/lib/work-file-list'

export type WorkFileExportFormat = 'md' | 'html' | 'docx'

export { isMarkdownFile as isMarkdownPath } from '@/lib/work-file-list'

export function parseMarkdown(source: string): Root {
  const { front, body } = splitFrontmatter(source)
  const tree = fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  // A YAML-fejléc kódblokként megmarad, nem lesz belőle vízszintes vonal és cím.
  if (front) tree.children.unshift({ type: 'code', lang: 'yaml', value: front })
  return tree
}

/** Fájlnév az útvonal utolsó eleméből, kiterjesztés nélkül. */
export function exportBaseName(path: string): string {
  const last = path.split('/').filter(Boolean).pop() ?? 'munkafajl'
  const bare = last.replace(/\.[A-Za-z0-9]{1,8}$/, '')
  return bare.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'munkafajl'
}

/** Az első 1. szintű fejléc, ez lesz a dokumentum címe; hiányában a fájlnév. */
export function documentTitle(tree: Root, path: string): string {
  for (const node of tree.children) {
    if (node.type === 'heading' && node.depth === 1) {
      const text = plainText(node.children).trim()
      if (text) return text
    }
  }
  return exportBaseName(path)
}

function plainText(nodes: readonly PhrasingContent[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'text' || node.type === 'inlineCode') return node.value
      if (node.type === 'break') return ' '
      if (node.type === 'image') return node.alt ?? ''
      if ('children' in node) return plainText(node.children as PhrasingContent[])
      return ''
    })
    .join('')
}

/* ───────────────────────────── HTML ───────────────────────────── */

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function htmlInline(nodes: readonly PhrasingContent[]): string {
  return nodes
    .map((node): string => {
      switch (node.type) {
        case 'text':
          return esc(node.value)
        case 'strong':
          return `<strong>${htmlInline(node.children)}</strong>`
        case 'emphasis':
          return `<em>${htmlInline(node.children)}</em>`
        case 'delete':
          return `<del>${htmlInline(node.children)}</del>`
        case 'inlineCode':
          return `<code>${esc(node.value)}</code>`
        case 'break':
          return '<br>'
        case 'link':
          return isSafeMarkdownLinkHref(node.url)
            ? `<a href="${esc(node.url)}">${htmlInline(node.children)}</a>`
            : htmlInline(node.children)
        case 'image':
          return isSafeMarkdownImageSrc(node.url)
            ? `<img src="${esc(node.url)}" alt="${esc(node.alt ?? '')}">`
            : esc(node.alt ? `[kép: ${node.alt}]` : '[kép]')
        case 'html':
          return esc(node.value)
        default:
          return ''
      }
    })
    .join('')
}

function htmlBlock(node: RootContent): string {
  switch (node.type) {
    case 'heading':
      return `<h${node.depth}>${htmlInline(node.children)}</h${node.depth}>`
    case 'paragraph':
      return `<p>${htmlInline(node.children)}</p>`
    case 'blockquote':
      return `<blockquote>${node.children.map(htmlBlock).join('')}</blockquote>`
    case 'code':
      return `<pre><code>${esc(node.value)}</code></pre>`
    case 'thematicBreak':
      return '<hr>'
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul'
      const start = node.ordered && node.start && node.start !== 1 ? ` start="${node.start}"` : ''
      return `<${tag}${start}>${node.children.map(htmlListItem).join('')}</${tag}>`
    }
    case 'table':
      return htmlTable(node)
    case 'html':
      return `<p>${esc(node.value)}</p>`
    default:
      return ''
  }
}

function htmlListItem(item: ListItem): string {
  const box = item.checked === true ? '☑ ' : item.checked === false ? '☐ ' : ''
  const body = item.children
    .map((child) =>
      child.type === 'paragraph' && !item.spread ? htmlInline(child.children) : htmlBlock(child),
    )
    .join('')
  return `<li>${box}${body}</li>`
}

function htmlTable(table: Table): string {
  const align = table.align ?? []
  const cell = (tag: 'th' | 'td', children: PhrasingContent[], index: number) => {
    const a = align[index]
    return `<${tag}${a ? ` style="text-align:${a}"` : ''}>${htmlInline(children)}</${tag}>`
  }
  const [head, ...body] = table.children
  const headHtml = head
    ? `<thead><tr>${head.children.map((c, i) => cell('th', c.children, i)).join('')}</tr></thead>`
    : ''
  const bodyHtml = body
    .map((row) => `<tr>${row.children.map((c, i) => cell('td', c.children, i)).join('')}</tr>`)
    .join('')
  return `<table>${headHtml}<tbody>${bodyHtml}</tbody></table>`
}

const HTML_STYLE = `
:root{color-scheme:light}
body{margin:0;background:#faf9f7;color:#1f2430;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:820px;margin:0 auto;padding:40px 24px 80px;background:#fff;min-height:100vh;box-sizing:border-box}
h1,h2,h3,h4{line-height:1.3;margin:1.6em 0 .5em}
h1{font-size:1.9rem;margin-top:0}h2{font-size:1.4rem}h3{font-size:1.15rem}h4{font-size:1rem}
a{color:#b4442f}
blockquote{margin:1em 0;padding:.1em 1em;border-left:3px solid #d9d4cc;color:#555}
code{background:#f1eee9;border-radius:4px;padding:.1em .35em;font:.9em ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:#f1eee9;border-radius:8px;padding:14px 16px;overflow:auto}pre code{background:none;padding:0}
table{border-collapse:collapse;margin:1em 0;width:100%}
th,td{border:1px solid #d9d4cc;padding:6px 10px;text-align:left;vertical-align:top}th{background:#f6f3ee}
hr{border:0;border-top:1px solid #e3ded6;margin:2em 0}img{max-width:100%}
.meta{color:#777;font-size:.85rem;margin:0 0 2em}
@media print{body{background:#fff}main{padding:0;max-width:none}}
`

export function markdownToHtmlDocument(
  source: string,
  opts: { path: string; updatedAt?: string | null },
): string {
  const tree = parseMarkdown(source)
  const title = documentTitle(tree, opts.path)
  const meta = [opts.path, opts.updatedAt ? `Módosítva: ${formatHuDate(opts.updatedAt)}` : null]
    .filter(Boolean)
    .join(' · ')
  return `<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${HTML_STYLE}</style>
</head>
<body>
<main>
<p class="meta">${esc(meta)}</p>
${tree.children.map(htmlBlock).join('\n')}
</main>
</body>
</html>
`
}

/** Nem markdown szöveg (csv, json, log…) olvasható HTML-ként: egyben, előformázva. */
export function plainTextToHtmlDocument(
  source: string,
  opts: { path: string; updatedAt?: string | null },
): string {
  const meta = [opts.path, opts.updatedAt ? `Módosítva: ${formatHuDate(opts.updatedAt)}` : null]
    .filter(Boolean)
    .join(' · ')
  return `<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(exportBaseName(opts.path))}</title>
<style>${HTML_STYLE}pre{white-space:pre-wrap;word-break:break-word}</style>
</head>
<body>
<main>
<p class="meta">${esc(meta)}</p>
<pre><code>${esc(source)}</code></pre>
</main>
</body>
</html>
`
}

export function formatHuDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat('hu-HU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Budapest' }).format(date)
}

/* ───────────────────────────── Word ───────────────────────────── */

type RunFormat = { bold?: boolean; italics?: boolean; strike?: boolean; code?: boolean }

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const

function run(text: string, fmt: RunFormat): TextRun {
  return new TextRun({
    text,
    bold: fmt.bold,
    italics: fmt.italics,
    strike: fmt.strike,
    ...(fmt.code ? { font: 'Courier New', shading: { type: ShadingType.CLEAR, fill: 'F1EEE9' } } : {}),
  })
}

function docxInline(nodes: readonly PhrasingContent[], fmt: RunFormat = {}): ParagraphChild[] {
  const out: ParagraphChild[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push(run(node.value, fmt))
        break
      case 'strong':
        out.push(...docxInline(node.children, { ...fmt, bold: true }))
        break
      case 'emphasis':
        out.push(...docxInline(node.children, { ...fmt, italics: true }))
        break
      case 'delete':
        out.push(...docxInline(node.children, { ...fmt, strike: true }))
        break
      case 'inlineCode':
        out.push(run(node.value, { ...fmt, code: true }))
        break
      case 'break':
        out.push(new TextRun({ break: 1 }))
        break
      case 'link':
        if (isSafeMarkdownLinkHref(node.url)) {
          out.push(
            new ExternalHyperlink({
              link: node.url,
              children: [new TextRun({ text: plainText(node.children) || node.url, style: 'Hyperlink', color: 'B4442F', underline: {} })],
            }),
          )
        } else {
          out.push(...docxInline(node.children, fmt))
        }
        break
      case 'image':
        out.push(run(node.alt ? `[kép: ${node.alt}]` : '[kép]', { ...fmt, italics: true }))
        break
      case 'html':
        out.push(run(node.value, fmt))
        break
      default:
        break
    }
  }
  return out
}

type DocxBlock = Paragraph | DocxTable

class DocxBuilder {
  private orderedInstance = 0

  blocks(nodes: readonly RootContent[], listLevel = 0, quote = false): DocxBlock[] {
    return nodes.flatMap((node) => this.block(node, listLevel, quote))
  }

  private quoteProps(quote: boolean) {
    return quote
      ? {
          indent: { left: 360 },
          border: { left: { style: BorderStyle.SINGLE, size: 12, space: 8, color: 'D9D4CC' } },
        }
      : {}
  }

  private block(node: RootContent, listLevel: number, quote: boolean): DocxBlock[] {
    switch (node.type) {
      case 'heading':
        return [
          new Paragraph({
            heading: HEADINGS[Math.min(node.depth, 6) - 1],
            spacing: { before: 240, after: 120 },
            children: docxInline(node.children),
          }),
        ]
      case 'paragraph':
        return [
          new Paragraph({
            spacing: { after: 120 },
            ...this.quoteProps(quote),
            children: docxInline(node.children),
          }),
        ]
      case 'blockquote':
        return this.blocks((node as Blockquote).children, listLevel, true)
      case 'code':
        return this.codeBlock(node as Code)
      case 'thematicBreak':
        return [
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 1, color: 'D9D4CC' } },
            spacing: { before: 120, after: 120 },
          }),
        ]
      case 'list':
        return this.list(node as List, listLevel, quote)
      case 'table':
        return [this.table(node as Table), new Paragraph({ spacing: { after: 120 } })]
      case 'html':
        return [new Paragraph({ children: [run(node.value, {})] })]
      default:
        return []
    }
  }

  private codeBlock(node: Code): DocxBlock[] {
    return node.value.split('\n').map(
      (line) =>
        new Paragraph({
          shading: { type: ShadingType.CLEAR, fill: 'F1EEE9' },
          spacing: { after: 0 },
          children: [new TextRun({ text: line, font: 'Courier New', size: 20 })],
        }),
    )
  }

  private list(list: List, level: number, quote: boolean): DocxBlock[] {
    const instance = list.ordered ? ++this.orderedInstance : 0
    const lvl = Math.min(level, 5)
    return list.children.flatMap((item: ListItem) => {
      const [first, ...rest] = item.children
      const box = item.checked === true ? '☑ ' : item.checked === false ? '☐ ' : ''
      const head =
        first?.type === 'paragraph'
          ? new Paragraph({
              ...(list.ordered
                ? { numbering: { reference: 'ol', level: lvl, instance } }
                : { bullet: { level: lvl } }),
              spacing: { after: 60 },
              children: [...(box ? [new TextRun({ text: box })] : []), ...docxInline(first.children)],
            })
          : new Paragraph({
              ...(list.ordered
                ? { numbering: { reference: 'ol', level: lvl, instance } }
                : { bullet: { level: lvl } }),
              spacing: { after: 60 },
              children: box ? [new TextRun({ text: box })] : [],
            })
      const tail = this.blocks(first && first.type !== 'paragraph' ? [first, ...rest] : rest, level + 1, quote)
      return [head, ...tail]
    })
  }

  private table(table: Table): DocxTable {
    const border = { style: BorderStyle.SINGLE, size: 4, color: 'D9D4CC' }
    const borders = { top: border, bottom: border, left: border, right: border }
    const align = table.align ?? []
    return new DocxTable({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: table.children.map(
        (row, rowIndex) =>
          new TableRow({
            tableHeader: rowIndex === 0,
            children: row.children.map(
              (cell, cellIndex) =>
                new TableCell({
                  borders,
                  margins: { top: 60, bottom: 60, left: 100, right: 100 },
                  shading: rowIndex === 0 ? { type: ShadingType.CLEAR, fill: 'F6F3EE' } : undefined,
                  children: [
                    new Paragraph({
                      alignment:
                        align[cellIndex] === 'right'
                          ? AlignmentType.RIGHT
                          : align[cellIndex] === 'center'
                            ? AlignmentType.CENTER
                            : AlignmentType.LEFT,
                      children: docxInline(cell.children, rowIndex === 0 ? { bold: true } : {}),
                    }),
                  ],
                }),
            ),
          }),
      ),
    })
  }
}

export async function markdownToDocxBuffer(
  source: string,
  opts: { path: string; updatedAt?: string | null },
): Promise<Buffer> {
  const tree = parseMarkdown(source)
  const title = documentTitle(tree, opts.path)
  const children = new DocxBuilder().blocks(tree.children)
  const doc = new Document({
    title,
    creator: 'Excellence AI',
    description: opts.path,
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 } } },
    },
    numbering: {
      config: [
        {
          reference: 'ol',
          levels: Array.from({ length: 6 }, (_, level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 + level * 360, hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children }],
  })
  return Packer.toBuffer(doc)
}

/** Nem markdown fájl Wordben: soronként egy bekezdés, fix szélességű betűvel. */
export async function plainTextToDocxBuffer(source: string, opts: { path: string }): Promise<Buffer> {
  const doc = new Document({
    title: exportBaseName(opts.path),
    creator: 'Excellence AI',
    description: opts.path,
    sections: [
      {
        children: source.split(/\r?\n/).map(
          (line) =>
            new Paragraph({
              spacing: { after: 0 },
              children: [new TextRun({ text: line, font: 'Courier New', size: 20 })],
            }),
        ),
      },
    ],
  })
  return Packer.toBuffer(doc)
}
