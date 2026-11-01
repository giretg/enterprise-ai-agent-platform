import { NextResponse } from 'next/server'
import { expectedSweepToken } from '@/domain/ai-audit/retention-request'
import { safeSecretEquals } from '@/lib/crypto/timing-safe'
import { writeAudit } from '@/lib/audit/types'
import { repositories } from '@/repositories/postgres'
import { inboundMail } from '@/lib/inbound-mail/deps'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const BUDGET_MS = 25_000

/**
 * #1032 bejövő levelek karbantartása — Cloud Scheduler 5 percenként, `x-dispatcher-token`-nel
 * (ugyanaz a titok, mint a napi retenciós hívásé). Push-feliratkozás + megújítás, tartalék polling
 * modellhívás nélkül, és a futó feldolgozások állapotának átvétele.
 */
export async function POST(request: Request): Promise<Response> {
  const expected = expectedSweepToken()
  if (!expected || !safeSecretEquals(request.headers.get('x-dispatcher-token'), expected)) {
    return NextResponse.json({ ok: false, error: 'invalid or missing x-dispatcher-token' }, { status: 401 })
  }
  try {
    const summary = await inboundMail().watcher.runMaintenance({ deadline: new Date(Date.now() + BUDGET_MS) })
    await writeAudit(repositories.audit, {
      actorType: 'system',
      action: 'inbound_mail.maintenance',
      targetType: 'inbound_mail_event',
      policyDecision: 'allowed',
      metadata: summary,
    })
    return NextResponse.json({ ok: true, ...summary })
  } catch (error) {
    console.error('[inbound-mail] maintenance failed', error)
    return NextResponse.json({ ok: false, error: 'maintenance_failed' }, { status: 500 })
  }
}
