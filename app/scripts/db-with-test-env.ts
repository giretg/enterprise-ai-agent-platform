/**
 * Prisma parancs futtatása a Neon teszt branch env változóival.
 * Használat: npm run db:push:test | npm run db:seed:test
 */
import { spawnSync } from 'node:child_process'
import { config } from 'dotenv'
import { resolve } from 'node:path'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

const command = process.argv[2]
if (!command || !['push', 'seed', 'migrate'].includes(command)) {
  console.error('Használat: tsx scripts/db-with-test-env.ts <push|seed|migrate>')
  process.exit(1)
}

const testDbUrl = process.env.DATABASE_URL_TEST?.trim()
const testDirectUrl = process.env.DIRECT_URL_TEST?.trim()
if (!testDbUrl || !testDirectUrl) {
  console.error('Hiányzik DATABASE_URL_TEST vagy DIRECT_URL_TEST (.env.local)')
  process.exit(1)
}

const prismaArgs =
  command === 'seed'
    ? ['db', 'seed']
    : command === 'migrate'
      ? ['migrate', 'dev']
      : ['db', 'push']

const result = spawnSync('npx', ['prisma', ...prismaArgs], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_URL: testDbUrl,
    DIRECT_URL: testDirectUrl,
  },
})

process.exit(result.status ?? 1)
