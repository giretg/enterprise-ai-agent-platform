/**
 * WP-6 (O2) — Metrika-scrape endpoint (Prometheus text exposition).
 *
 * Kötelezo bearer-token véd (`METRICS_TOKEN`): konfiguráció nélkül 503.
 * A middleware public-matcherébe fel van véve,
 * hogy a Clerk-auth ne blokkolja a scrape-et.
 */
import { registry } from '@/lib/observability'
import { safeSecretEquals } from '@/lib/crypto/timing-safe'

export const dynamic = 'force-dynamic'

export function GET(req: Request): Response {
  const expected = process.env.METRICS_TOKEN?.trim()
  if (!expected) return new Response('metrics unavailable', { status: 503 })
  const auth = req.headers.get('authorization') ?? ''
  const provided = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
  if (!safeSecretEquals(provided, expected)) {
    return new Response('unauthorized', { status: 401 })
  }
  return new Response(registry.render(), {
    status: 200,
    headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
  })
}
