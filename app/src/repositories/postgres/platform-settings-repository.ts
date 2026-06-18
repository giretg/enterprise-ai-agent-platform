import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { PlatformSettingsRepository } from '@/repositories/interfaces'

export class PostgresPlatformSettingsRepository implements PlatformSettingsRepository {
  async get(key: string): Promise<unknown | null> {
    const row = await prisma.platformSetting.findUnique({ where: { key } })
    return row ? row.value : null
  }

  async set(key: string, value: Prisma.InputJsonValue, updatedById?: string | null): Promise<void> {
    await prisma.platformSetting.upsert({
      where: { key },
      create: { key, value, updatedById: updatedById ?? null },
      update: { value, updatedById: updatedById ?? null },
    })
  }
}
