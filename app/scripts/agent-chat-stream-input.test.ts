/**
 * A webes chat-stream végpont kliens-vezérelt forduló-bemenetének méret-kapui.
 * A `content`/`taskBriefing`/`attachmentDocumentIds` eddig határ nélkül ment a
 * prompt-összeállításba, DB-be és a modellhívásba (DoS / OOM / költség). A séma
 * a feladat-út meglévő kapuival egyeztet; a route ezt a határon alkalmazza.
 * Futtatás: npx tsx scripts/agent-chat-stream-input.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  AGENT_CHAT_STREAM_CONTENT_MAX,
  agentChatStreamTurnInputSchema,
} from '../src/lib/validators/actions'

const UUID = '11111111-1111-4111-8111-111111111111'

let failures = 0
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((error) => {
      failures += 1
      console.error(`  ✗ ${name}`)
      console.error(error)
    })
}

async function main() {
  console.log('agent-chat-stream-input')

  await test('érvényes, kaput teljesítő bemenet átmegy', () => {
    const parsed = agentChatStreamTurnInputSchema.safeParse({
      content: 'Kérlek elemezd ezt',
      attachmentDocumentIds: [UUID],
      taskBriefing: { goal: 'cél', source: 'forrás', constraint: '', approval: '' },
    })
    assert.equal(parsed.success, true)
  })

  await test('üres bemenet is érvényes (a törzs-őr a runtime-ban dönt)', () => {
    // A "legalább szöveg vagy csatolmány" szabály a runtime `beginTurn`-ben van;
    // a méret-kapu üres tartalmat/hiányzó csatolmányt nem utasít el.
    assert.equal(agentChatStreamTurnInputSchema.safeParse({ content: '' }).success, true)
  })

  await test('túl hosszú content elutasítva', () => {
    const parsed = agentChatStreamTurnInputSchema.safeParse({
      content: 'x'.repeat(AGENT_CHAT_STREAM_CONTENT_MAX + 1),
    })
    assert.equal(parsed.success, false)
  })

  await test('pontosan a maximum content átmegy', () => {
    const parsed = agentChatStreamTurnInputSchema.safeParse({
      content: 'x'.repeat(AGENT_CHAT_STREAM_CONTENT_MAX),
    })
    assert.equal(parsed.success, true)
  })

  await test('8-nál több csatolmány elutasítva', () => {
    const parsed = agentChatStreamTurnInputSchema.safeParse({
      content: 'x',
      attachmentDocumentIds: Array.from({ length: 9 }, () => UUID),
    })
    assert.equal(parsed.success, false)
  })

  await test('pontosan 8 csatolmány átmegy', () => {
    const parsed = agentChatStreamTurnInputSchema.safeParse({
      content: 'x',
      attachmentDocumentIds: Array.from({ length: 8 }, () => UUID),
    })
    assert.equal(parsed.success, true)
  })

  await test('nem-UUID csatolmány-azonosító elutasítva (nem megy a prisma in-lekérdezésbe)', () => {
    const parsed = agentChatStreamTurnInputSchema.safeParse({
      content: 'x',
      attachmentDocumentIds: ['nem-uuid'],
    })
    assert.equal(parsed.success, false)
  })

  await test('túl hosszú briefing-mező elutasítva', () => {
    const parsed = agentChatStreamTurnInputSchema.safeParse({
      content: 'x',
      taskBriefing: { goal: 'g'.repeat(2001) },
    })
    assert.equal(parsed.success, false)
  })

  await test('túl hosszú approval briefing-mező elutasítva (500 a kapu)', () => {
    const parsed = agentChatStreamTurnInputSchema.safeParse({
      content: 'x',
      taskBriefing: { goal: 'cél', approval: 'a'.repeat(501) },
    })
    assert.equal(parsed.success, false)
  })

  await test('a route a sémát a határon alkalmazza és 400-at ad', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '../src/app/api/v1/agent-chat/stream/route.ts'),
      'utf8',
    )
    assert.match(src, /agentChatStreamTurnInputSchema\.safeParse/)
    assert.match(src, /error: 'invalid_turn_input'/)
    assert.match(src, /status: 400/)
  })

  if (failures > 0) {
    console.error(`\n${failures} failed`)
    process.exit(1)
  }
  console.log('All passed')
}

void main()
