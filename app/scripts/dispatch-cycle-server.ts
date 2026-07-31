/**
 * Dedikált dispatch-ciklus worker szolgáltatás (#114) — Cloud Run service belépője.
 * Futtatás: npm run dispatch-cycle:server (app/)
 *
 * ÜZLETI OK. Eddig a Cloud Scheduler a control-plane UI publikus URL-jét hívta, tehát a
 * percenkénti ciklus (stale-reclaim, ütemezett task, monitor-söprés, workspace-purge,
 * channel-turn drain, ready ticket dispatch — LLM-hívásokkal) UGYANABBAN a konténerben
 * futott, mint az interaktív oldalak. Egy nehéz kör lassította/OOM-olta a felületet, egy
 * UI-csúcs pedig eltolta a ticket-feldolgozást. Ez a process ugyanazt a végpontot szolgálja
 * ki, csak külön Cloud Run szolgáltatásként, saját CPU/memória profillal — a két terhelés
 * így nem osztozik és külön is mérhető.
 *
 * SZERZŐDÉS (változatlan): `POST /api/v1/internal/dispatch-cycle` + `x-dispatcher-token`
 * fejléc, válasz `{ success, data: DispatchCycleSummary }`. A ciklus MAGJA a közös
 * `runDispatchCycle` — ugyanaz fut itt, a UI route-on és az admin kézi triggerén.
 *
 * NEM azonos a `scripts/dispatcher-worker.ts` + `Dockerfile.dispatcher` úttal: az a legacy
 * wiki-harness LISTEN/NOTIFY worker, ami állandó Neon-kapcsolatot és `min-instances=1`-et
 * igényel. Ez itt stateless: kérésre ébred, lefuttat egy kört, és visszaskálázódhat.
 *
 * Kötelező env: DISPATCHER_CONTROL_TOKEN, DATABASE_URL (és amit a ciklus szolgáltatásai
 * igényelnek). PORT: Cloud Run adja, lokálisan alap 8080.
 */
import './load-env'
import { createServer, type IncomingMessage } from 'http'

import { handleDispatchCycleRequest } from '../src/domain/dispatcher/dispatch-cycle-request'
import { runDispatchCycle } from '../src/domain/dispatcher/run-dispatch-cycle'

const DISPATCH_CYCLE_PATH = '/api/v1/internal/dispatch-cycle'
/**
 * A törzs a Schedulertől `{}` vagy egy rövid `{"ticketId":"…"}` — ennél nagyobbat nem
 * fogadunk el, hogy egy elgépelt/rosszindulatú hívó ne tudjon memóriát foglaltatni.
 */
const MAX_BODY_BYTES = 64 * 1024

const health = {
  startedAt: new Date().toISOString(),
  cycles: 0,
  lastCycleAt: null as string | null,
  lastCycleError: null as string | null,
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name]
  if (Array.isArray(raw)) return raw[0] ?? null
  return raw ?? null
}

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]

  if (req.method === 'POST' && (url === DISPATCH_CYCLE_PATH || url === `${DISPATCH_CYCLE_PATH}/`)) {
    void handleDispatchCycleRequest(
      {
        providedToken: headerValue(req, 'x-dispatcher-token'),
        readRawBody: () => readBody(req),
        // A futást a Cloud Scheduler indítja (csak a KISZOLGÁLÓ költözött ide az UI-ról),
        // ezért a `dispatcher.last_cycle` forrása továbbra is `scheduler` — az admin panel
        // így a szétválasztás előtt/után ugyanazt a sort mutatja.
        triggeredBy: 'scheduler',
      },
      runDispatchCycle,
    )
      .then((result) => {
        // Csak a TÉNYLEGES ciklusfutásokat számoljuk: egy 401/400 nem futás, és nem is a
        // ciklus hibája — ha ezeket is idekevernénk, a health egy elutasított idegen
        // hívástól úgy nézne ki, mintha a biztonsági háló hibázna.
        if (result.status === 200 || result.status === 500) {
          health.cycles += 1
          health.lastCycleAt = new Date().toISOString()
          health.lastCycleError = result.body.success ? null : result.body.error
        }
        if (!result.body.success) {
          console.error(`[dispatch-cycle-server] ${result.status} — ${result.body.error}`)
        }
        res.writeHead(result.status, {
          'content-type': 'application/json',
          // Melyik szolgáltatás szolgálta ki? A törzs (a szerződés) változatlan; ez a
          // fejléc az üzemeltető ellenőrző fogódzója: a Scheduler célja tényleg a
          // dedikált worker-e, vagy (rollback után) az UI. Enélkül a két válasz
          // megkülönböztethetetlen, és a szétválasztás csendben visszakophatna.
          'x-dispatch-cycle-service': 'worker',
        })
        res.end(JSON.stringify(result.body))
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        health.lastCycleError = message
        console.error('[dispatch-cycle-server] unhandled:', message)
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: message }))
      })
    return
  }

  // Cloud Run startup/liveness próba — a ciklus futásától függetlenül 200, hogy egy
  // hosszabb kör alatt se jelöljön a platform unhealthy-nek.
  if (req.method === 'GET' && (url === '/' || url === '/healthz')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', service: 'dispatch-cycle-worker', ...health }))
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ success: false, error: 'not found' }))
})

const port = Number(process.env.PORT ?? 8080)
server.listen(port, () => {
  console.log(`[dispatch-cycle-server] listening on :${port} — POST ${DISPATCH_CYCLE_PATH}`)
  if (!process.env.DISPATCHER_CONTROL_TOKEN?.trim()) {
    // Fail-closed: a végpont ilyenkor MINDEN hívásra 401-et ad. Nem állítjuk le a
    // processzt (a Cloud Run így is fel tud jönni és látszik a log), de a hiba
    // félreérthetetlen — enélkül a Scheduler futásai némán 401-en halnának.
    console.error(
      '[dispatch-cycle-server] FIGYELEM: DISPATCHER_CONTROL_TOKEN nincs beállítva — minden hívás 401 lesz.',
    )
  }
})

const shutdown = (signal: string) => {
  console.log(`[dispatch-cycle-server] shutting down (${signal})`)
  server.close(() => process.exit(0))
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
