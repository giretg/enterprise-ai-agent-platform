/**
 * WP-6 (O2) — Metrika-scrape endpoint (Prometheus text exposition).
 *
 * Opcionális bearer-token véd (`METRICS_TOKEN`): ha be van állítva, kötelezo a
 * `Authorization: Bearer <token>`. A middleware public-matcherébe fel van véve,
 * hogy a Clerk-auth ne blokkolja a scrape-et.
 */
import type { NextRequest } from 'next/server'
import { registry } from '@/lib/observability'

export const dynamic = 'force-dynamic'

export function GET(req: NextRequest): Response {
  const expected = process.env.METRICS_TOKEN?.trim()
  if (expected) {
    const auth = req.headers.get('authorization') ?? ''
    const provided = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
    if (provided !== expected) {
      return new Response('unauthorized', { status: 401 })
    }
  }
  return new Response(registry.render(), {
    status: 200,
    headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
  })
}
