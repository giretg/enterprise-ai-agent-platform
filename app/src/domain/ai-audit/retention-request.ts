/**
 * A retenciós sweep HTTP-szerződése (#759) — transzport-független, DB nélkül tesztelhető.
 *
 * A legacy `retentionSweep` tanulsága (#117): a függvény önmagában nem elég, kell
 * élő hívó. Ez a szerződés a Cloud Scheduler → `POST /api/v1/internal/ai-audit-retention`
 * belépője; a token-ellenőrzés itt van, a route csak adapter.
 */
import { safeSecretEquals } from '@/lib/crypto/timing-safe'

export type RetentionSweepRunner = () => Promise<{ deleted: number }>

export type RetentionHttpRequest = {
  providedToken: string | null
  expectedToken?: string | null
}

export type RetentionHttpResponse = {
  status: number
  body: { ok: true; deleted: number } | { ok: false; error: string }
}

function failure(status: number, error: string): RetentionHttpResponse {
  return { status, body: { ok: false, error } }
}

export function expectedSweepToken(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return (env.AI_AUDIT_SWEEP_TOKEN ?? env.DISPATCHER_CONTROL_TOKEN)?.trim() || undefined
}

export async function handleAiAuditRetentionRequest(
  request: RetentionHttpRequest,
  sweep: RetentionSweepRunner,
): Promise<RetentionHttpResponse> {
  const expectedToken = request.expectedToken ?? expectedSweepToken()
  if (!expectedToken || !safeSecretEquals(request.providedToken, expectedToken)) {
    return failure(401, 'invalid or missing x-dispatcher-token')
  }
  try {
    const result = await sweep()
    return { status: 200, body: { ok: true, deleted: result.deleted } }
  } catch (e) {
    return failure(500, e instanceof Error ? e.message : 'retention sweep failed')
  }
}
