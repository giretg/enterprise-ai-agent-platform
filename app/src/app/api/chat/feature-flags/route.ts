import { NextResponse } from 'next/server'
import { continuationDeps } from '@/auth/platform-chat-deps'
import { readTurnFeatureFlags } from '@/domain/platform-chat/session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** #1126 WP-5: a worker lépésenként innen tudja meg, hogy a futás közben leállították-e egy flagjét. */
export async function GET(request: Request): Promise<Response> {
  const result = await readTurnFeatureFlags(continuationDeps(), {
    authorizationHeader: request.headers.get('authorization'),
  })
  if (!result.ok) return NextResponse.json({ error: result.code }, { status: result.code === 'unauthenticated' ? 401 : 503 })
  return NextResponse.json({ featureFlags: result.featureFlags }, { headers: { 'cache-control': 'no-store' } })
}
