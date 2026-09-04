/**
 * Publikus (Clerk-kaput megkerülő) route-minták — DB és hálózat nélküli regressziós tesztek.
 *
 * Miért létezik ez a teszt: a bejövő Telegram-webhook azért volt élesben NÉMÁN HALOTT, mert a
 * route kimaradt a publikus allowlistből — a Clerk `auth.protect()` a handler előtt elutasított
 * minden bejövő hívást (felhasználói üzenet ÉS jóváhagyó-gomb döntés), miközben a fejlesztői
 * módban (Clerk kikapcsolva) minden hibátlanul működött. Ez a hibaosztály se tesztben, se
 * kódolvasáskor nem látszik — csak élesben, elveszett üzenetek formájában.
 *
 * Amit a tesztek rögzítenek:
 *  (1) minden saját hitelesítésű gépi belépő TÉNYLEG publikus (nem hal el a Clerk-kapun),
 *  (2) a minták NEM tágabbak a kelleténél (szomszédos, védendő route nem válik publikussá),
 *  (3) a rendes alkalmazás-felület védett marad.
 *
 * A minta-szintaxist a Clerk SAJÁT `createRouteMatcher`-ével értékeljük ki (nem újraimplementált
 * regexszel), így a teszt egy Clerk-frissítéskori szintaxis-változást is elkap.
 *
 * Futtatás: npm run test:public-routes
 */
import assert from 'node:assert/strict'
import { createRouteMatcher } from '@clerk/nextjs/server'
import { NextRequest } from 'next/server'
import { PUBLIC_ROUTE_PATTERNS } from '../src/lib/auth/public-routes'

let passed = 0
let failed = 0

function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
    passed += 1
  } catch (e) {
    console.log(`  FAIL  ${name} — ${e instanceof Error ? e.message : String(e)}`)
    failed += 1
  }
}

const isPublicRoute = createRouteMatcher([...PUBLIC_ROUTE_PATTERNS])

function isPublic(path: string): boolean {
  return isPublicRoute(new NextRequest(new Request(`https://example.com${path}`, { method: 'POST' })))
}

function assertPublic(path: string) {
  assert.equal(isPublic(path), true, `${path} PUBLIKUS kell legyen, de a Clerk-kapu védettnek látja`)
}

function assertProtected(path: string) {
  assert.equal(isPublic(path), false, `${path} VÉDETT kell maradjon, de publikusnak minősül`)
}

// PR-1 — a konkrét éles hiba, ami ezt a tesztet kiváltotta.
check('a bejövő csatorna-webhook publikus (különben a Telegram-csatorna némán halott)', () => {
  assertPublic('/api/channels/telegram/webhook')
})

check('a webhook alútjai is publikusak (jövőbeli al-belépők ugyanazon a titok-vetésen)', () => {
  assertPublic('/api/channels/telegram/webhook/')
  assertPublic('/api/channels/telegram/webhook/callback')
})

// PR-2 — a minta ne legyen tágabb a kelleténél: a szomszédos, KEZELŐI route-ok védettek.
check('a csatorna szomszédos, kezelői route-jai NEM válnak publikussá', () => {
  assertProtected('/api/channels/telegram/webhook-admin')
  assertProtected('/api/channels/telegram/config')
  assertProtected('/api/channels/telegram')
  assertProtected('/api/channels')
})

// PR-3 — a többi saját hitelesítésű gépi belépő is átjut a kapun.
check('a saját hitelesítésű gépi belépők publikusak (token/aláírás a handlerben)', () => {
  assertPublic('/api/v1/agent/chat')
  assertPublic('/api/v1/gateway/messages')
  assertPublic('/api/v1/harness/complete')
  assertPublic('/api/v1/internal/dispatch-cycle')
  assertPublic('/api/webhooks/clerk')
})

check('az operatív szondák publikusak (uptime-monitor / scrape)', () => {
  assertPublic('/api/healthz')
  assertPublic('/api/readyz')
  assertPublic('/api/metrics')
})

check('a bot-vezérlő fájlok publikusak (különben a Clerk 404-et ad rájuk)', () => {
  assertPublic('/robots.txt')
  assertPublic('/sitemap.xml')
})

check('a bot-fájl minták NEM tágabbak a kelleténél', () => {
  assertProtected('/robots.txt/secret')
  assertProtected('/api/robots.txt')
  assertProtected('/sitemap.xml/leak')
})

// PR-4 — a rendes alkalmazás-felület és a kezelői API védett marad.
check('az alkalmazás-felület és a kezelői API VÉDETT marad', () => {
  assertProtected('/')
  assertProtected('/dashboard')
  assertProtected('/api/agents')
  assertProtected('/api/v1/internal/other-endpoint')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
