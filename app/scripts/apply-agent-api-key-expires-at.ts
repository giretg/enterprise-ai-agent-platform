/**
 * Additive DB patch for ephemeral dispatcher agent API keys.
 *
 * The repository currently does not carry Prisma migration history, so this
 * installs the nullable `agent_api_keys.expires_at` column explicitly.
 *
 * Futtatás: npm run db:apply-agent-api-key-expires-at        (DATABASE_URL — dev)
 *           npm run db:apply-agent-api-key-expires-at:test   (DATABASE_URL_TEST)
 */
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import { PrismaClient } from '@prisma/client'

export const AGENT_API_KEY_EXPIRES_AT_STATEMENTS = [
  `
ALTER TABLE agent_api_keys
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
`,
]

async function apply(databaseUrl: string, label: string) {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  try {
    for (const statement of AGENT_API_KEY_EXPIRES_AT_STATEMENTS) {
      await prisma.$executeRawUnsafe(statement)
    }
    console.log(`  ✓ [${label}] agent_api_keys.expires_at oszlop telepítve`)
  } finally {
    await prisma.$disconnect()
  }
}

async function main() {
  const target = process.argv[2]
  console.log('=== Agent API key expires_at oszlop telepítés ===\n')

  if (target === 'test') {
    const url = process.env.DATABASE_URL_TEST?.trim()
    if (!url) throw new Error('DATABASE_URL_TEST nincs beállítva')
    await apply(url, 'test')
  } else {
    const url = process.env.DATABASE_URL?.trim()
    if (!url) throw new Error('DATABASE_URL nincs beállítva')
    await apply(url, 'dev')
  }
}

main().catch((error) => {
  console.error('Fatal:', error)
  process.exit(1)
})
