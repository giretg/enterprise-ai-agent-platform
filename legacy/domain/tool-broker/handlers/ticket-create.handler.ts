import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

/**
 * ticket_create — agent-ág. A cross-tenant felelos-hozzárendelés őre + a ticket
 * felvétele a keret `ticketCreate` metódusában él (tenant-izoláció).
 */
export const ticketCreateHandler: ToolHandler = {
  id: 'ticket_create',
  handles(tool) {
    return tool === 'ticket_create'
  },
  async execute({ ctx, input, actingTenantId, actingUserId }: ToolHandlerArgs) {
    if (input.tool !== 'ticket_create') throw new Error(`ticket_create handler received ${input.tool}`)
    return ctx.ticketCreate(
      { ...input, actingUserId: actingUserId ?? input.actingUserId },
      actingTenantId,
    )
  },
}
