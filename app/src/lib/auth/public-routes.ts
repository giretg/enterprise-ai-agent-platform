/**
 * A Clerk auth-kaput MEGKERÜLŐ (publikus) route-minták EGYETLEN forrása.
 *
 * Miért külön modul: ez a lista egy csendes, éles üzemi kockázat hordozója MINDKÉT irányban.
 *  - Ha egy saját hitelesítésű gépi belépő KIMARAD innen, a Clerk `auth.protect()` a route
 *    handler ELŐTT utasítja el — a funkció némán, hibaüzenet nélkül halott lesz élesben
 *    (pontosan ez történt a bejövő Telegram-webhookkal: a felhasználói üzenetek ÉS a
 *    jóváhagyó-gomb döntések is elvesztek, miközben fejlesztői módban minden működött).
 *  - Ha egy minta TÚL TÁGRA sikerül, egy védendő route válik némán publikussá.
 *
 * Mindkét hiba a futó rendszerben nem látszik, ezért a listát regressziós teszt rögzíti
 * (`scripts/public-routes.test.ts`) — a `middleware.ts` maga nem tesztelhető közvetlenül
 * (a Next 16 a proxy/middleware fájlból egyetlen függvény-exportot vár).
 *
 * A listára KIZÁRÓLAG olyan route kerülhet, amely a saját kérés-hitelesítését maga végzi
 * (megosztott titok konstans idejű vetése, aláírt webhook, token-fejléc), vagy szándékosan
 * nyilvános (bejelentkezési oldalak, uptime-szondák).
 */
export const PUBLIC_ROUTE_PATTERNS = [
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/v1/agent(.*)',
  '/api/v1/gateway(.*)',
  '/api/v1/harness(.*)',
  // Cloud Scheduler → token auth a route handlerben (x-dispatcher-token), nem Clerk.
  '/api/v1/internal/dispatch-cycle(.*)',
  '/api/webhooks(.*)',
  // Bejövő csatorna-webhook (Telegram): a Clerk-munkamenet HELYETT a route saját, konstans
  // idejű megosztott-titok fejléce hitelesít (`x-telegram-bot-api-secret-token`).
  // SZŰKEN a `.../webhook` végpontra (és annak alútjaira) — így egy jövőbeli
  // `.../webhook-admin` vagy `.../config` csatorna-route NEM válik véletlenül publikussá.
  '/api/channels/(.*)/webhook',
  '/api/channels/(.*)/webhook/(.*)',
  // WP-6/WP-7: operatív endpointok auth nélkül (uptime-monitor / scrape).
  '/api/healthz(.*)',
  '/api/readyz(.*)',
  '/api/metrics(.*)',
  // Kereső-/bot-vezérlő fájlok: szándékosan nyilvánosak, tartalmuk nem érzékeny.
  // Enélkül a Clerk `auth.protect()` 404-et adna a `/robots.txt`-re, amit a
  // Googlebot „mindent szabad crawlolni"-ként értelmez (l. `src/app/robots.ts`).
  '/robots.txt',
  '/sitemap.xml',
] as const
