/**
 * Publikus app origin proxy/CDN mögött (pl. Firebase App Hosting / Cloud Run).
 * A belső request.url gyakran localhost:8080 — redirectekhez ez nem használható.
 */
export function resolvePublicAppOrigin(request?: Request): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, '')
  if (fromEnv) return fromEnv

  if (request) {
    const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    if (forwardedHost) {
      const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? 'https'
      return `${proto}://${forwardedHost}`
    }
  }

  if (request) {
    const { origin, hostname } = new URL(request.url)
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') return origin
  }

  return 'http://localhost:3000'
}

export function publicAppUrl(path: string, request?: Request): URL {
  const normalized = path.startsWith('/') ? path : `/${path}`
  return new URL(normalized, resolvePublicAppOrigin(request))
}
