/**
 * One-shot backfill: legacy http_api/gmail connector configok kanonikus runtime
 * alakra hozása a Connector Sablon-Katalógus migrációhoz.
 *
 * Alapból dry-run. Írás csak explicit --apply kapcsolóval:
 *   npm run db:backfill-connector-configs
 *   npm run db:backfill-connector-configs -- --apply
 */
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import { PrismaClient, type Prisma } from '@prisma/client'
import { backfillHttpApiConnectorConfig } from '../src/domain/connector/canonical-config'
import { PostgresAuditRepository } from '../src/repositories/postgres/audit-repository'

const prisma = new PrismaClient()
const audit = new PostgresAuditRepository()

async function main() {
  const apply = process.argv.includes('--apply')
  const connectors = await prisma.connector.findMany({
    where: {
      type: { in: ['http_api', 'gmail'] },
      lifecycleState: { not: 'archived' },
    },
    orderBy: { createdAt: 'asc' },
  })

  let changed = 0
  let skipped = 0
  let googleDefaults = 0
  console.log(`=== Connector config backfill (${apply ? 'apply' : 'dry-run'}) ===\n`)

  for (const connector of connectors) {
    try {
      const result = backfillHttpApiConnectorConfig(connector.config, {
        connectorType: connector.type,
        connectorName: connector.name,
      })
      if (!result.changed) continue
      changed += 1
      if (result.addedGoogleOauthDefaults) googleDefaults += 1

      console.log(
        `  ${apply ? '✓' : '-'} ${connector.name} (${connector.id})` +
          (result.addedGoogleOauthDefaults ? ' +google-oauth-defaults' : ''),
      )

      if (!apply) continue
      await prisma.connector.update({
        where: { id: connector.id },
        data: { config: result.config as Prisma.InputJsonValue },
      })
      await audit.append({
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        action: 'connector.update',
        targetType: 'connector',
        targetId: connector.id,
        modelUsed: null,
        inputRef: 'backfill-connector-configs',
        outputRef: null,
        policyDecision: 'allowed',
        metadata: {
          reason: 'connector_template_canonical_config_backfill',
          connector_type: connector.type,
          google_oauth_defaults_added: result.addedGoogleOauthDefaults,
        },
        tenantId: connector.tenantId,
      })
    } catch (err) {
      skipped += 1
      console.warn(
        `  ! skipped ${connector.name} (${connector.id}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  console.log(
    `\nDone. changed=${changed}, skipped=${skipped}, googleOauthDefaults=${googleDefaults}` +
      (apply ? '' : ' (dry-run; add --apply to write)'),
  )
}

main()
  .catch((err) => {
    console.error('Fatal:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
