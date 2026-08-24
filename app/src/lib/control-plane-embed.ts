import { CONTROL_PLANE_PANELS } from '@/lib/control-plane-panels'

/** Middleware-barát panel → href map (embed rewrite). */
export const EMBED_PANEL_HREFS: Record<string, string> = Object.fromEntries(
  Object.entries(CONTROL_PLANE_PANELS).map(([key, def]) => [key, def.href]),
)

export function embedHrefForPanel(panel: string): string | null {
  return EMBED_PANEL_HREFS[panel] ?? null
}

/**
 * Modal-iframe kérés? A rewrite `x-cp-embed` fejléce az első betöltésen megvan,
 * de a iframe-en belüli Next-navigáció (/tickets/…) már nem megy át
 * `/embed/control-plane/…`-on. `sec-fetch-dest: iframe` a dokumentum-betöltést
 * fedi; a kliens layout `window.parent !== window` a soft-navet.
 */
export function isControlPlaneEmbedRequest(h: {
  get(name: string): string | null
}): boolean {
  return h.get('x-cp-embed') === '1' || h.get('sec-fetch-dest') === 'iframe'
}
