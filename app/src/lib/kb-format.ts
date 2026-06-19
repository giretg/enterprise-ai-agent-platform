export type KbHit = {
  docId: string
  snippet: string
  sourceRef: string
  memoryVersion: number | null
}

export function formatHitsForPrompt(hits: KbHit[]): string {
  if (hits.length === 0) return '(nincs találat)'
  return hits
    .map(
      (hit, index) =>
        `[${index + 1}] docId=${hit.docId}; sourceRef=${hit.sourceRef}; memoryVersion=${hit.memoryVersion ?? 'unknown'}\n${hit.snippet}`,
    )
    .join('\n\n')
}
