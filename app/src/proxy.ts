import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import createIntlMiddleware from 'next-intl/middleware'
import { isClerkEnabled, isDevAuthAllowed } from '@/lib/clerk-config'
import { embedHrefForPanel } from '@/lib/control-plane-embed'
import { REQUEST_ID_HEADER, resolveRequestId } from '@/lib/observability/request-context'
import { isPublicBrandingPath } from '@/lib/auth/public-branding'
import { PUBLIC_ROUTE_PATTERNS } from '@/lib/auth/public-routes'
import { localizedPublicPath, unprefixedAliasLocale, type PublicPathname } from '@/i18n/config'
import { routing } from '@/i18n/routing'
import {
  crawlerBlockUserAgent,
  isCrawlerAllowedPath,
  isCrawlerBlockEnabled,
  isCrawlerUserAgentBlockEnabled,
  isKnownCrawlerRequest,
} from '@/lib/security/crawler-block'

const intlMiddleware = createIntlMiddleware(routing)

// A minták (és a felvételük szabálya) a `public-routes.ts`-ben laknak, hogy regressziós
// teszt rögzíthesse őket — a proxy-fájl maga egyetlen függvényt exportálhat.
const isPublicRoute = createRouteMatcher([...PUBLIC_ROUTE_PATTERNS])

const ROBOTS_TAG_HEADER = 'X-Robots-Tag'
const ROBOTS_TAG_VALUE = 'noindex, nofollow, noarchive'

/**
 * WP-6 (O2): minden kérés kap `x-request-id`-t (a bejövot átvesszük, vagy
 * generálunk), és tovább is adjuk a válaszban, hogy a kliens/monitor korrelálhasson.
 *
 * #426: amíg az indexelés nincs szándékosan engedélyezve (`ALLOW_SEARCH_INDEXING`,
 * l. `crawler-block.ts` / `robots.ts`), minden válasz `X-Robots-Tag: noindex`-et
 * is kap — védőháló arra az esetre, ha egy útvonal a lenti UA-alapú bot-szűrőt
 * elkerülné (pl. egy magát nem bejelentő renderelő), a `robots.txt` mellett.
 */
function finishResponse(req: Request, res: NextResponse): NextResponse {
  const requestId = resolveRequestId(req.headers.get(REQUEST_ID_HEADER))
  res.headers.set(REQUEST_ID_HEADER, requestId)
  // A Google OAuth-verifikáció a honlapot és a privacy/ÁSZF oldalt olvassa —
  // ezeken a noindex-címke és a 403-as crawler-tiltás egyaránt elbukna.
  const pathname = new URL(req.url).pathname
  if (isCrawlerBlockEnabled() && !isPublicBrandingPath(pathname)) {
    res.headers.set(ROBOTS_TAG_HEADER, ROBOTS_TAG_VALUE)
  }
  // Beágyazott agent-chat (#481 D1): a route csak külön ablakban él, sosem iframe-ben —
  // idegen domain semmiképp ne tudja keretezni.
  if (pathname === '/embed/agents' || pathname.startsWith('/embed/agents/')) {
    res.headers.set('Content-Security-Policy', "frame-ancestors 'none'")
  }
  return res
}

export const proxy = clerkMiddleware(async (auth, req) => {
  const { pathname } = req.nextUrl

  // #426: a Clerk dev-instance URL-ben szállított munkamenetét a Googlebot
  // visszajátssza — a robots.txt (#420) ezt nem fogja meg, mert nem hozzáférés-
  // vezérlés. Ez a réteg a Clerk-kulcsváltástól függetlenül, azonnal leállítja
  // a magukat bejelentő crawlerek/renderelők hozzáférését — MIELŐTT a Clerk-
  // munkamenet (és a benne visszajátszott token) egyáltalán kiértékelődne.
  if (isCrawlerUserAgentBlockEnabled() && isKnownCrawlerRequest(req) && !isCrawlerAllowedPath(pathname)) {
    const blocked = NextResponse.json(
      { error: 'Crawlers are not allowed on this host' },
      { status: 403 },
    )
    // #436: a kiesés azért volt nehezen behatárolható, mert a válaszból nem derült ki,
    // MILYEN UA-t látott az origin (a CDN mögött ez nem a kliens UA-ja). A saját UA
    // visszatükrözése nem szivárogtat semmit, viszont egy curl-lel diagnosztizálhatóvá teszi.
    blocked.headers.set('x-crawler-block-ua', crawlerBlockUserAgent(req).slice(0, 120))
    return finishResponse(req, blocked)
  }

  const aliasLocale = unprefixedAliasLocale(pathname)
  if (aliasLocale) {
    const url = req.nextUrl.clone()
    url.pathname = localizedPublicPath(pathname.replace(/\/$/, '') as PublicPathname, aliasLocale)
    const requestHeaders = new Headers(req.headers)
    requestHeaders.set('x-next-intl-locale', aliasLocale)
    return finishResponse(req, NextResponse.rewrite(url, { request: { headers: requestHeaders } }))
  }

  if (pathname.startsWith('/embed/control-plane/')) {
    const panel = decodeURIComponent(pathname.slice('/embed/control-plane/'.length).split('/')[0] ?? '')
    const href = embedHrefForPanel(panel)
    if (href) {
      const url = req.nextUrl.clone()
      url.pathname = href
      const requestHeaders = new Headers(req.headers)
      requestHeaders.set('x-cp-embed', '1')
      return finishResponse(
        req,
        NextResponse.rewrite(url, { request: { headers: requestHeaders } }),
      )
    }
  }

  if (!isClerkEnabled()) {
    if (!isDevAuthAllowed()) {
      return finishResponse(
        req,
        NextResponse.json({ error: 'Authentication is not configured' }, { status: 503 }),
      )
    }
    if (isPublicBrandingPath(pathname)) {
      return finishResponse(req, intlMiddleware(req))
    }
    return finishResponse(req, NextResponse.next())
  }
  if (!isPublicRoute(req)) {
    await auth.protect()
  }
  if (isPublicBrandingPath(pathname)) {
    return finishResponse(req, intlMiddleware(req))
  }
  return finishResponse(req, NextResponse.next())
})

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
