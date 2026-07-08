/**
 * WP-6 (O2) — Kérés-korreláció.
 *
 * Minden HTTP-kérés kap egy `requestId`-t (a middleware állítja be a bejövo
 * `x-request-id` fejlécbol, vagy generál egyet). A downstream logok/hibák ezzel
 * korrelálhatók.
 */
export const REQUEST_ID_HEADER = 'x-request-id'

/**
 * A bejövo requestId átvétele (ha van és épkézláb), különben friss UUID.
 *
 * A Web Crypto globált (`globalThis.crypto.randomUUID`) használjuk, nem a Node
 * `crypto` modult: a middleware az EDGE runtime-on fut, ami nem támogatja a
 * Node.js beépített moduljait — a globális Web Crypto viszont edge-en és
 * node-on egyaránt elérheto.
 */
export function resolveRequestId(incoming: string | null | undefined): string {
  if (incoming && incoming.length > 0 && incoming.length <= 200) {
    // Csak biztonságos karakterek — a fejléc-érték nem szennyezheti a logot.
    if (/^[A-Za-z0-9._-]+$/.test(incoming)) return incoming
  }
  return globalThis.crypto.randomUUID()
}
