import { prisma } from '@/lib/db'

/** Postgres NOTIFY csatorna — a dispatcher worker LISTEN-eli. */
export const DISPATCH_NOTIFY_CHANNEL = 'dispatch_ticket_ready'

/** Értesíti a dispatcher workert, hogy egy ready ticket indítható. */
export async function notifyTicketReady(ticketId: string): Promise<void> {
  await prisma.$executeRaw`SELECT pg_notify(${DISPATCH_NOTIFY_CHANNEL}, ${ticketId})`
}
