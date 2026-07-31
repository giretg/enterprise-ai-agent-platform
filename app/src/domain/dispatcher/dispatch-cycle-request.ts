import { safeSecretEquals } from '@/lib/crypto/timing-safe'

import type { DispatchCycleSummary, DispatchCycleTrigger } from './run-dispatch-cycle'

/**
 * A stateless dispatch-ciklus HTTP-SZERZŐDÉSE — transzport-független formában (#114).
 *
 * Miért külön modul: a ciklust mostantól KÉT folyamat szolgálhatja ki ugyanazon az úton
 * (`POST /api/v1/internal/dispatch-cycle` + `x-dispatcher-token`):
 *   1. a control-plane UI Next.js route-ja (`src/app/api/v1/internal/dispatch-cycle/route.ts`),
 *   2. a dedikált Cloud Run worker szolgáltatás (`scripts/dispatch-cycle-server.ts`),
 *      amit a Cloud Scheduler hív, hogy egy nehéz ciklus ne az interaktív oldalak
 *      konténerében fusson.
 *
 * Ha az auth és a válasz-alak mindkét helyen külön élne, csendben szétcsúsznának: az
 * üzemeltető ugyanarra a hívásra más választ/hibakódot kapna attól függően, melyik URL-t
 * célozza a Scheduler — pont azt a rollback-lépést tenné kockázatossá, ami a biztonsági
 * hálónk. Ezért a token-ellenőrzés, a body-értelmezés és a válaszburok EGY helyen van; a
 * két belépő csak adapter (Request → itt → Response).
 *
 * A ciklus MAGJA (`runDispatchCycle`) szándékosan paraméter, nem import: így a szerződés
 * DB és `@/domain` nélkül tesztelhető, és marad egyetlen közös implementáció a worker, a
 * Scheduler-hívás és az admin kézi trigger mögött.
 */

export type DispatchCycleRunner = (input: {
  ticketId?: string
  triggeredBy?: DispatchCycleTrigger
}) => Promise<DispatchCycleSummary>

export type DispatchCycleHttpRequest = {
  /** Az `x-dispatcher-token` fejléc értéke (hiányzó fejléc → null). */
  providedToken: string | null
  /**
   * A nyers kérés-törzs beolvasása. Szándékosan függvény: a törzset CSAK sikeres
   * token-ellenőrzés után pufferoljuk, így egy hitelesítetlen hívó nem tud a
   * beolvasásán keresztül memóriát foglaltatni. Üres törzs megengedett (a Scheduler
   * `{}`-t küld).
   */
  readRawBody: () => string | Promise<string>
  /** Alap: `DISPATCHER_CONTROL_TOKEN`. Explicit érték csak teszthez / beágyazáshoz. */
  expectedToken?: string | null
  /** Melyik forrás írja be a `dispatcher.last_cycle` rekordba. Alap: `scheduler`. */
  triggeredBy?: DispatchCycleTrigger
}

export type DispatchCycleHttpResponse = {
  status: number
  body: { success: true; data: DispatchCycleSummary } | { success: false; error: string }
}

function failure(status: number, error: string): DispatchCycleHttpResponse {
  return { status, body: { success: false, error } }
}

/**
 * Egy dispatch-ciklus HTTP-kérés kiszolgálása: token-ellenőrzés → body → ciklus → burok.
 *
 * Válaszok (a meglévő, változatlan szerződés):
 *  - 401 — hiányzó/hibás `x-dispatcher-token` (vagy a szolgáltatáson nincs beállítva a titok),
 *  - 400 — értelmezhetetlen JSON törzs,
 *  - 500 — a ciklus hibára futott (az üzenet a hívónak/logba megy),
 *  - 200 — `{ success: true, data: DispatchCycleSummary }`.
 */
export async function handleDispatchCycleRequest(
  request: DispatchCycleHttpRequest,
  runCycle: DispatchCycleRunner,
): Promise<DispatchCycleHttpResponse> {
  const expectedToken = (request.expectedToken ?? process.env.DISPATCHER_CONTROL_TOKEN)?.trim()
  if (!expectedToken || !safeSecretEquals(request.providedToken, expectedToken)) {
    return failure(401, 'invalid or missing x-dispatcher-token')
  }

  let ticketId: string | undefined
  try {
    const raw = (await request.readRawBody()) ?? ''
    if (raw.trim()) {
      const body = (JSON.parse(raw) ?? {}) as { ticketId?: unknown }
      if (typeof body.ticketId === 'string' && body.ticketId.trim()) ticketId = body.ticketId.trim()
    }
  } catch {
    return failure(400, 'Invalid JSON body')
  }

  try {
    const summary = await runCycle({ ticketId, triggeredBy: request.triggeredBy ?? 'scheduler' })
    return { status: 200, body: { success: true, data: summary } }
  } catch (e) {
    return failure(500, e instanceof Error ? e.message : 'Dispatch cycle failed')
  }
}
