import type { PrivacyEntityMarker } from '@/domain/privacy/privacy-observability'
import { markerTooltipText } from '@/domain/privacy/privacy-observability'

/**
 * A chat `rehype-raw` csak a mi `<mark>` cimkéinket kaphatja meg.
 * Ezért a felhasználó / modell / vault szövegét HTML-ként escape-eljük, mielőtt
 * a kiemelést beillesztjük — különben egy privacy-marker jelenléte raw HTML XSS-t
 * nyitna a bejelentkezett platform-origón (süti, API, admin UI).
 */
function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeHtmlAttr(value: string): string {
  return escapeHtmlText(value).replace(/'/g, '&#39;')
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

/**
 * Markdown-forrásban `<mark>`-kel jelöli a védendő spanokat (rehype-raw + GFM).
 * A marker-tartományon KÍVÜLI és BELÜLI szöveget is escape-eli — a raw HTML
 * a forrásban így nem futhat le, csak a generált, ellenőrzött `<mark>` cimkék.
 */
export function injectPrivacyHighlights(
  text: string,
  markers: readonly PrivacyEntityMarker[],
): string {
  if (!text || markers.length === 0) return text

  // Balról jobbra, átfedő / érvénytelen tartományok kihagyásával — így az
  // escape utáni pozíciók nem csúsznak el, és a korábbi „jobbról balra splice”
  // sem tudott raw HTML-t a marker köré hagyni.
  const sorted = [...markers].sort((a, b) => a.start - b.start || b.end - a.end)
  let out = ''
  let cursor = 0
  for (const marker of sorted) {
    if (
      marker.start < cursor ||
      marker.start < 0 ||
      marker.end > text.length ||
      marker.start >= marker.end
    ) {
      continue
    }
    out += escapeHtmlText(text.slice(cursor, marker.start))
    const cls = highlightClass(marker.status)
    const title = escapeHtmlAttr(markerTooltipText(marker))
    const mid = escapeHtmlText(text.slice(marker.start, marker.end))
    out += `<mark class="${cls}" title="${title}">${mid}</mark>`
    cursor = marker.end
  }
  out += escapeHtmlText(text.slice(cursor))
  return out
}
