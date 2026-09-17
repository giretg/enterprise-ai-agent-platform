/**
 * #516 — tartós, verziózott forduló-bemenet + launcher-mód.
 *
 *  - a mentett bemenet oda-vissza megőrzi a privát modellkontextust és a
 *    folytatás-jelzőket, titkot nem tartalmaz;
 *  - ismeretlen verzió / hiányos adat egyértelmű hiba (nem fut más kontextussal);
 *  - a kliens-snapshot (reconnect `snapshot` esemény) NEM adja vissza az inputot;
 *  - nem támogatott CHAT_TURN_LAUNCHER_MODE hiba, nem csendes visszaesés.
 *
 * Futtatás: npm run test:chat-turn-input
 */
import assert from 'node:assert/strict'
import {
  buildStoredTurnInput,
  parseStoredTurnInput,
  StoredTurnInputError,
} from '../src/domain/agent/chat-turn-input'
import { resolveChatTurnLauncherMode } from '../src/domain/agent/chat-turn-launcher'
import { snapshotEvent } from '../src/domain/agent/agent-turn-reconnect'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK ${name}`)
  } catch (e) {
    failures += 1
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function main() {
  console.log('=== #516 forduló-bemenet teszt ===')

  await test('build → JSON → parse: minden rekonstrukcióhoz kellő mező megmarad', () => {
    const built = buildStoredTurnInput({
      agentId: 'agent-1',
      createdById: 'user-1',
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      content: 'Készíts riportot',
      projectKey: 'proj-a',
      attachmentDocumentIds: ['doc-1', 'doc-2'],
      processDefinitionId: 'pd-1',
      processInputPayload: { ugyfel: 'Vino Trade' },
      consequenceApprovalContinuation: true,
      connectorGrantContinuation: true,
      taskBriefing: { goal: 'cél', source: 'forrás', constraint: '', approval: '' },
      modelContextPrefix: '[külső app] rendelés #42',
    })
    const parsed = parseStoredTurnInput(JSON.parse(JSON.stringify(built)))
    assert.deepEqual(parsed, built)
    assert.equal(parsed.v, 1)
    assert.equal(parsed.modelContextPrefix, '[külső app] rendelés #42')
    assert.deepEqual(parsed.attachmentDocumentIds, ['doc-1', 'doc-2'])
    // Titok / token jellegű mező nincs a sémában — a kulcsok zárt listája.
    assert.deepEqual(
      Object.keys(built).sort(),
      [
        'attachmentDocumentIds',
        'connectorGrantContinuation',
        'consequenceApprovalContinuation',
        'content',
        'modelContextPrefix',
        'processDefinitionId',
        'processInputPayload',
        'projectKey',
        'taskBriefing',
        'v',
      ],
    )
  })

  await test('minimális bemenet: csak v + content + üres csatolmány-lista', () => {
    const built = buildStoredTurnInput({ agentId: 'a', createdById: 'u', content: 'Szia' })
    assert.deepEqual(built, { v: 1, content: 'Szia', attachmentDocumentIds: [] })
  })

  await test('ismeretlen verzió / hiányos adat egyértelmű hiba', () => {
    for (const raw of [null, undefined, 'x', [], {}, { v: 2, content: 'x', attachmentDocumentIds: [] }]) {
      assert.throws(() => parseStoredTurnInput(raw), StoredTurnInputError)
    }
    assert.throws(
      () => parseStoredTurnInput({ v: 1, attachmentDocumentIds: [] }),
      /hiányzik a szöveg/,
    )
    assert.throws(
      () => parseStoredTurnInput({ v: 1, content: 'x', attachmentDocumentIds: [1] }),
      /csatolmány-listája érvénytelen/,
    )
  })

  await test('a kliens-snapshot nem szivárogtatja a privát modellkontextust', () => {
    const event = snapshotEvent({
      id: 'turn-1',
      status: 'queued',
      partialText: '',
      activities: [],
      conversationId: 'conv-1',
      userMessageId: 'msg-1',
      assistantMessageId: null,
      error: null,
      reason: null,
      // A Prisma-sor bővebb a strukturális típusnál — az `input` is rajta van.
      ...({ input: { v: 1, content: 'x', modelContextPrefix: 'TITKOS KONTEXTUS' } } as object),
    })
    assert.ok(!JSON.stringify(event).includes('TITKOS KONTEXTUS'))
    assert.ok(!('input' in event))
  })

  await test('CHAT_TURN_LAUNCHER_MODE: üres → in-process; ismeretlen → hiba', () => {
    assert.equal(resolveChatTurnLauncherMode({}), 'in-process')
    assert.equal(resolveChatTurnLauncherMode({ CHAT_TURN_LAUNCHER_MODE: 'in-process' }), 'in-process')
    assert.throws(
      () => resolveChatTurnLauncherMode({ CHAT_TURN_LAUNCHER_MODE: 'cloud-run-job' }),
      /Nem támogatott CHAT_TURN_LAUNCHER_MODE/,
    )
  })

  if (failures > 0) {
    console.log(`\n${failures} teszt bukott.`)
    process.exit(1)
  }
  console.log('\n#516 forduló-bemenet teszt kész.')
}

void main()
