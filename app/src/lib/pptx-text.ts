import { posix } from 'node:path'
import { OfficeArchiveError, readOfficeArchiveEntries } from './office-archive-guard'

/**
 * PowerPoint-prezentáció szövege diánként, a prezentáció valódi sorrendjében.
 * A diák képei, diagramjai és SmartArt-elemei nem kerülnek bele, mert ezeket
 * csak képként lehetne elolvasni.
 */
export type PptxSlide = {
  title: string | null
  hidden: boolean
  lines: string[]
  notes: string[]
}

type Shape = { placeholder: string | null; lines: string[] }

const PPTX_PARTS = /^ppt\/(presentation\.xml$|_rels\/presentation\.xml\.rels$|slides\/|notesSlides\/)/
const TITLE_PLACEHOLDERS = new Set(['title', 'ctrTitle'])
const CHROME_PLACEHOLDERS = new Set(['sldNum', 'dt', 'ftr', 'hdr'])
// Egy menetben végigmegy a címkéken: a fájl támadó által is készíthető, ezért nem használ visszalépő mintát.
const SLIDE_TAG = /<(\/?)(?:[A-Za-z_][\w.-]*:)?(sld|sp|ph|p|t|br|tr|tc)(?=[\s/>])([^<>]*)>/g
const RELATIONSHIP_TAG = /<(?:[A-Za-z_][\w.-]*:)?Relationship(?=[\s/>])([^<>]*)>/g
const SLIDE_ID_TAG = /<(?:[A-Za-z_][\w.-]*:)?sldId(?=[\s/>])([^<>]*)>/g
const XML_ENTITY = /&(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});/gi

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)')`).exec(attrs)
  return match ? (match[1] ?? match[2]) : null
}

function decodeNumericEntity(code: number): string {
  // A NUL és a csonka UTF-16 pár nem tárolható Postgres szövegként.
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ''
  return String.fromCodePoint(code)
}

function decodeXmlText(text: string): string {
  return text.replace(XML_ENTITY, (_, entity: string) => {
    const name = entity.toLowerCase()
    if (name === 'amp') return '&'
    if (name === 'lt') return '<'
    if (name === 'gt') return '>'
    if (name === 'quot') return '"'
    if (name === 'apos') return "'"
    return decodeNumericEntity(name.startsWith('#x') ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10))
  })
}

function readShapes(xml: string): { hidden: boolean; shapes: Shape[] } {
  const shapes: Shape[] = []
  let hidden = false
  let shape: Shape | null = null
  let paragraph: string | null = null
  let cell: string[] | null = null
  let row: string[] | null = null
  let textStart = -1

  const pushLine = (line: string) => {
    if (shape) shape.lines.push(line)
    else shapes.push({ placeholder: null, lines: [line] })
  }

  for (const match of xml.matchAll(SLIDE_TAG)) {
    const closing = match[1] === '/'
    const name = match[2]
    const attrs = match[3]
    const selfClosed = attrs.endsWith('/')
    const tagEnd = match.index + match[0].length

    if (name === 'sld' && !closing) {
      const show = attribute(attrs, 'show')
      hidden = show === '0' || show === 'false'
    } else if (name === 'sp') {
      if (closing) {
        if (shape && shape.lines.length > 0) shapes.push(shape)
        shape = null
      } else if (!selfClosed) {
        shape = { placeholder: null, lines: [] }
      }
    } else if (name === 'ph' && !closing && shape) {
      shape.placeholder = attribute(attrs, 'type') ?? 'obj'
    } else if (name === 'p') {
      if (closing) {
        const text = (paragraph ?? '').trim()
        if (text) {
          if (cell) cell.push(text)
          else pushLine(text)
        }
        paragraph = null
      } else if (!selfClosed) {
        paragraph = ''
      }
    } else if (name === 't') {
      if (closing) {
        if (textStart >= 0 && paragraph !== null) paragraph += decodeXmlText(xml.slice(textStart, match.index))
        textStart = -1
      } else if (!selfClosed) {
        textStart = tagEnd
      }
    } else if (name === 'br' && !closing && paragraph !== null) {
      paragraph += '\n'
    } else if (name === 'tr') {
      if (closing) {
        if (row?.some(Boolean)) pushLine(row.join(' | '))
        row = null
      } else if (!selfClosed) {
        row = []
      }
    } else if (name === 'tc') {
      if (closing) {
        row?.push((cell ?? []).join(' '))
        cell = null
      } else if (selfClosed) {
        row?.push('')
      } else {
        cell = []
      }
    }
  }
  return { hidden, shapes }
}

