/**
 * tulajdoni_lap_parse oldalforrás — Document extraction VAGY nyers PDF/markdown buffer.
 *
 * Chat/ticket feltöltéskor az eredeti PDF bináris NINCS eltárolva: a `storageRef`
 * és a workspace `.pdf.txt` a kinyert markdown. A parsernek ezért az extraction
 * blokkokból / markdown `# Oldal N` headingekből kell tudnia oldalakat építeni;
 * a PDF-újraolvasás csak akkor megy, ha tényleg PDF van a bufferben.
 */
import { blocksFromDocument } from '@/lib/document-read'

/** Document.metadata + extractedText → oldalankénti szöveg (üres → []). */
export function pagesFromDocumentExtraction(
  metadata: unknown,
  extractedText: string | null | undefined,
): string[] {
  const blocks = blocksFromDocument(metadata, extractedText ?? null)
  const ranked = blocks.map((block, index) => ({
    page:
      typeof block.sourceRef.page === 'number' && block.sourceRef.page >= 1
        ? block.sourceRef.page
        : index + 1,
    text: block.text,
  }))
  ranked.sort((a, b) => a.page - b.page)
  return ranked.map((row) => row.text).filter((text) => text.trim().length > 0)
}

/** `%PDF` mágikus bájtok (opcionális leading whitespace után is). */
export function bufferLooksLikePdf(buffer: Buffer): boolean {
  if (buffer.length < 5) return false
  const head = buffer.subarray(0, Math.min(buffer.length, 32))
  let i = 0
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x0a || head[i] === 0x0d || head[i] === 0x09)) {
    i++
  }
  return (
    head[i] === 0x25 && // %
    head[i + 1] === 0x50 && // P
    head[i + 2] === 0x44 && // D
    head[i + 3] === 0x46 // F
  )
}
