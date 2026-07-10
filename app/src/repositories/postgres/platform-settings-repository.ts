import type { Prisma } from '@prisma/client'
import { configPrisma } from '@/lib/db'
import type { PlatformSettingsRepository } from '@/repositories/interfaces'

/** Platform_settings mindig az éles (config) Neon branch-en — runtime váltás nélkül olvasható. */
export class PostgresPlatformSettingsRepository implements PlatformSettingsRepository {
  async get(key: string): Promise<unknown | null> {
    const row = await configPrisma.platformSetting.findUnique({ where: { key } })
    return row ? row.value : null
  }

  async set(
    key: string,
    value: Prisma.InputJsonValue | Prisma.NullTypes.JsonNull,
    updatedById?: string | null,
  ): Promise<void> {
    await configPrisma.platformSetting.upsert({
      where: { key },
      create: { key, value, updatedById: updatedById ?? null },
      update: { value, updatedById: updatedById ?? null },
    })
  }
}
