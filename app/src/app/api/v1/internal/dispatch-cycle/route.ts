import { NextResponse } from 'next/server'
import { runDispatchCycle } from '@/domain/dispatcher/run-dispatch-cycle'
import { safeSecretEquals } from '@/lib/crypto/timing-safe'

/**
 * Stateless dispatch-ciklus végpont (§5.7 költség-kiegészítés): ugyanazt a ciklust futtatja
 * le (stale-reclaim, ütemezett task materializálás, monitor söprés, workspace-purge,
 * ready ticketek dispatchelése), mint a `scripts/dispatcher-worker.ts`, de EGYSZER, a
 * kérés élettartama alatt — nincs perzisztens LISTEN-kapcsolat, nincs végtelen loop.
 *
 * Cél: a `wiki-dispatcher` Cloud Run service (min-instances=1, állandó Neon-kapcsolat)
 * kiváltása egy GCP Cloud Scheduler → ez a végpont hívással (pl. percenként/N percenként).
 * A Cloud Scheduler HTTP-target egyéni fejlécet tud küldeni — ugyanazt a
 * DISPATCHER_CONTROL_TOKEN-t használjuk, mint a helyi worker /control/stop végpontjához.
 */
function jsonError(message: string, status: number) {
  return NextResponse.json({ success: false, error: message }, { status })
}

export async function POST(request: Request) {
  const expectedToken = process.env.DISPATCHER_CONTROL_TOKEN?.trim()
  const providedToken = request.headers.get('x-dispatcher-token')
  if (!expectedToken || !safeSecretEquals(providedToken, expectedToken)) {
    return jsonError('invalid or missing x-dispatcher-token', 401)
  }

  let ticketId: string | undefined
  try {
    const raw = await request.text()
    if (raw.trim()) {
      const body = JSON.parse(raw) as { ticketId?: unknown }
      if (typeof body.ticketId === 'string' && body.ticketId.trim()) ticketId = body.ticketId.trim()
    }
  } catch {
    return jsonError('Invalid JSON body', 400)
  }

  try {
    const summary = await runDispatchCycle({ ticketId, triggeredBy: 'scheduler' })
    return NextResponse.json({ success: true, data: summary })
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : 'Dispatch cycle failed', 500)
  }
}
