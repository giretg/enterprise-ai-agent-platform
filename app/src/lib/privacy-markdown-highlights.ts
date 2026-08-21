import type { PrivacyEntityMarker } from '@/domain/privacy/privacy-observability'
import { markerTooltipText } from '@/domain/privacy/privacy-observability'

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
}

function highlightClass(status: PrivacyEntityMarker['status']): string {
  switch (status) {
    case 'applied':
      return 'privacy-applied'
    case 'blocked':
      return 'privacy-blocked'
    case 'skipped':
      return 'privacy-skipped'
    case 'observed':
    default:
      return 'privacy-observed'
  }
}

/** Markdown-forrásban `<mark>`-kel jelöli a védendő spanokat (rehype-raw + GFM). */
export function injectPrivacyHighlights(
  text: string,
  markers: readonly PrivacyEntityMarker[],
): string {
  if (!text || markers.length === 0) return text
  const sorted = [...markers].sort((a, b) => b.start - a.start || b.end - a.end)
  let out = text
  for (const marker of sorted) {
    if (marker.start < 0 || marker.end > out.length || marker.start >= marker.end) continue
    const cls = highlightClass(marker.status)
    const title = escapeHtmlAttr(markerTooltipText(marker))
    const before = out.slice(0, marker.start)
    const mid = out.slice(marker.start, marker.end)
    const after = out.slice(marker.end)
    out = `${before}<mark class="${cls}" title="${title}">${mid}</mark>${after}`
  }
  return out
}
