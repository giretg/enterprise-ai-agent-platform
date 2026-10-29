import { NextResponse } from 'next/server'
import { publicChatDeps } from '@/auth/public-chat-deps'
import { handlePublicChat } from '@/domain/public-chat/service'
import { resolvePublicAppOrigin } from '@/lib/public-app-url'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Proxy/CDN mögött a belső request.url más host — a böngésző-oldali hostokkal vetjük össze. */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true
  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return false
  }
  const hosts = [
    request.headers.get('x-forwarded-host')?.split(',')[0]?.trim(),
    request.headers.get('host'),
    new URL(resolvePublicAppOrigin(request)).host,
  ]
  return hosts.includes(host)
}

/** Bemeneti méretkorlát: üzenet ≤ 2000 karakter + kontextus ≤ 8 kB, bőven belefér. */
const MAX_BODY_BYTES = 32 * 1024

/**
 * #1016 nyilvános chat-végpont (auth nélkül): `op` = send | history | delete | ping.
 * Csak azonos eredetű hívás (a `/c/<slug>` oldal) — a widget is az iframe-en belülről hív.
 */
export async function POST(request: Request, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await context.params
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_BODY_BYTES) {
          await reader.cancel()
          return NextResponse.json({ error: 'bad_request' }, { status: 413 })
        }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
  }
  const text = Buffer.concat(chunks).toString('utf8')
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null
  const result = await handlePublicChat(publicChatDeps(), { slug, body, ip, origin: request.headers.get('referer') })
  return NextResponse.json(result.body, { status: result.status, headers: { 'cache-control': 'no-store' } })
}
