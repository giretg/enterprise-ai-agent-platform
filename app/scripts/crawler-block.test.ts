/**
 * #426 — a Googlebot a Clerk dev-instance URL-ben szállított munkamenetét
 * visszajátssza, hitelesített operátorként futtatva a control-plane-t.
 * A `robots.txt` (#420) ezt nem fogja meg (nem hozzáférés-vezérlés).
 *
 * Ez a teszt a UA-alapú crawler-tiltó réteget rögzíti (`src/lib/security/crawler-block.ts`):
 *  (1) egy magát bejelentő crawler minden VÉDETT útvonalon elutasított,
 *  (2) a szándékosan publikus bot-vezérlő/uptime-fájlokon a crawler is átjut,
 *  (3) valódi böngésző-UA sosem esik a szűrőn,
 *  (4) `ALLOW_SEARCH_INDEXING=true` a bot-tiltást is kikapcsolja (egy kapcsoló
 *      vezérli a `robots.txt`-et és ezt a réteget is, l. `crawler-block.ts`).
 *
 * Futtatás: npm run test:crawler-block
 */
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import {
  isCrawlerAllowedPath,
  isCrawlerBlockEnabled,
  isCrawlerUserAgentBlockEnabled,
  isKnownCrawlerRequest,
} from '../src/lib/security/crawler-block'

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

function requestWithUserAgent(userAgent: string): NextRequest {
  const headers = userAgent ? { 'user-agent': userAgent } : undefined
  return new NextRequest(new Request('https://example.com/', { headers }))
}

const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
const BINGBOT_UA = 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const SAFARI_IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const FIREFOX_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0'

// #426 — a konkrét éles incidens: a Googlebot UA-ja felismerve.
check('a Googlebot UA-ja crawlerként ismert fel', () => {
  assert.equal(isKnownCrawlerRequest(requestWithUserAgent(GOOGLEBOT_UA)), true)
})

// #436 REGRESSZIÓ: a csupasz `Google` UA-t crawlernek venni TELJES kiesést okozott.
// Az App Hosting CDN / Google-frontend az origin felé ezzel az UA-val megy MINDEN
// valódi felhasználói kérésnél is, ezért a `google` ág 403-at adott az egész hoston
// (üres UA-val is), miközben lokálisan — CDN nélkül — a szűrő helyesnek látszott.
check('a csupasz `Google` UA (App Hosting CDN origin-lekérés) NEM crawler', () => {
  assert.equal(isKnownCrawlerRequest(requestWithUserAgent('Google')), false)
})

check('a konkrét Google-crawler termék-tokenek viszont crawlerek', () => {
  assert.equal(isKnownCrawlerRequest(requestWithUserAgent('Google-InspectionTool')), true)
  assert.equal(isKnownCrawlerRequest(requestWithUserAgent('GoogleOther')), true)
  assert.equal(isKnownCrawlerRequest(requestWithUserAgent('Google-Extended')), true)
  assert.equal(isKnownCrawlerRequest(requestWithUserAgent('AdsBot-Google')), true)
})

check('más ismert kereső-crawlerek (Bingbot) UA-ja is felismert', () => {
  assert.equal(isKnownCrawlerRequest(requestWithUserAgent(BINGBOT_UA)), true)
})

check('valódi böngésző-UA (Chrome, Safari/iOS, Firefox) SOSEM crawler', () => {
  assert.equal(isKnownCrawlerRequest(requestWithUserAgent(CHROME_UA)), false)
  assert.equal(isKnownCrawlerRequest(requestWithUserAgent(SAFARI_IOS_UA)), false)
  assert.equal(isKnownCrawlerRequest(requestWithUserAgent(FIREFOX_UA)), false)
})

check('User-Agent fejléc hiánya nem minősül crawlernek', () => {
  assert.equal(isKnownCrawlerRequest(requestWithUserAgent('')), false)
})

// A védett alkalmazás-felület: a crawlernek itt NEM szabad átjutnia.
check('a rendes alkalmazás-felület és a kezelői API a crawler elől is zárva marad', () => {
  assert.equal(isCrawlerAllowedPath('/'), false)
  assert.equal(isCrawlerAllowedPath('/dashboard'), false)
  assert.equal(isCrawlerAllowedPath('/control-plane/agents/abc/chat'), false)
  assert.equal(isCrawlerAllowedPath('/api/v1/agent-chat/stream'), false)
  assert.equal(isCrawlerAllowedPath('/api/v1/conversations/abc/workspace/files'), false)
})

// A szándékosan publikus bot-vezérlő fájlok + uptime-szondák: itt a crawler is átjut.
check('a bot-vezérlő fájlok és uptime-szondák a crawler elől is nyitva maradnak', () => {
  assert.equal(isCrawlerAllowedPath('/robots.txt'), true)
  assert.equal(isCrawlerAllowedPath('/sitemap.xml'), true)
  assert.equal(isCrawlerAllowedPath('/api/healthz'), true)
  assert.equal(isCrawlerAllowedPath('/api/readyz'), true)
})

check('a publikus minták NEM tágabbak a kelleténél', () => {
  assert.equal(isCrawlerAllowedPath('/robots.txt-secret'), false)
  assert.equal(isCrawlerAllowedPath('/api/healthzzz'), false)
})

// Egy kapcsoló vezérli a `robots.txt` indexelés-tiltását ÉS ezt a réteget (l. `src/app/robots.ts`).
check('ALLOW_SEARCH_INDEXING=true kikapcsolja a bot-tiltást is', () => {
  const prev = process.env.ALLOW_SEARCH_INDEXING
  try {
    delete process.env.ALLOW_SEARCH_INDEXING
    assert.equal(isCrawlerBlockEnabled(), true)
    process.env.ALLOW_SEARCH_INDEXING = 'true'
    assert.equal(isCrawlerBlockEnabled(), false)
  } finally {
    if (prev === undefined) delete process.env.ALLOW_SEARCH_INDEXING
    else process.env.ALLOW_SEARCH_INDEXING = prev
  }
})

// #436: a UA-szűrőnek külön vészkapcsolója van, hogy egy téves minta esetén a hostot
// az indexelés-tiltás feláldozása nélkül is vissza lehessen kapcsolni.
check('DISABLE_CRAWLER_UA_BLOCK=true csak a UA-szűrőt kapcsolja ki, az indexelés-tiltást nem', () => {
  const prev = process.env.DISABLE_CRAWLER_UA_BLOCK
  try {
    delete process.env.DISABLE_CRAWLER_UA_BLOCK
    assert.equal(isCrawlerUserAgentBlockEnabled(), true)
    process.env.DISABLE_CRAWLER_UA_BLOCK = 'true'
    assert.equal(isCrawlerUserAgentBlockEnabled(), false)
    assert.equal(isCrawlerBlockEnabled(), true)
  } finally {
    if (prev === undefined) delete process.env.DISABLE_CRAWLER_UA_BLOCK
    else process.env.DISABLE_CRAWLER_UA_BLOCK = prev
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
