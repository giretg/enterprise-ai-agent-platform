import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { isClerkEnabled, isDevAuthAllowed } from '@/lib/clerk-config'
import { REQUEST_ID_HEADER, resolveRequestId } from '@/lib/observability/request-context'

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/v1/agent(.*)',
  '/api/v1/gateway(.*)',
  '/api/v1/harness(.*)',
  // Cloud Scheduler → token auth a route handlerben (x-dispatcher-token), nem Clerk.
  '/api/v1/internal/dispatch-cycle(.*)',
  '/api/webhooks(.*)',
  // Bejövő csatorna-webhook (Telegram): a Clerk-munkamenet HELYETT a route saját, konstans
  // idejű megosztott-titok fejléce hitelesít (`x-telegram-bot-api-secret-token`). Ha ez NEM
  // publikus route, a Clerk `auth.protect()` élesben MINDEN bejövő Telegram-hívást elutasít
  // (user-üzenetek ÉS jóváhagyó-gomb döntések) — a bejövő csatorna és a Telegram-jóváhagyás
  // némán halott lenne. (Ugyanaz a minta, mint a Clerk-webhook és a harness token-auth útjai.)
  // SZŰKEN a `.../webhook` végpontra (és annak alútjaira) — így egy jövőbeli
  // `.../webhook-admin` vagy `.../config` csatorna-route NEM válik véletlenül publikussá.
  '/api/channels/(.*)/webhook',
  '/api/channels/(.*)/webhook/(.*)',
  // WP-6/WP-7: operatív endpointok auth nélkül (uptime-monitor / scrape).
  '/api/healthz(.*)',
  '/api/readyz(.*)',
  '/api/metrics(.*)',
])

/**
 * WP-6 (O2): minden kérés kap `x-request-id`-t (a bejövot átvesszük, vagy
 * generálunk), és tovább is adjuk a válaszban, hogy a kliens/monitor korrelálhasson.
 */
function withRequestId(req: Request, res: NextResponse): NextResponse {
  const requestId = resolveRequestId(req.headers.get(REQUEST_ID_HEADER))
  res.headers.set(REQUEST_ID_HEADER, requestId)
  return res
}

export default clerkMiddleware(async (auth, req) => {
  if (!isClerkEnabled()) {
    if (!isDevAuthAllowed()) {
      return withRequestId(
        req,
        NextResponse.json({ error: 'Authentication is not configured' }, { status: 503 }),
      )
    }
    return withRequestId(req, NextResponse.next())
  }
  if (!isPublicRoute(req)) {
    await auth.protect()
  }
  return withRequestId(req, NextResponse.next())
})

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
