import { NextResponse } from 'next/server'
import { services } from '@/domain'

/**
 * Cookieless preview kiszolgálás (Feature-spec — App Registry §4.5, §6).
 *
 * NINCS requireRole / platform session — kizárólag a rövid életű, aláírt preview
 * token (?t=) alapján szolgál ki, így a preview izolált futtatási felület marad.
 * A token tenantId+appId+version+contentHash-re érvényes; a service ellenőrzi a
 * tenant-egyezést és a tartalom-integritást. Az A0 CSP tiltja a hálózatot, a
 * formot, az objektumot és a platform API-t (§6.3).
 */

function previewCsp(): string {
  const frameAncestors =
    process.env.SANDBOX_PREVIEW_FRAME_ANCESTORS ?? process.env.NEXT_PUBLIC_APP_URL ?? "'self'"
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "object-src 'none'",
    `frame-ancestors ${frameAncestors}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('t')
  if (!token) {
    return NextResponse.json({ success: false, error: 'Missing preview token' }, { status: 400 })
  }

  try {
    const { html } = await services.sandboxApps.servePreviewByToken(token)
    return new NextResponse(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': previewCsp(),
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : 'Preview failed' },
      { status: 403 },
    )
  }
}
