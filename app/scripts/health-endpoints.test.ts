/**
 * WP-7 (O3) — Health-endpoint tesztek.
 *
 * A liveness (`/api/healthz`) DB nélkül is 200-at ad; a readiness (`/api/readyz`)
 * elérhetetlen DB esetén 503-at (a stub DATABASE_URL nem elérheto → a `$queryRaw`
 * dob → a route lezárja a hibát és 503-mal jelez). Futtatás:
 *   npm run test:health-endpoints
 */
import assert from 'node:assert/strict'
import { GET as healthzGet } from '../src/app/api/healthz/route'
import { GET as readyzGet } from '../src/app/api/readyz/route'

// A `@/lib/db` proxy háttérben (fire-and-forget) lekérdezi az aktív DB-módot; a
// stub DATABASE_URL elérhetetlen → várt rejection, ami nem a WP-7 tárgya. Elnyeljük,
// hogy ne bukhasson a folyamat a tesztek sikeres lefutása UTÁN.
process.on('unhandledRejection', () => {})

let passed = 0
let failed = 0

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
    passed += 1
  } catch (e) {
    console.log(`  FAIL  ${name} — ${e instanceof Error ? e.message : String(e)}`)
    failed += 1
  }
}

async function main() {
  await check('healthz: 200 státusz DB nélkül is (liveness olcsó)', async () => {
    const res = healthzGet()
    assert.equal(res.status, 200)
    const body = (await res.json()) as { status: string; ts: number }
    assert.equal(body.status, 'ok')
    assert.equal(typeof body.ts, 'number')
  })

  await check('readyz: 503 elérhetetlen DB esetén (readiness DB-t ellenoriz)', async () => {
    const res = await readyzGet()
    assert.equal(res.status, 503)
    const body = (await res.json()) as { status: string; error?: string }
    assert.equal(body.status, 'unready')
    assert.ok(body.error && body.error.length > 0, 'a hibaüzenet szerepel a válaszban')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  // Explicit kilépés: a háttér DB-mode poll nyitva tartaná / megzavarhatná a folyamatot.
  process.exit(failed > 0 ? 1 : 0)
}

void main()
