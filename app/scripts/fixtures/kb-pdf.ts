import { PDFDocument } from 'pdf-lib'
import { renderPdfPages } from '../../src/lib/kb-pdf-images'

/** Real PDF bytes: text layer, raster-only scan, and a mixed document. No AI/OCR. */
export async function kbPdfFixtures() {
  const textDoc = await PDFDocument.create()
  const page = textDoc.addPage([612, 792])
  page.drawText('Laboratory report: glucose 5.2 mmol/L; reference interval 3.9-6.0.', { x: 40, y: 720, size: 14 })
  const text = Buffer.from(await textDoc.save())
  const rendered = await renderPdfPages(text)
  const scanDoc = await PDFDocument.create()
  const scan = await scanDoc.embedPng(Buffer.from(rendered.images[0].data, 'base64'))
  scanDoc.addPage([612, 792]).drawImage(scan, { x: 0, y: 0, width: 612, height: 792 })
  const scanned = Buffer.from(await scanDoc.save())
  const mixedDoc = await PDFDocument.create()
  const [textPage] = await mixedDoc.copyPages(textDoc, [0])
  const [scanPage] = await mixedDoc.copyPages(scanDoc, [0])
  mixedDoc.addPage(textPage)
  mixedDoc.addPage(scanPage)
  mixedDoc.addPage([792, 612]).drawText('Short', { x: 40, y: 500 })
  return { text, scanned, mixed: Buffer.from(await mixedDoc.save()) }
}
