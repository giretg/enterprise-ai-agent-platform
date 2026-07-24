import { prisma } from '@/lib/db'

/**
 * Postgres NOTIFY csatorna a bejövő forduló-sorhoz (#73, D8) — a dispatcher-worker LISTEN-eli,
 * hogy a cron-háló bevárása nélkül, azonnal lezavarja az új fordulót. A csatorna a dispatch-
 * ticket sorától KÜLÖN él, hogy a chat-forgalom ne keveredjen a ticket-dispatchcsel.
 */
export const CHANNEL_TURN_NOTIFY_CHANNEL = 'channel_turn_ready'

/** Értesíti a workert, hogy egy bekötött üzenet fordulója sorba került és feldolgozható. */
export async function notifyChannelTurnReady(turnId: string): Promise<void> {
  await prisma.$executeRaw`SELECT pg_notify(${CHANNEL_TURN_NOTIFY_CHANNEL}, ${turnId})`
}
