import type { NextRequest } from 'next/server'
import { isPublicBrandingPath } from '@/lib/auth/public-branding'

/**
 * Ismert kereső-/előnézet-crawlerek felismerése és korai elutasítása.
 *
 * MIÉRT (#426): a deployolt platform Clerk **development instance** kulcsokkal
 * fut, ezért a bejelentkezett munkamenet az URL-ben utazik
 * (`__clerk_handshake` / `__clerk_db_jwt`). A Googlebot beindexelt egy ilyen
 * hitelesített linket, és azóta rendszeresen VISSZAJÁTSSZA a benne lévő élő
 * munkamenetet — hitelesített operátorként futtatva a control-plane-t
 * (agent-chat, workspace-fájl olvasás, `board_write` írás).
 *
 * A `robots.txt` (`Disallow: /`, #420) ezt NEM fogja meg: az csak az ÚJ
 * crawlolást tiltja, a már beindexelt, tokent tartalmazó URL-t a bot
 * továbbra is újra lekéri, és amíg a session él, a válasz 200 marad — ezt a
 * #426 09-06-i utómérése bizonyította (a robots.txt élesítése után is
 * emelkedett a bot-forgalom és folytatódtak az authentikált írások).
 *
 * Ez a szűrő a Clerk-kulcsváltástól (a tényleges gyökér-ok javításától)
 * FÜGGETLEN, azonnal élesíthető védelmi réteg: minden magát bejelentő
 * kereső-/előnézet-botot elutasítunk, mielőtt a Clerk-munkamenet
 * egyáltalán kiértékelődne — így a visszajátszott token sem ér célba.
 * Mellékhatásként ez a tartós 4xx a deindexelést is felgyorsítja (a Google a
 * tartós hibaválaszt törlési jelként kezeli), és valódi böngésző-forgalmat
 * nem érint.
 *
 * KORLÁT: ez UA-alapú, tehát a SZÁNDÉKOS UA-hamisítással érkező visszajátszást
 * nem fogja meg — csak a ténylegesen magát bejelentő crawlert (jelen
 * incidensben pontosan ez történt: a kérések UA-ja "Google" / Googlebot volt).
 * A gyökér-ok javítása (Clerk production instance + session-revoke) emberi
 * lépés marad, lásd #426.
 */
// FIGYELEM (#436 utóélet): a minta SOSEM tartalmazhat csupasz `google` ágat.
// A #426-os naplóban látott, szó szerint `Google` UA NEM a Googlebot volt, hanem a
// Firebase App Hosting CDN / Google-frontend origin-lekérése: az élesben a Cloud Run
// origin ezt látja MINDEN valódi felhasználói kérésnél is. A csupasz `google` ág ezért
// 100%-ban kizárta a böngészőket (az egész host 403 lett, üres UA-val is), miközben
// lokálisan — CDN nélkül, ahol a kliens UA-ja ér be — a szűrő helyesen viselkedett.
// Google-crawlereket csak a konkrét termék-tokenekkel szabad felismerni (lentebb),
// ezek egyikét sem küldi sem a böngésző, sem a Google saját infrastruktúrája.
const CRAWLER_USER_AGENT_PATTERN =
  /bot|crawler|spider|slurp|facebookexternalhit|embedly|quora link preview|showyoubot|outbrain|pinterest\/|pingdom|ia_archiver|whatsapp|telegrambot|bytespider|ccbot|google-inspectiontool|googleother|google-extended|apis-google|mediapartners-google|feedfetcher-google|google-read-aloud|google favicon|googleweblight/i

/**
 * Ezeken az útvonalakon a bejelentett crawler is átengedett: a szándékosan
 * publikus bot-vezérlő fájlok (`src/app/robots.ts`), az uptime-szondák, és a
 * Google OAuth branding-oldalak (honlap / adatvédelem / ÁSZF). A `/` itt
 * PONTOS gyökér, nem prefix — különben az egész host nyitva lenne.
 * SZŰKEBB, mint `PUBLIC_ROUTE_PATTERNS` — a saját hitelesítésű gépi belépőket
 * (pl. `/api/v1/agent(.*)`) egy crawler-nek NEM kell tudnia elérni.
 */
export const CRAWLER_ALWAYS_ALLOWED_PATHS = ['/robots.txt', '/sitemap.xml', '/api/healthz', '/api/readyz'] as const

export function isCrawlerAllowedPath(pathname: string): boolean {
  if (isPublicBrandingPath(pathname)) return true
  return CRAWLER_ALWAYS_ALLOWED_PATHS.some(
    (allowed) => pathname === allowed || pathname.startsWith(`${allowed}/`),
  )
}

export function crawlerBlockUserAgent(req: Pick<NextRequest, 'headers'>): string {
  return req.headers.get('user-agent') ?? ''
}

export function isKnownCrawlerRequest(req: Pick<NextRequest, 'headers'>): boolean {
  return CRAWLER_USER_AGENT_PATTERN.test(crawlerBlockUserAgent(req))
}

/**
 * Egy kapcsoló vezérli a bot-tiltást ÉS a `robots.txt`/`X-Robots-Tag`
 * indexelés-tiltást (`src/app/robots.ts`): ha valaha lesz szándékosan
 * publikus, kereshető felület ezen a hoston, `ALLOW_SEARCH_INDEXING=true`
 * mindkettőt egyszerre kapcsolja vissza — nem lehet az egyiket elfelejteni.
 */
export function isCrawlerBlockEnabled(): boolean {
  return process.env.ALLOW_SEARCH_INDEXING !== 'true'
}

/**
 * Külön vészkapcsoló CSAK a UA-alapú tiltásra. A #436 kiesésekor az egyetlen
 * kapcsoló (`ALLOW_SEARCH_INDEXING`) egyben az indexelést is visszakapcsolta volna,
 * ezért nem lehetett vele gyorsan visszaállítani a hostot. Ezzel a UA-szűrő
 * (deploy nélkül, env-ből) kikapcsolható úgy, hogy a `robots.txt` / `X-Robots-Tag`
 * indexelés-tiltás érvényben marad.
 */
export function isCrawlerUserAgentBlockEnabled(): boolean {
  return isCrawlerBlockEnabled() && process.env.DISABLE_CRAWLER_UA_BLOCK !== 'true'
}
