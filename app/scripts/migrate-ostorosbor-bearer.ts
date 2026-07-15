/**
 * WP-6 (B1/WP-0 következménye) — a már AKTIVÁLT connectorok „Bearer-csapda" migrációja.
 *
 * A WP-0 a sablonokat `bearer` sémára javította, de a korábban aktivált connectorok
 * (materializált másolatok, pl. `Ostorosbor CRM`) még a régi
 * `api_key_header`/`Authorization` (vagy `header`/`Authorization`) configot hordozzák —
 * a runtime így a kulcsot `Bearer ` előtag NÉLKÜL küldi, a CRM pedig 401-et ad.
 *
 * Ez a script (D-3 szellemében) a sablon-igazsághoz igazít: az érintett connectorok
 * auth-ját `bearer`-re állítja (a runtime így `Authorization: Bearer <kulcs>`-ot küld),
 * és — ha a tárolt kulcs feleslegesen `Bearer ` előtaggal kezdődik — eltávolítja azt.
 *
 * Alapból dry-run. Írás csak explicit --apply kapcsolóval:
 *   npm run db:migrate-ostorosbor-bearer
 *   npm run db:migrate-ostorosbor-bearer -- --apply
 */
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import { PrismaClient, type Prisma } from '@prisma/client'
import {
  isConnectorSecretRef,
  loadConnectorApiKeyByRef,
  saveConnectorApiKey,
} from '../src/domain/connector/connector-secret-store'
import {
  applyMigrationWithSecretCompensation,
  isOstorosborBearerMigrationCandidate,
  rematerializeOstorosborConnectorConfig,
} from '../src/domain/connector-template/ostorosbor-bearer-migration'
import { PostgresAuditRepository } from '../src/repositories/postgres/audit-repository'

const prisma = new PrismaClient()
const audit = new PostgresAuditRepository()

/** Ha a tárolt kulcs `Bearer ` előtagos, előkészíti a kompenzálható rotációt. */
async function readBearerPrefixPlan(
  secretAlias: string | null,
): Promise<{ original: string; stripped: string } | null> {
  if (!secretAlias || !isConnectorSecretRef(secretAlias)) return null
  let current: string
  try {
    current = await loadConnectorApiKeyByRef(secretAlias)
  } catch {
    return null
  }
  const match = current.match(/^Bearer\s+([\s\S]+)$/)
  if (!match) return null
  return { original: current, stripped: match[1].trim() }
}

async function main() {
  const apply = process.argv.includes('--apply')
  const connectors = await prisma.connector.findMany({
    where: { type: 'http_api', lifecycleState: 'active' },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`=== Ostorosbor / Bearer-trap migráció (${apply ? 'apply' : 'dry-run'}) ===\n`)
  let changed = 0
  let skipped = 0
  let keysStripped = 0

  for (const connector of connectors) {
    if (!isOstorosborBearerMigrationCandidate(connector)) continue

    let nextConfig
    try {
      nextConfig = rematerializeOstorosborConnectorConfig(connector)
    } catch (e) {
      console.log(
        `  ✗ ${connector.name} (${connector.id}) — újramaterializálás sikertelen: ${(e as Error).message}`,
      )
      skipped += 1
      continue
    }

    const prefixPlan = await readBearerPrefixPlan(connector.secretAlias)
    const strippedPrefix = Boolean(prefixPlan)
    if (strippedPrefix) keysStripped += 1

    console.log(
      `  ${apply ? '✓' : '-'} ${connector.name} (${connector.id}) — sablonból újramaterializálva` +
        (strippedPrefix ? ' + kulcs Bearer-prefix eltávolítva' : ''),
    )
    changed += 1

    if (!apply) continue
    await applyMigrationWithSecretCompensation({
      ...(prefixPlan
        ? { originalSecret: prefixPlan.original, strippedSecret: prefixPlan.stripped }
        : {}),
      saveSecret: (value) => saveConnectorApiKey(connector.id, value),
      updateConfig: async () => {
        await prisma.connector.update({
          where: { id: connector.id },
          data: { config: nextConfig as Prisma.InputJsonValue, version: { increment: 1 } },
        })
      },
    })
    await audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action: 'connector.update',
      targetType: 'connector',
      targetId: connector.id,
      modelUsed: null,
      inputRef: null,
      outputRef: connector.name,
      policyDecision: 'allowed',
      metadata: {
        migration: 'ostorosbor-bearer',
        strategy: 'template_rematerialization',
        keyPrefixStripped: strippedPrefix,
      },
    })
  }

  console.log(
    `\n${apply ? 'Alkalmazva' : 'Dry-run'}: ${changed} connector átállítva bearer-re, ` +
      `${keysStripped} kulcsról Bearer-prefix eltávolítva, ${skipped} kihagyva.`,
  )
  if (!apply && changed > 0) {
    console.log('Írás: futtasd újra a --apply kapcsolóval.')
  }
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
