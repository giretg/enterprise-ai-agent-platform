/**
 * WP-7 (O3) — Liveness probe.
 *
 * Olcsó: nincs DB- vagy külso függoség — csak azt jelzi, hogy a process fut és
 * a Next.js runtime kiszolgál. A load balancer / uptime-monitor erre köt.
 * A middleware public-matcherébe fel van véve (auth nélkül).
 */
export const dynamic = 'force-dynamic'

export function GET(): Response {
  return Response.json({ status: 'ok', ts: Date.now() })
}
