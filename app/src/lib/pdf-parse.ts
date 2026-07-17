/**
 * Next.js SSR-biztos `pdf-parse` betöltés.
 *
 * A v2 a `pdfjs-dist` workert keresi; ha a Next bebundle-öli a libet az SSR
 * chunkokba, a relatív `pdf.worker.mjs` path elromlik (fake worker failed).
 * `serverExternalPackages` + explicit `setWorker(getData())` együtt oldja meg.
 */
export type PdfParseCtor = typeof import('pdf-parse').PDFParse

let cached: PdfParseCtor | null = null
let workerReady = false

export async function loadPdfParse(): Promise<PdfParseCtor> {
  if (cached) return cached

  const [{ PDFParse }, worker] = await Promise.all([
    import('pdf-parse'),
    import('pdf-parse/worker'),
  ])

  if (!workerReady) {
    // Inlined worker — nem függ a chunk melletti fájlúttól (Cloud Run / SSR).
    PDFParse.setWorker(worker.getData())
    workerReady = true
  }

  cached = PDFParse
  return PDFParse
}
