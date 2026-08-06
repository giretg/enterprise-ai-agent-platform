'use server'

import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { fail, ok } from '@/lib/result'
import { conversationIdSchema, ticketIdSchema } from '@/lib/validators/actions'

/**
 * Admin debug-pack: beszélgetés telemetria (fordulók, model/tool, audit,
 * kapcsolt ticketek) egy JSON fájlban. Nyers chat- és modell-tartalmat nem tartalmaz.
 */
export async function exportConversationDebugLog(input: { conversationId: string }) {
  try {
    const ctx = await requireTenantRole('admin')
    const { conversationId } = conversationIdSchema.parse(input)
    const file = await services.debugLogExport.exportConversation({
      conversationId,
      tenantId: ctx.activeTenantId,
      actorId: ctx.user.id,
    })
    return ok(file)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült a beszélgetés debug-log exportja')
  }
}

/**
 * Admin debug-pack: ticket telemetria (átmenetek, model/tool, audit,
 * opcionális kapcsolt beszélgetés) egy JSON fájlban, nyers tartalom nélkül.
 */
export async function exportTicketDebugLog(input: { id: string }) {
  try {
    const ctx = await requireTenantRole('admin')
    const { id } = ticketIdSchema.parse(input)
    const file = await services.debugLogExport.exportTicket({
      ticketId: id,
      tenantId: ctx.activeTenantId,
      actorId: ctx.user.id,
    })
    return ok(file)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült a ticket debug-log exportja')
  }
}
