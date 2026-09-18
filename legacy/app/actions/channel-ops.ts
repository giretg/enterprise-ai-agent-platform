'use server'

import { z } from 'zod'
import { requirePlatformRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { ensureActiveDatabaseMode } from '@/lib/db'
import { fail, ok } from '@/lib/result'
import { CHANNEL_OUTBOUND_RETENTION_DAYS } from '@/domain/channel/channel-types'

/**
 * Csatorna-üzemeltetés: forgalmi/hibametrikák és a bot saját kimenő üzeneteinek megőrzési
 * takarítása (Telegram feature-spec #70/#78, story 59 + D4). CSAK platform-admin (superadmin) —
 * a csatorna platform-szintű erőforrás. A metrika CSAK olvas és aggregál (nyers azonosító nélkül);
 * a takarítás a horizonton túli bot-üzeneteket törli a Telegram oldalán.
 */

const DAY_MS = 24 * 60 * 60 * 1000

const metricsSchema = z.object({
  /** A forgalmi/hiba-ablak hossza napokban (a mostól visszafelé). 0 = teljes előzmény. */
  windowDays: z.number().int().min(0).max(365).optional(),
})

const purgeSchema = z.object({
  /** Megőrzési horizont napokban; alapérték a platform-konstans. */
  retentionDays: z.number().int().min(1).max(3650).optional(),
})

export async function getChannelOpsMetrics(input?: unknown) {
  try {
    await requirePlatformRole('superadmin')
    const parsed = metricsSchema.parse(input ?? {})
    const sinceMs =
      parsed.windowDays != null && parsed.windowDays > 0 ? parsed.windowDays * DAY_MS : undefined
    const snapshot = await services.channelMetrics.snapshot({ sinceMs })
    return ok(snapshot)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült lekérni a csatorna metrikáit.')
  }
}

export async function runChannelRetentionPurge(input?: unknown) {
  try {
    await ensureActiveDatabaseMode()
    await requirePlatformRole('superadmin')
    const parsed = purgeSchema.parse(input ?? {})
    const result = await services.channelRetention.purgeExpiredOutbound({
      retentionDays: parsed.retentionDays ?? CHANNEL_OUTBOUND_RETENTION_DAYS,
    })
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült lefuttatni a megőrzési takarítást.')
  }
}
