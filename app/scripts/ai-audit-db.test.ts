/** Run against a migrated PostgreSQL database: npm run test:ai-audit-db. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  AUDIT_KINDS,
  AUDIT_SOURCES,
  listVoiceTranscripts,
  openVoiceTranscript,
  recordVoiceTranscript,
  type AiInteractionRow,
} from '../src/domain/ai-audit/ai-audit-service'
import { prisma } from '../src/lib/db'
import { PostgresAiInteractionEventRepository } from '../src/repositories/postgres/ai-interaction-event-repository'

async function main() {
  const suffix = randomUUID()
  const tenant = await prisma.tenant.create({ data: { slug: `ai-audit-test-${suffix}`, displayName: 'AI audit test' } })
  const store = new PostgresAiInteractionEventRepository()
  const [userId, agentId] = [randomUUID(), randomUUID()]
  const scope = { tenantId: tenant.id, agentId }
  try {
    const row = (overrides: Partial<AiInteractionRow>): AiInteractionRow => ({
      id: randomUUID(),
      tenantId: tenant.id,
      userId,
      agentId: randomUUID(),
      installId: 'test',
      sessionId: null,
      turnId: null,
      kind: 'final',
      source: 'gateway',
      content: null,
      meta: {},
      policyVersion: 'test',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    })
    // Minden típust és forrást, amit a kód ír, az adatbázisnak is el kell fogadnia.
    for (const kind of AUDIT_KINDS) assert.equal(await store.insertMany([row({ kind })]), 1, kind)
    for (const source of AUDIT_SOURCES) assert.equal(await store.insertMany([row({ source })]), 1, source)

    const deps = { store, depthFor: async () => 'prompt_and_response' as const }
    const lines = [{ role: 'user', text: 'Kiss Anna' }]
    await recordVoiceTranscript(deps, { ...scope, userId, sessionId: 'live_1', lines, meta: { seconds: 5 } })

    const { items, hasMore } = await listVoiceTranscripts(store, scope)
    assert.deepEqual(items.map((item) => item.hasContent), [true])
    assert.equal(hasMore, false)

    const audits: string[] = []
    const reader = { store, audit: { append: async (entry: { action: string }) => void audits.push(entry.action) } }
    const opening = { ...scope, id: items[0].id, actorId: userId }
    assert.deepEqual(await openVoiceTranscript(reader, opening), { lines })
    assert.deepEqual(audits, ['ai_audit.voice_transcript.read'])
    assert.equal(await openVoiceTranscript(reader, { ...opening, agentId: randomUUID() }), null)
    assert.equal(await openVoiceTranscript(reader, { ...opening, tenantId: randomUUID() }), null)
    console.log('ai-audit-db: ok')
  } finally {
    await prisma.aiInteractionEvent.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.tenant.delete({ where: { id: tenant.id } })
    await prisma.$disconnect()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
