/**
 * Dispatch-ciklus végpont smoke (#114) — a Scheduler-célzott HTTP utat igazolja.
 *
 * Mit IGAZOL:
 *   1. token NÉLKÜL a végpont 401-et ad (idegen hívó nem indíthat ciklust),
 *   2. érvényes tokennel lefut a ciklus, és `DispatchCycleSummary`-t ad vissza,
 *   3. a futás nyoma megjelenik a `platform_settings` `dispatcher.last_cycle` rekordjában
 *      (tehát a cél szolgáltatás UGYANAZT a Neon adatbázist látja, mint az UI — enélkül a
 *      admin panel „Worker-folyamatok" sora némán elavulna, és senki nem venné észre, hogy
 *      a biztonsági háló másik adatbázison dolgozik).
 *
 * EZ NEM a legacy `dispatcher-cloud-run-smoke.ts`: az a wiki-harness LISTEN/NOTIFY workert
 * méri (pg_notify → állandó kapcsolat). Ez a stateless HTTP ciklust.
 *
 * Futtatás (a Scheduler céljára mutatva):
 *   DISPATCH_CYCLE_TARGET_URL=https://platform-dispatch-cycle-… \
 *   DISPATCHER_CONTROL_TOKEN=… npm run dispatch-cycle:smoke
 *
 * Ha a cél nem publikus (--no-allow-unauthenticated), adj hozzá egy identity tokent:
 *   DISPATCH_CYCLE_AUTH_BEARER="$(gcloud auth print-identity-token --audiences=<URL>)"
 */
import './load-env'

// A `platform_settings` MINDIG az éles (config) branch-en él — a ciklus lenyomatát ott kell
// keresni, függetlenül attól, hogy a platform épp éles vagy teszt adat-módban fut.
import { configPrisma } from '../src/lib/db'

const TARGET_BASE_URL = (
  process.env.DISPATCH_CYCLE_TARGET_URL ??
  process.env.PLATFORM_API_URL ??
  ''
).replace(/\/$/, '')
const TOKEN = process.env.DISPATCHER_CONTROL_TOKEN?.trim() ?? ''
const BEARER = process.env.DISPATCH_CYCLE_AUTH_BEARER?.trim()
const LAST_CYCLE_KEY = 'dispatcher.last_cycle'

function fail(message: string): never {
  console.error(`[dispatch-cycle-smoke] ❌ ${message}`)
  process.exit(1)
}

function baseHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (BEARER) headers.authorization = `Bearer ${BEARER}`
  return headers
}

async function readLastCycleRanAt(): Promise<string | null> {
  const row = await configPrisma.platformSetting.findUnique({ where: { key: LAST_CYCLE_KEY } })
  const value = row?.value as { ranAt?: unknown } | null
  return typeof value?.ranAt === 'string' ? value.ranAt : null
}

async function main() {
  if (!TARGET_BASE_URL) fail('DISPATCH_CYCLE_TARGET_URL (vagy PLATFORM_API_URL) kötelező')
  if (!TOKEN) fail('DISPATCHER_CONTROL_TOKEN kötelező (egyezzen a cél szolgáltatáséval)')

  const url = `${TARGET_BASE_URL}/api/v1/internal/dispatch-cycle`
  console.log(`[dispatch-cycle-smoke] cél: ${url}`)

  // 1) Token nélkül → 401. Ha ez ÁTMEGY, a végpont védtelen — azonnal álljunk meg.
  const unauth = await fetch(url, { method: 'POST', headers: baseHeaders(), body: '{}' })
  if (unauth.status !== 401) {
    fail(`token nélkül ${unauth.status} jött 401 helyett — a végpont nincs megfelelően védve`)
  }
  console.log('[dispatch-cycle-smoke] ✅ token nélkül 401')

  const before = await readLastCycleRanAt()

  // 2) Érvényes tokennel → 200 + summary.
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...baseHeaders(), 'x-dispatcher-token': TOKEN },
    body: '{}',
  })
  const text = await response.text()
  if (response.status === 403) {
    fail(
      `403 — a Cloud Run IAM utasította el a hívást a végpont előtt. A hívó identitásnak ` +
        `run.invoker jog kell a szolgáltatáson (Scheduler: SCHEDULER_OIDC_SERVICE_ACCOUNT).`,
    )
  }
  if (!response.ok) fail(`${response.status} — ${text.slice(0, 400)}`)

  let payload: { success?: boolean; data?: Record<string, unknown> }
  try {
    payload = JSON.parse(text)
  } catch {
    fail(`a válasz nem JSON: ${text.slice(0, 200)}`)
  }
  if (payload.success !== true || !payload.data) fail(`váratlan válasz: ${text.slice(0, 300)}`)

  // A summary alakja a szerződés része — a hiányzó mező azt jelenti, hogy a cél NEM a
  // dispatch-ciklust szolgálja ki (pl. rossz URL-re mutat a Scheduler).
  for (const field of ['dispatch', 'monitorSweep', 'channelTurns', 'workspacePurge'] as const) {
    if (!(field in payload.data)) fail(`hiányzó summary mező: ${field}`)
  }
  console.log(`[dispatch-cycle-smoke] ✅ 200 + DispatchCycleSummary: ${JSON.stringify(payload.data)}`)

  // Melyik szolgáltatás felelt? Ez a spec elfogadási kritériuma: a ciklust a dedikált
  // workernek kell kiszolgálnia, nem az UI konténerének.
  const servedBy = response.headers.get('x-dispatch-cycle-service') ?? 'ismeretlen'
  console.log(`[dispatch-cycle-smoke] kiszolgáló: ${servedBy}`)
  if (process.env.DISPATCH_CYCLE_EXPECT_WORKER === '1' && servedBy !== 'worker') {
    fail(
      `a hívást a(z) "${servedBy}" szolgáltatás szolgálta ki, nem a dedikált worker — a ` +
        `Scheduler célja valószínűleg még az UI-ra mutat (vagy aktív a rollback)`,
    )
  }

  // 3) A futás nyoma ugyanabban az adatbázisban, amit ez a szkript (és az admin UI) lát.
  const after = await readLastCycleRanAt()
  if (!after) {
    fail(
      `a ${LAST_CYCLE_KEY} rekord hiányzik — a cél szolgáltatás valószínűleg MÁS adatbázist ` +
        `lát, mint amire ez a szkript csatlakozik (env-paritás!)`,
    )
  }
  if (before && after === before) {
    fail(
      `a ${LAST_CYCLE_KEY} nem frissült (${after}) — a ciklus nem ebbe az adatbázisba írt, ` +
        `vagy a summary rögzítése elhasalt`,
    )
  }
  console.log(`[dispatch-cycle-smoke] ✅ ${LAST_CYCLE_KEY} frissült: ${after}`)
  console.log('[dispatch-cycle-smoke] PASS — a Scheduler-célzott ciklus a feladatát teljesíti.')
}

main()
  .then(async () => {
    await configPrisma.$disconnect()
    process.exit(0)
  })
  .catch(async (e) => {
    console.error('[dispatch-cycle-smoke] fatal:', e instanceof Error ? e.message : e)
    await configPrisma.$disconnect()
    process.exit(1)
  })
