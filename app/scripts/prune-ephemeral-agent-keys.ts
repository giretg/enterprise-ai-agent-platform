/**
 * Periodic cleanup for dispatcher-issued ephemeral agent API keys.
 *
 * Dry-run by default:
 *   npm run db:prune-ephemeral-agent-keys
 *   npm run db:prune-ephemeral-agent-keys -- --apply
 *
 * Only keys with `expiresAt` are considered, so long-lived manually managed
 * agent keys are left untouched.
 */
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import { ApiKeyStatus, Prisma, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

function readRetentionDays(): number {
  const arg = process.argv.find((item) => item.startsWith('--retention-days='))
  const raw = arg?.split('=')[1] ?? process.env.EPHEMERAL_AGENT_KEY_RETENTION_DAYS ?? '7'
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 7
}

async function main() {
  const apply = process.argv.includes('--apply')
  const retentionDays = readRetentionDays()
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
  const where = {
    expiresAt: { not: null },
    OR: [{ status: ApiKeyStatus.revoked }, { expiresAt: { lt: cutoff } }],
  }

  let count = 0
  try {
    count = await prisma.agentApiKey.count({ where })
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2022' &&
      String(error.meta?.column ?? '').includes('expires_at')
    ) {
      console.warn(
        'agent_api_keys.expires_at is not installed yet; run npm run db:apply-agent-api-key-expires-at before pruning.',
      )
      return
    }
    throw error
  }
  console.log(
    `Ephemeral agent key prune (${apply ? 'apply' : 'dry-run'}): ${count} deletable key(s), retention=${retentionDays}d`,
  )

  if (!apply || count === 0) return

  const deleted = await prisma.agentApiKey.deleteMany({ where })
  console.log(`Deleted ${deleted.count} ephemeral agent key(s).`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
