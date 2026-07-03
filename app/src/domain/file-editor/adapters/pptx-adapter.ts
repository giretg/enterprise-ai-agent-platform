import { FileEditorError } from '../workspace-storage'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function importPptxGen(): Promise<any> {
  try {
    const mod = await import('pptxgenjs')
    // A pptxgenjs CJS default exportot ad; ESM interopban a .default alatt van.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (mod as any).default ?? mod
  } catch {
    throw new FileEditorError(
      'BINARY_ADAPTER_UNAVAILABLE',
      'pptxgenjs is not installed. Run: npm install pptxgenjs',
    )
  }
}

type CellValue = string | number | boolean | null

export type PptxSlideSpec = {
  /** Diaelrendezés. Alap: ha van bullets → 'bullets', ha rows → 'table', egyébként 'title'. */
  layout?: 'title' | 'section' | 'bullets' | 'table'
  title?: string
  /** 'title' / 'section' elrendezésnél a cím alatti alcím. */
  subtitle?: string
  /** 'bullets' elrendezésnél a felsorolás pontjai. */
  bullets?: string[]
  /** 'table' elrendezésnél a fejlécsor. */
  headers?: string[]
  /** 'table' elrendezésnél az adatsorok. */
  rows?: CellValue[][]
  /** Előadói jegyzet (a dián nem látszik). */
  notes?: string
}

export type PptxCreateSpec = {
  title?: string
  author?: string
  subject?: string
  slides: PptxSlideSpec[]
}

// Egységes, modern téma (sötét akcentus + tiszta tipográfia).
const ACCENT = '1F4E78'
const ACCENT_LIGHT = 'E8EEF6'
const TEXT_DARK = '1A1A1A'
const TEXT_MUTED = '5A6472'
const WHITE = 'FFFFFF'
const FONT = 'Calibri'

function resolveLayout(slide: PptxSlideSpec): NonNullable<PptxSlideSpec['layout']> {
  if (slide.layout) return slide.layout
  if (slide.rows && slide.rows.length > 0) return 'table'
  if (slide.bullets && slide.bullets.length > 0) return 'bullets'
  return 'title'
}

/**
 * PPTX prezentáció generálása diaspecifikációkból. Az eredmény valódi,
 * letölthető .pptx (16:9). Négy diatípus: cím-, szekció-, felsorolásos- és
 * táblázatos dia — mindegyik közös témával (sötét akcentus, tiszta tipográfia).
 */
export async function pptxCreate(spec: PptxSlideSpec[] | PptxCreateSpec): Promise<Buffer> {
  const normalized: PptxCreateSpec = Array.isArray(spec) ? { slides: spec } : spec
  const slides = normalized.slides ?? []
  if (slides.length === 0) {
    throw new FileEditorError('INVALID_ARGS', 'pptx_create requires at least one slide')
  }

  const PptxGenJS = await importPptxGen()
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'WIDE', width: 13.333, height: 7.5 })
  pptx.layout = 'WIDE'
  if (normalized.author) pptx.author = normalized.author
  if (normalized.subject) pptx.subject = normalized.subject
  if (normalized.title) pptx.title = normalized.title

  const W = 13.333

  for (const slide of slides) {
    const layout = resolveLayout(slide)
    const s = pptx.addSlide()

    if (slide.notes) s.addNotes(slide.notes)

    if (layout === 'title' || layout === 'section') {
      if (layout === 'section') {
        s.background = { color: ACCENT }
      } else {
        s.addShape(pptx.ShapeType.rect, { x: 0, y: 3.05, w: W, h: 0.06, fill: { color: ACCENT } })
      }
      const titleColor = layout === 'section' ? WHITE : ACCENT
      const subColor = layout === 'section' ? ACCENT_LIGHT : TEXT_MUTED
      s.addText(slide.title ?? '', {
        x: 0.9, y: 2.2, w: W - 1.8, h: 1.0,
        fontFace: FONT, fontSize: 40, bold: true, color: titleColor,
        align: 'left', valign: 'bottom',
      })
      if (slide.subtitle) {
        s.addText(slide.subtitle, {
          x: 0.9, y: 3.25, w: W - 1.8, h: 0.8,
          fontFace: FONT, fontSize: 20, color: subColor, align: 'left', valign: 'top',
        })
      }
      continue
    }

    // Tartalmi diák közös fejléce (cím + akcentus sáv).
    if (slide.title) {
      s.addText(slide.title, {
        x: 0.6, y: 0.4, w: W - 1.2, h: 0.8,
        fontFace: FONT, fontSize: 26, bold: true, color: ACCENT, align: 'left', valign: 'middle',
      })
      s.addShape(pptx.ShapeType.rect, { x: 0.6, y: 1.2, w: W - 1.2, h: 0.03, fill: { color: ACCENT } })
    }

    if (layout === 'bullets') {
      const bullets = slide.bullets ?? []
      s.addText(
        bullets.map((b) => ({ text: b, options: { bullet: { characterCode: '2022' }, breakLine: true } })),
        {
          x: 0.7, y: 1.5, w: W - 1.4, h: 5.4,
          fontFace: FONT, fontSize: 18, color: TEXT_DARK, align: 'left', valign: 'top',
          paraSpaceAfter: 10, lineSpacingMultiple: 1.1,
        },
      )
      continue
    }

    if (layout === 'table') {
      const headers = slide.headers ?? []
      const dataRows = slide.rows ?? []
      const tableRows: unknown[] = []
      if (headers.length > 0) {
        tableRows.push(
          headers.map((h) => ({
            text: String(h ?? ''),
            options: { bold: true, color: WHITE, fill: { color: ACCENT }, fontFace: FONT, fontSize: 13, valign: 'middle' },
          })),
        )
      }
      dataRows.forEach((row, i) => {
        tableRows.push(
          row.map((cell) => ({
            text: cell == null ? '' : String(cell),
            options: {
              color: TEXT_DARK,
              fill: { color: i % 2 === 1 ? ACCENT_LIGHT : WHITE },
              fontFace: FONT,
              fontSize: 12,
              valign: 'middle',
            },
          })),
        )
      })
      if (tableRows.length > 0) {
        s.addTable(tableRows as never, {
          x: 0.6, y: 1.5, w: W - 1.2,
          border: { type: 'solid', color: 'D0D7E2', pt: 0.5 },
          align: 'left', valign: 'middle', autoPage: true,
          autoPageRepeatHeader: headers.length > 0,
        })
      }
      continue
    }
  }

  const data = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer | ArrayBuffer | Uint8Array
  if (Buffer.isBuffer(data)) return data
  return Buffer.from(data as ArrayBuffer)
}
