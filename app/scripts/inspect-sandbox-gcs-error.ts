/**
 * Diagnosztika: sandbox_app.update_artifact GCS hiba részletei.
 * Futtatás: npx tsx scripts/inspect-sandbox-gcs-error.ts
 */
import { config } from 'dotenv'
import path from 'path'

config({ path: path.join(process.cwd(), '.env.local') })
config({ path: path.join(process.cwd(), '.env') })

async function main() {
  const { prisma } = await import('../src/lib/db')

  const calls = await prisma.toolCall.findMany({
    where: { toolName: 'sandbox_app.update_artifact' },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      id: true,
      createdAt: true,
      status: true,
      argsMeta: true,
      resultMeta: true,
      conversationId: true,
      latencyMs: true,
    },
  })
  console.log('=== Legutóbbi sandbox_app.update_artifact tool_calls ===')
  for (const c of calls) {
    console.log('---')
    console.log(c.createdAt.toISOString(), c.status, `conv=${c.conversationId?.slice(0, 8)}`)
    console.log('argsMeta:', JSON.stringify(c.argsMeta))
    console.log('resultMeta:', JSON.stringify(c.resultMeta))
  }

  const audits = await prisma.auditLog.findMany({
    where: { action: 'tool.call', inputRef: 'sandbox_app.update_artifact' },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: { createdAt: true, policyDecision: true, metadata: true, conversationId: true },
  })
  console.log('\n=== audit metadata (utolsó 3) ===')
  for (const a of audits) {
    console.log('---')
    console.log(a.createdAt.toISOString(), a.policyDecision, `conv=${a.conversationId?.slice(0, 8)}`)
    console.log(JSON.stringify(a.metadata, null, 2))
  }

  const app = await prisma.sandboxApp.findFirst({
    where: { createdAt: { gte: new Date('2026-07-13T00:00:00Z') } },
    orderBy: { createdAt: 'desc' },
    include: { versions: { orderBy: { version: 'desc' }, take: 3 } },
  })
  console.log('\n=== Mai sandbox app ===')
  console.log(JSON.stringify(app, null, 2))

  console.log('\n=== env ===')
  console.log('SANDBOX_APP_STUB=', process.env.SANDBOX_APP_STUB)
  console.log('FILE_EDITOR_STUB=', process.env.FILE_EDITOR_STUB)
  console.log('SANDBOX_APP_BUCKET=', process.env.SANDBOX_APP_BUCKET)

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('DIAG HIBA:', e instanceof Error ? e.message : e)
  process.exit(1)
})
