/**
 * Föld API connector diagnosztika — Idempotency-Key / endpoint config.
 * Futtatás: npx tsx scripts/inspect-fold-connector.ts
 */
import { config } from 'dotenv'
import path from 'path'

config({ path: path.join(process.cwd(), '.env.local') })
config({ path: path.join(process.cwd(), '.env') })

async function main() {
  const { prisma } = await import('../src/lib/db')

  const connectors = await prisma.connector.findMany({
    where: {
      OR: [
        { name: { contains: 'öld', mode: 'insensitive' } },
        { name: { contains: 'old', mode: 'insensitive' } },
        { name: { contains: 'land', mode: 'insensitive' } },
        { name: { contains: 'ostoros', mode: 'insensitive' } },
      ],
      type: 'http_api',
    },
    select: {
      id: true,
      name: true,
      lifecycleState: true,
      tenantId: true,
      version: true,
      config: true,
    },
  })

  for (const c of connectors) {
    console.log('==============================================')
    console.log(`name=${c.name} state=${c.lifecycleState} tenant=${c.tenantId} v=${c.version} id=${c.id}`)
    const cfg = c.config as Record<string, unknown>
    console.log('baseUrl:', cfg.baseUrl)
    console.log('requestHeaders:', JSON.stringify(cfg.requestHeaders ?? null))
    console.log('writeHeaders:', JSON.stringify(cfg.writeHeaders ?? null))
    const eps = (cfg.endpoints ?? cfg.proposedTools) as Array<Record<string, unknown>> | undefined
    if (Array.isArray(eps)) {
      console.log('endpoints:')
      for (const e of eps) {
        console.log(
          `  ${String(e.method).padEnd(6)} ${e.path}  idempotent=${e.idempotent === true}  headers=${JSON.stringify(e.headers ?? null)}`,
        )
      }
    } else {
      console.log('endpoints: <none>')
    }
  }

  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error(err)
  process.exit(1)
})
