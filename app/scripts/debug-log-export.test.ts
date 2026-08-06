/**
 * Admin conversation/ticket debug-log export — tiszta szerializáló tesztek.
 * Futtatás: npx tsx scripts/debug-log-export.test.ts
 */
import assert from 'node:assert/strict'
import {
  DEBUG_LOG_SCHEMA_VERSION,
  buildConversationDebugLogBundle,
  buildTicketDebugLogBundle,
  serializeDebugLogBundle,
  toDebugLogSafe,
  toJsonSafe,
} from '../src/domain/debug-log/debug-log-export'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'

let failures = 0
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn()
      console.log(`  OK ${name}`)
    } catch (e) {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
    }
  })()
}

async function main() {
  console.log('=== Debug-log export teszt ===')

  await check('audit: conversation.debug_log.export regisztrálva', () => {
    assertAuditActionRegistered('conversation.debug_log.export')
  })

  await check('audit: ticket.debug_log.export regisztrálva', () => {
    assertAuditActionRegistered('ticket.debug_log.export')
  })

  await check('toJsonSafe: Date és BigInt', () => {
    const safe = toJsonSafe({
      at: new Date('2026-07-28T12:00:00.000Z'),
      seq: BigInt(42),
      nested: [{ n: 1 }],
    }) as Record<string, unknown>
    assert.equal(safe.at, '2026-07-28T12:00:00.000Z')
    assert.equal(safe.seq, '42')
    assert.deepEqual(safe.nested, [{ n: 1 }])
  })

  await check('debug export: nyers tartalom, dokumentum és hozzáférési token fail-closed kiesik', () => {
    const safe = toDebugLogSafe({
      content: 'modellválasz: szintetikus_token=EXAMPLEONLY',
      body: 'titkos ticket-komment',
      title: 'Ügyfél incidens',
      partialText: 'részválasz',
      lockToken: 'runtime-lock',
      metadata: { customerNote: 'nem exportálható' },
      unrecognizedRawText: 'egy jövőbeli reláció nyers tartalma',
      attachment: {
        document: {
          filename: 'partner@example.com.pdf',
          extractedText: 'A csatolmány teljes szövege',
          storageRef: 'gcs://tenant/document',
          contentHash: 'sha256:ok',
        },
      },
      status: 'ok',
    }) as Record<string, unknown>

    assert.equal('content' in safe, false)
    assert.equal('body' in safe, false)
    assert.equal('title' in safe, false)
    assert.equal('partialText' in safe, false)
    assert.equal('lockToken' in safe, false)
    assert.equal('metadata' in safe, false)
    assert.equal('unrecognizedRawText' in safe, false)
    assert.deepEqual(safe.attachment, {
      document: { contentHash: 'sha256:ok' },
    })
    assert.equal(safe.status, 'ok')
  })

  await check('conversation bundle + serialize fájlnév', () => {
    const bundle = buildConversationDebugLogBundle({
      exportedAt: new Date('2026-07-28T15:00:00.000Z'),
      conversation: { id: '11111111-2222-3333-4444-555555555555', title: 'Teszt' },
      messages: [{ seq: 1, role: 'user', content: 'szia', createdAt: new Date('2026-07-28T14:00:00Z') }],
      agentTurns: [{ id: 'turn-1', status: 'completed', activities: [{ kind: 'tool' }] }],
      modelCalls: [{ provider: 'openrouter', model: 'x', promptTokens: 10 }],
      toolCalls: [{ toolName: 'web_search', status: 'ok' }],
      audit: [{ action: 'message.append', seq: BigInt(1) }],
      linkedTickets: [
        {
          ticket: { id: 'ticket-1', state: 'done' },
          comments: [{ body: 'ok' }],
          transitions: [{ fromState: 'ready', toState: 'done' }],
        },
      ],
    })
    assert.equal(bundle.schemaVersion, DEBUG_LOG_SCHEMA_VERSION)
    assert.equal(bundle.kind, 'conversation')
    assert.equal('content' in (bundle.messages[0] ?? {}), false)
    assert.equal(bundle.audit[0]?.seq, '1')

    const file = serializeDebugLogBundle(bundle, '11111111-2222-3333-4444-555555555555')
    assert.equal(file.filename, 'conversation-debug-log-11111111-2026-07-28.json')
    assert.equal(file.mediaType, 'application/json')
    const parsed = JSON.parse(file.content) as typeof bundle
    assert.equal(parsed.kind, 'conversation')
    assert.equal(parsed.linkedTickets.length, 1)
  })

  await check('ticket bundle linked conversation nélkül', () => {
    const bundle = buildTicketDebugLogBundle({
      exportedAt: new Date('2026-07-28T16:00:00.000Z'),
      ticket: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'Feladat' },
      comments: [],
      transitions: [],
      modelCalls: [],
      toolCalls: [],
      audit: [],
      linkedConversation: null,
    })
    const file = serializeDebugLogBundle(bundle, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    assert.equal(file.filename, 'ticket-debug-log-aaaaaaaa-2026-07-28.json')
    assert.equal(bundle.linkedConversation, null)
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('\nMinden debug-log export teszt zöld.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
