'use server'

import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { fail, ok } from '@/lib/result'
import { setTenantThinkingTraceControlsSchema } from '@/lib/validators/actions'

/**
 * Chat "thinking-trace" spec §D7/WP-6 — tenant-szintű kapcsoló a modell
 * gondolkodási (reasoning) szövegének chat-megjelenítéséhez. Fail-closed,
 * alapból kikapcsolva; az állítás tenant-admin jog + auditált a service-ben.
 */
export async function getTenantThinkingTraceControls() {
  try {
    const ctx = await requireTenantRole('viewer')
    const controls = await services.platformSettings.getTenantThinkingTraceControls(ctx.activeTenantId!)
    return ok(controls)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült betölteni a thinking-trace vezérlőit')
  }
}

export async function setTenantThinkingTraceControls(input: unknown) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = setTenantThinkingTraceControlsSchema.parse(input)
    const controls = await services.platformSettings.setTenantThinkingTraceControls(
      ctx.activeTenantId!,
      parsed,
      ctx.user.id,
    )
    return ok(controls)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült menteni a thinking-trace vezérlőit')
  }
}
