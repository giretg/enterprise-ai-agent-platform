export type KbHitSource = {
  documentId?: string
  filename?: string
  page?: number
  section?: string
  cell?: string
}

export type KbHit = {
  docId: string
  snippet: string
  sourceRef: string
  memoryVersion: number | null
  // KB-v3 §9.1 — OKF chunk-találat citation (opcionális; csak published OKF
  // chunk-találatnál van kitöltve, a legacy doc/memória-találatnál undefined).
  path?: string
  title?: string
  score?: number
  source?: KbHitSource
}

function extractFilename(sourceRef: string): string | null {
  const match = sourceRef.match(/:([^:]+)$/)
  return match ? match[1] : null
}

/** §4.7/§12.3 — oldal/section/cella-szintű forrás-hivatkozás emberi ellenőrzéshez. */
function formatSource(source: KbHitSource): string {
  const parts: string[] = []
  if (source.filename) parts.push(source.filename)
  if (typeof source.page === 'number') parts.push(`oldal ${source.page}`)
  else if (source.section) parts.push(`section „${source.section}"`)
  if (source.cell) parts.push(source.cell)
  return parts.join(', ')
}

export function formatHitsForPrompt(hits: KbHit[]): string {
  if (hits.length === 0) return '(nincs találat)'
  return hits
    .map((hit, index) => {
      // OKF chunk-találat: navigálható path + oldal/section-szintű forrás-link.
      if (hit.path) {
        const cite = hit.source ? formatSource(hit.source) : ''
        const header = `[${index + 1}] OKF: ${hit.title ?? hit.path} (${hit.path})${
          cite ? `; forrás: ${cite}` : ''
        }`
        return `${header}\n${hit.snippet}`
      }
      const filename = hit.memoryVersion === null ? extractFilename(hit.sourceRef) : null
      const header = filename
        ? `[${index + 1}] FÁJL TARTALOM: ${filename} (docId=${hit.docId})`
        : `[${index + 1}] docId=${hit.docId}; sourceRef=${hit.sourceRef}; memoryVersion=${hit.memoryVersion ?? 'unknown'}`
      return `${header}\n${hit.snippet}`
    })
    .join('\n\n')
}
