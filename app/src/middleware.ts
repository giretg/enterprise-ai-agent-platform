import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { isClerkEnabled, isDevAuthAllowed } from '@/lib/clerk-config'
import { REQUEST_ID_HEADER, resolveRequestId } from '@/lib/observability/request-context'
import { PUBLIC_ROUTE_PATTERNS } from '@/lib/auth/public-routes'

// A minták (és a felvételük szabálya) a `public-routes.ts`-ben laknak, hogy regressziós
// teszt rögzíthesse őket — a middleware-fájl maga egyetlen függvényt exportálhat.
const isPublicRoute = createRouteMatcher([...PUBLIC_ROUTE_PATTERNS])

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
