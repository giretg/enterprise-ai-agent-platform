/**
 * WP-7 (O3) — Readiness probe.
 *
 * Ellenorzi, hogy a process ki tudja-e szolgálni a forgalmat: DB-ping.
 * A WP-1 fail-closed titok-feloldás miatt a kötelezo titkok jelenléte booton
 * már garantált (hiányukban a process el sem indul) → itt csak a DB-t nézzük.
 * DB-hiba → 503, hogy a load balancer kivegye a rotációból. A middleware
 * public-matcherébe fel van véve (auth nélkül).
 */
import { prisma } from '@/lib/db'
import { captureException } from '@/lib/observability'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  try {
    await prisma.$queryRaw`SELECT 1`
    return Response.json({ status: 'ready' })
  } catch (e) {
    captureException(e, { source: 'readyz' })
    return Response.json({ status: 'unready', error: String(e) }, { status: 503 })
  }
}
