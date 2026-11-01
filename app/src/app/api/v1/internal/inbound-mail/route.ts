import { NextResponse } from 'next/server'
import { expectedSweepToken } from '@/domain/ai-audit/retention-request'
import { safeSecretEquals } from '@/lib/crypto/timing-safe'
import { writeAudit } from '@/lib/audit/types'
import { repositories } from '@/repositories/postgres'
import { inboundMail, inboundPollIntervalMs } from '@/lib/inbound-mail/deps'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const BUDGET_MS = 25_000

/**
 * #1032 OPCIONÁLIS gyakori hívás („éjjel is figyeljen”): a push nélküli postafiókok lekérdezése a cégek
 * beállított gyakorisága szerint, akkor is, ha senki nem használja a platformot. Nélküle a lekérdezés
 * a platform használata közben fut, a megújítás pedig a napi retenciós hívásban.
 * Cloud Scheduler, `x-dispatcher-token`. Csak akkor naplóz, ha történt valami.
 */
export async function POST(request: Request): Promise<Response> {
  const expected = expectedSweepToken()
  if (!expected || !safeSecretEquals(request.headers.get('x-dispatcher-token'), expected)) {
    return NextResponse.json({ ok: false, error: 'invalid or missing x-dispatcher-token' }, { status: 401 })
  }
  try {
    const { watcher, service } = inboundMail()
    const deadline = new Date(Date.now() + BUDGET_MS)
    const polled = await watcher.pollDue({ deadline, intervalMs: inboundPollIntervalMs })
    const reconciled = await service.reconcileClaimed(20)
    const summary = { ...polled, reconciled }
    if (polled.polled || polled.errors || reconciled.processed || reconciled.failed) {
      await writeAudit(repositories.audit, {
        actorType: 'system',
        action: 'inbound_mail.maintenance',
        targetType: 'inbound_mail_event',
        policyDecision: 'allowed',
        metadata: summary,
      })
    }
    return NextResponse.json({ ok: true, ...summary })
  } catch (error) {
    console.error('[inbound-mail] maintenance failed', error)
    return NextResponse.json({ ok: false, error: 'maintenance_failed' }, { status: 500 })
  }
}
