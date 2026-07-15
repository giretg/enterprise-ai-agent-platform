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
import { parseHttpApiConfig } from '../src/domain/connector/http-api-client'
import {
  isConnectorSecretRef,
  loadConnectorApiKeyByRef,
  saveConnectorApiKey,
} from '../src/domain/connector/connector-secret-store'
import { PostgresAuditRepository } from '../src/repositories/postgres/audit-repository'

const prisma = new PrismaClient()
const audit = new PostgresAuditRepository()

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * A „Bearer-csapda" auth-alak: a kulcs az `Authorization` fejlécbe kerül, prefix nélkül.
 * Kétféle tárolt alak fordulhat elő: provisioning (`auth.type=api_key_header`) és runtime
 * (`auth.scheme=header`). A cél mindkettőnél az explicit bearer séma.
 */
function detectBearerTrap(cfg: Record<string, unknown>): 'provisioning' | 'runtime' | null {
  const auth = isRecord(cfg.auth) ? cfg.auth : null
  if (!auth) return null
  if (auth.type === 'api_key_header' && String(auth.headerName ?? '').toLowerCase() === 'authorization') {
    return 'provisioning'
  }
  if (auth.scheme === 'header' && String(auth.header ?? '').toLowerCase() === 'authorization') {
    return 'runtime'
  }
  return null
}

function rewriteAuthToBearer(cfg: Record<string, unknown>, shape: 'provisioning' | 'runtime') {
  const auth = isRecord(cfg.auth) ? { ...cfg.auth } : {}
  // A megosztható javasolt aliast megtartjuk (provisioning alak).
  const secretAliasSuggested =
    typeof auth.secretAliasSuggested === 'string' ? auth.secretAliasSuggested : undefined
  const nextAuth =
    shape === 'provisioning'
      ? { type: 'bearer_token', ...(secretAliasSuggested ? { secretAliasSuggested } : {}) }
      : { scheme: 'bearer' }
  return { ...cfg, auth: nextAuth }
}

/** Ha a tárolt kulcs feleslegesen `Bearer ` előtaggal kezdődik, azt eltávolítjuk. */
async function stripBearerPrefixFromStoredKey(
  connectorId: string,
  secretAlias: string | null,
  apply: boolean,
): Promise<boolean> {
  if (!secretAlias || !isConnectorSecretRef(secretAlias)) return false
  let current: string
  try {
    current = await loadConnectorApiKeyByRef(secretAlias)
  } catch {
    return false
  }
  const match = current.match(/^Bearer\s+([\s\S]+)$/)
  if (!match) return false
  if (apply) await saveConnectorApiKey(connectorId, match[1].trim())
  return true
}

async function main() {
  const apply = process.argv.includes('--apply')
  const connectors = await prisma.connector.findMany({
    where: { type: 'http_api', lifecycleState: { not: 'archived' } },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`=== Ostorosbor / Bearer-trap migráció (${apply ? 'apply' : 'dry-run'}) ===\n`)
  let changed = 0
  let skipped = 0
  let keysStripped = 0

  for (const connector of connectors) {
    const cfg = isRecord(connector.config) ? connector.config : null
    if (!cfg) {
      skipped += 1
      continue
    }
    const shape = detectBearerTrap(cfg)
    if (!shape) continue

    const nextConfig = rewriteAuthToBearer(cfg, shape)
    // Szerződés-ellenőrzés: az új config a runtime motorral is érvényes legyen.
    try {
      parseHttpApiConfig(nextConfig)
    } catch (e) {
      console.log(`  ✗ ${connector.name} (${connector.id}) — új config érvénytelen: ${(e as Error).message}`)
      skipped += 1
      continue
    }

    const strippedPrefix = await stripBearerPrefixFromStoredKey(
      connector.id,
      connector.secretAlias,
      apply,
    )
    if (strippedPrefix) keysStripped += 1

    console.log(
      `  ${apply ? '✓' : '-'} ${connector.name} (${connector.id}) — ${shape} auth → bearer` +
        (strippedPrefix ? ' + kulcs Bearer-prefix eltávolítva' : ''),
    )
    changed += 1

    if (!apply) continue
    await prisma.connector.update({
      where: { id: connector.id },
      data: { config: nextConfig as Prisma.InputJsonValue, version: { increment: 1 } },
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
        authShape: shape,
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
