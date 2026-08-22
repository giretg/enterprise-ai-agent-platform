'use server'

import { requireTenantRole } from '@/auth/tenant-context'
import { resolveRunAnalysisEntry } from '@/lib/run-analysis-entry'
import { fail, ok } from '@/lib/result'

/** RA-08: chat-panel és egyéb kliens felületek — csak belépési pont, nem indít elemzést. */
export async function getRunAnalysisEntry() {
  try {
    const user = await requireTenantRole('viewer')
    const entry = await resolveRunAnalysisEntry({
      tenantId: user.activeTenantId,
      role: user.activeTenantRole,
    })
    return ok(entry)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'A futás-elemző belépési pont nem érhető el')
  }
}
