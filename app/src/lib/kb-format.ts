export type KbHit = {
  docId: string
  snippet: string
  sourceRef: string
  memoryVersion: number | null
}

function extractFilename(sourceRef: string): string | null {
  const match = sourceRef.match(/:([^:]+)$/)
  return match ? match[1] : null
}

export function formatHitsForPrompt(hits: KbHit[]): string {
  if (hits.length === 0) return '(nincs találat)'
  return hits
    .map((hit, index) => {
      const filename = hit.memoryVersion === null ? extractFilename(hit.sourceRef) : null
      const header = filename
        ? `[${index + 1}] FÁJL TARTALOM: ${filename} (docId=${hit.docId})`
        : `[${index + 1}] docId=${hit.docId}; sourceRef=${hit.sourceRef}; memoryVersion=${hit.memoryVersion ?? 'unknown'}`
      return `${header}\n${hit.snippet}`
    })
    .join('\n\n')
}
