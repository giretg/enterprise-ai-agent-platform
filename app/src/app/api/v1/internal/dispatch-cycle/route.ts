import { NextResponse } from 'next/server'
import { handleDispatchCycleRequest } from '@/domain/dispatcher/dispatch-cycle-request'
import { runDispatchCycle } from '@/domain/dispatcher/run-dispatch-cycle'
import { readBoundedText } from '@/lib/api-response'

/**
 * Stateless dispatch-ciklus végpont (§5.7 költség-kiegészítés): ugyanazt a ciklust futtatja
 * le (stale-reclaim, ütemezett task materializálás, monitor söprés, workspace-purge,
 * ready ticketek dispatchelése), mint a `scripts/dispatcher-worker.ts`, de EGYSZER, a
 * kérés élettartama alatt — nincs perzisztens LISTEN-kapcsolat, nincs végtelen loop.
 *
 * Ez a route a control-plane UI folyamatában él. A Cloud Scheduler forgalma (#114) MÁR NEM
 * ide jön, hanem a dedikált worker szolgáltatásra (`scripts/dispatch-cycle-server.ts`),
 * hogy egy nehéz ciklus ne az interaktív oldalak konténerét terhelje. A végpont mégis
 * megmarad az UI-n, mert (a) ez a rollback-út — a Scheduler targetje egy lépésben
 * visszaállítható ide —, és (b) a belső/kézi hívók megszokott címe.
 *
 * A token-ellenőrzés és a válasz-alak a megosztott `handleDispatchCycleRequest`-ből jön,
 * hogy a két belépő ne csússzon szét: ugyanaz a hívás ugyanazt a választ adja itt és a
 * workeren is.
 */
export async function POST(request: Request) {
  const result = await handleDispatchCycleRequest(
    {
      providedToken: request.headers.get('x-dispatcher-token'),
      // A nyers törzset is bájt-plafonig olvassuk (a `handleDispatchCycleRequest`
      // ezt is `JSON.parse`-olja); túl nagy törzs → a handler catch-e 400-at ad, OOM nélkül.
      readRawBody: () => readBoundedText(request),
    },
    runDispatchCycle,
  )
  return NextResponse.json(result.body, {
    status: result.status,
    // Melyik szolgáltatás szolgálta ki a hívást (a törzs változatlan). Az üzemeltető
    // ebből látja, hogy a Scheduler célja a dedikált worker-e vagy — rollback után — az UI.
    headers: { 'x-dispatch-cycle-service': 'ui' },
  })
}
