import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireTenantRole, TenantAuthError } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { WikiConsoleError } from '@/domain/knowledge-base/wiki-console-service'

export const runtime = 'nodejs'

const Body = z.object({ query: z.string().max(200) })
const NO_STORE = { 'Cache-Control': 'no-store' }
const SLOW_MS = 1_000

function fail(status: number) {
  return NextResponse.json({ error: status }, { status, headers: NO_STORE })
}

/**
 * #1136: keresés egy wiki oldalaiban. POST, hogy a keresett szó (akár név vagy
 * ügyfélazonosító) ne kerüljön a kérésnaplóba (D6). A szó ezért a hibanaplóba sem
 * mehet: csak darabszám, futásidő és a hiba típusa (D7).
 */
export async function POST(request: Request, context: { params: Promise<{ connectorId: string }> }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const { connectorId } = await context.params
    if (!/^[0-9a-f-]{36}$/i.test(connectorId)) return fail(404)
    // A JSON-tartalomtípus miatt más oldalról érkező kérés előellenőrzésen akad el.
    if (!request.headers.get('content-type')?.startsWith('application/json')) return fail(415)
    const raw = await request.text()
    if (raw.length > 4_096) return fail(400)
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      return fail(400)
    }
    const body = Body.safeParse(json)
    if (!body.success) return fail(400)

    const startedAt = Date.now()
    const result = await services.wikiConsole.searchPages(
      { userId: ctx.user.id, tenantId: ctx.activeTenantId, role: ctx.activeTenantRole, assumed: ctx.assumed },
      connectorId,
      body.data.query,
    )
    const elapsed = Date.now() - startedAt
    if (elapsed > SLOW_MS) console.warn('[wiki-search] slow', { ms: elapsed, total: result.total })
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (error) {
    if (error instanceof TenantAuthError) return fail(error.code === 'INSUFFICIENT_ROLE' ? 403 : 401)
    // Privát wikinél a tiltás is „nem található”: a keresés nem árulhatja el, hogy létezik.
    if (error instanceof WikiConsoleError) return fail(404)
    console.error('[wiki-search] failed', { error: error instanceof Error ? error.name : 'unknown' })
    return fail(500)
  }
}
