import type { PrismaClient } from '@prisma/client'
import {
  createPrismaClientForUrl,
  configDatabaseUrl,
  databaseUrlForMode,
  DATABASE_MODE_KEY,
  getActiveDatabaseMode,
  parseDatabaseModeState,
  refreshActiveDatabaseMode,
  type DatabaseMode,
} from '@/lib/database-mode'

const globalForPrisma = globalThis as unknown as {
  configPrisma: PrismaClient | undefined
  prismaByMode: Partial<Record<DatabaseMode, PrismaClient>>
}

/** Dev HMR cache-ből maradt kliens nem látja az új sémát — ilyenkor újra generálunk. */
const DEV_REQUIRED_MODELS = ['conversation', 'message', 'workProject'] as const
/** Oszlopok, amiket a hosszú életű `next dev` Prisma-példánya gyakran „lefagyaszt”. */
const DEV_REQUIRED_SKILL_FIELDS = ['displayName'] as const

function prismaClientIsStale(client: PrismaClient): boolean {
  if (process.env.NODE_ENV === 'production') return false
  if (DEV_REQUIRED_MODELS.some((model) => !(model in client))) return true
  // A runtime DMMF a folyamatban betöltött Prisma-modulé — ha a `prisma generate`
  // után nem restartoltunk, az új oszlop itt hiányzik, és a SELECT/UPDATE elhasal.
  const skillFields = (
    client as unknown as {
      _runtimeDataModel?: {
        models?: { Skill?: { fields?: Array<{ name: string }> } }
      }
    }
  )._runtimeDataModel?.models?.Skill?.fields
  if (!skillFields) return false
  const names = new Set(skillFields.map((f) => f.name))
  return DEV_REQUIRED_SKILL_FIELDS.some((field) => !names.has(field))
}

function getClientCache(): Partial<Record<DatabaseMode, PrismaClient>> {
  if (!globalForPrisma.prismaByMode) {
    globalForPrisma.prismaByMode = {}
  }
  return globalForPrisma.prismaByMode
}

function getOrCreateClient(mode: DatabaseMode): PrismaClient {
  const cache = getClientCache()
  const cached = cache[mode]
  if (cached && !prismaClientIsStale(cached)) return cached

  // A kliens módonként EGYSZER jön létre. A `prisma` proxy minden property-access-nél
  // ide fut be, így cache nélkül minden lekérdezés külön query engine-t és külön
  // connection poolt nyitna — sosem zárva.
  void cached?.$disconnect()
  const client = createPrismaClientForUrl(databaseUrlForMode(mode))
  cache[mode] = client
  return client
}

/** Mindig az éles (config) Neon branch — platform_settings és database.mode itt él. */
function getConfigPrismaClient(): PrismaClient {
  const cached = globalForPrisma.configPrisma
  if (cached && !prismaClientIsStale(cached)) return cached

  void cached?.$disconnect()
  const client = createPrismaClientForUrl(configDatabaseUrl())
  globalForPrisma.configPrisma = client
  return client
}

export const configPrisma = getConfigPrismaClient()

async function readDatabaseModeFromConfig() {
  const row = await configPrisma.platformSetting.findUnique({
    where: { key: DATABASE_MODE_KEY },
  })
  return parseDatabaseModeState(row?.value ?? null)
}

export async function ensureActiveDatabaseMode(): Promise<DatabaseMode> {
  return refreshActiveDatabaseMode(readDatabaseModeFromConfig)
}

function resolvePrismaClient(): PrismaClient {
  return getOrCreateClient(getActiveDatabaseMode())
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    // Tűz-és-felejtsd frissítés: DB-kiesés alatt a rejectet ITT kell elnyelni, különben
    // property-access-enként keletkezik egy gazdátlan promise → unhandledRejection.
    // A tényleges lekérdezés úgyis a saját hívójánál hibázik, kezelhető módon.
    void ensureActiveDatabaseMode().catch(() => {})
    const client = resolvePrismaClient()
    const value = Reflect.get(client, prop, client)
    if (typeof value === 'function') {
      return value.bind(client)
    }
    return value
  },
})