type Relationship = { id: string; type: string; target: string }

function readRelationships(xml: string | undefined, sourcePath: string): Relationship[] {
  if (!xml) return []
  const baseDir = posix.dirname(sourcePath)
  const relationships: Relationship[] = []
  for (const match of xml.matchAll(RELATIONSHIP_TAG)) {
    const id = attribute(match[1], 'Id')
    const type = attribute(match[1], 'Type')
    const target = attribute(match[1], 'Target')
    if (!id || !type || !target) continue
    relationships.push({
      id,
      type,
      target: target.startsWith('/') ? posix.normalize(target).slice(1) : posix.join(baseDir, target),
    })
  }
  return relationships
}

function relationshipsPath(partPath: string): string {
  return posix.join(posix.dirname(partPath), '_rels', `${posix.basename(partPath)}.rels`)
}

function slidePathsInOrder(parts: Map<string, string>): string[] {
  const presentationPath = 'ppt/presentation.xml'
  const relationships = readRelationships(parts.get(relationshipsPath(presentationPath)), presentationPath)
  const targets = new Map(relationships.map((relationship) => [relationship.id, relationship.target]))
  const ordered = new Set<string>()
  for (const match of (parts.get(presentationPath) ?? '').matchAll(SLIDE_ID_TAG)) {
    const id = attribute(match[1], '[A-Za-z_][\\w.-]*:id')
    const path = id ? targets.get(id) : undefined
    if (path && parts.has(path)) {
      if (ordered.has(path)) throw new OfficeArchiveError()
      ordered.add(path)
    }
  }
  if (ordered.size > 0) return [...ordered]
  const slideNumber = (path: string) => Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(path)?.[1] ?? NaN)
  return [...parts.keys()]
    .filter((path) => !Number.isNaN(slideNumber(path)))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
}

function readNotes(parts: Map<string, string>, slidePath: string, seen: Set<string>): string[] {
  const notesPath = readRelationships(parts.get(relationshipsPath(slidePath)), slidePath)
    .find((relationship) => relationship.type.endsWith('/notesSlide'))?.target
  const xml = notesPath ? parts.get(notesPath) : undefined
  if (!xml || !notesPath) return []
  if (seen.has(notesPath)) throw new OfficeArchiveError()
  seen.add(notesPath)
  return readShapes(xml).shapes
    .filter((shape) => shape.placeholder === 'body')
    .flatMap((shape) => shape.lines)
}

/** @throws OfficeArchiveError ha a fájl nem bontható ki (sérült vagy jelszóval védett). */
export function readPptxSlides(buffer: Buffer): PptxSlide[] {
  const parts = new Map(
    readOfficeArchiveEntries(buffer, (path) => PPTX_PARTS.test(path))
      .map((entry) => [entry.path, Buffer.from(entry.bytes).toString('utf8')] as const),
  )
  const seenNotes = new Set<string>()
  return slidePathsInOrder(parts).map((path) => {
    const { hidden, shapes } = readShapes(parts.get(path)!)
    const title = shapes.find((shape) => shape.placeholder && TITLE_PLACEHOLDERS.has(shape.placeholder))
    return {
      title: title ? title.lines.join(' ').replace(/\s+/g, ' ') : null,
      hidden,
      lines: shapes
        .filter((shape) => shape !== title && !(shape.placeholder && CHROME_PLACEHOLDERS.has(shape.placeholder)))
        .flatMap((shape) => shape.lines),
      notes: readNotes(parts, path, seenNotes),
    }
  })
}
