/**
 * Determinisztikus teszt a chat-kontextus tool-call-történet javításához
 * (`buildHistoryGatewayMessages` — agent-chat-runtime.ts).
 *
 * Előzmény: egy korábbi beszélgetésben az agent repo_prepare + file_edit
 * eszközökkel ténylegesen módosított egy fájlt, de a következő körben ("készíts
 * PR-t ebből") csak a nyers agent-válaszszöveget látta a promptban — a
 * ToolCall.resultMeta (pl. melyik fájlt szerkesztette) elveszett, ezért a
 * modell nem tudott a saját korábbi munkájára hivatkozni. Ez a teszt azt
 * igazolja, hogy a fordulóhoz tartozó tool-hívások szinopszise ténylegesen
 * bekerül a következő kör promptjába, és a fordulók nem keverednek össze.
 *
 * Futtatás: npm run test:chat-tool-history
 */
import assert from 'node:assert/strict'
import type { ToolCall } from '@prisma/client'
import { buildCancelledTurnMessage, buildHistoryGatewayMessages } from '../src/domain/agent/agent-chat-runtime'
import type { ContextAssemblyMessage } from '../src/domain/conversation/context-assembly'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function msg(overrides: Partial<ContextAssemblyMessage> & Pick<ContextAssemblyMessage, 'id' | 'seq' | 'role' | 'createdAt'>): ContextAssemblyMessage {
  return { content: '', contentDeletedAt: null, ...overrides }
}

function call(overrides: Partial<ToolCall> & Pick<ToolCall, 'toolName' | 'createdAt'>): ToolCall {
  return {
    id: `call-${overrides.toolName}-${overrides.createdAt.getTime()}`,
    agentId: 'agent-1',
    ticketId: null,
    conversationId: 'conv-1',
    connectorId: null,
    status: 'ok',
    argsMeta: {},
    resultMeta: {},
    latencyMs: 100,
    policyDecision: 'allowed',
    ...overrides,
  } as ToolCall
}

async function main() {
  await test('a forduló tool-hívása bekerül a korábbi agent-válasz szinopszisába', () => {
    const messages: ContextAssemblyMessage[] = [
      msg({ id: 'u1', seq: 1, role: 'user', content: 'módosítsd a fejlécet', createdAt: new Date('2026-07-06T21:10:00Z') }),
      msg({ id: 'a1', seq: 2, role: 'agent', content: 'Sikeresen módosítottam.', createdAt: new Date('2026-07-06T21:12:00Z') }),
    ]
    const toolCalls: ToolCall[] = [
      call({
        toolName: 'repo_prepare',
        createdAt: new Date('2026-07-06T21:11:00Z'),
        resultMeta: { repoPath: 'repo', commitSha: 'abc123', filesWritten: 559 },
      }),
      call({
        toolName: 'file_edit',
        createdAt: new Date('2026-07-06T21:11:30Z'),
        resultMeta: { path: 'repo/app/src/app/control-plane/layout.tsx', replacements: 1 },
      }),
    ]

    const result = buildHistoryGatewayMessages(messages, toolCalls, '')
    assert.equal(result.length, 2)
    assert.equal(result[0].role, 'user')
    assert.equal(result[0].content, 'módosítsd a fejlécet')
    assert.equal(result[1].role, 'assistant', 'a korábbi agent-válasz assistant szerepű kell legyen')
    const agentContent = result[1].content
    assert.ok(agentContent.startsWith('Sikeresen módosítottam.'), 'nincs [Korábbi agent válasz] prefix — a szerep hordozza az információt')
    assert.ok(!agentContent.includes('[Korábbi agent válasz]'))
    assert.ok(agentContent.includes('[Ebben a körben lefutott eszközhívások]'))
    assert.ok(agentContent.includes('repo_prepare (siker)'))
    assert.ok(agentContent.includes('commitSha=abc123'))
    assert.ok(
      agentContent.includes('file_edit (siker): path=repo/app/src/app/control-plane/layout.tsx, replacements=1'),
      'a szerkesztett fájl pontos elérési útjának szerepelnie kell a szinopszisban',
    )
  })

  await test('valódi user/assistant váltakozás: a modell látja, hogy már válaszolt', () => {
    const messages: ContextAssemblyMessage[] = [
      msg({ id: 'u1', seq: 1, role: 'user', content: 'módosítsd a fejlécet', createdAt: new Date('2026-07-06T21:10:00Z') }),
      msg({ id: 'a1', seq: 2, role: 'agent', content: 'Nem tudok PR-t nyitni, de a fájlt módosítottam.', createdAt: new Date('2026-07-06T21:12:00Z') }),
      msg({ id: 'u2', seq: 3, role: 'user', content: 'próbáld meg újra', createdAt: new Date('2026-07-06T21:14:00Z') }),
    ]
    const result = buildHistoryGatewayMessages(messages, [], '')
    assert.deepEqual(
      result.map((m) => m.role),
      ['user', 'assistant', 'user'],
      'a szerepeknek user/assistant/user sorrendben kell váltakozniuk (nem 3× user)',
    )
    // A "próbáld meg újra" előtt a modell látja a saját korábbi assistant-válaszát.
    assert.equal(result[2].content, 'próbáld meg újra')
  })

  await test('a fordulók nem keverednek: az előző kör tool-hívása nem szivárog a következőbe', () => {
    const messages: ContextAssemblyMessage[] = [
      msg({ id: 'u1', seq: 1, role: 'user', content: 'kör 1', createdAt: new Date('2026-07-06T21:10:00Z') }),
      msg({ id: 'a1', seq: 2, role: 'agent', content: 'kör 1 válasz', createdAt: new Date('2026-07-06T21:11:00Z') }),
      msg({ id: 'u2', seq: 3, role: 'user', content: 'kör 2', createdAt: new Date('2026-07-06T21:13:00Z') }),
      msg({ id: 'a2', seq: 4, role: 'agent', content: 'kör 2 válasz', createdAt: new Date('2026-07-06T21:14:00Z') }),
    ]
    const toolCalls: ToolCall[] = [
      call({ toolName: 'kb_search', createdAt: new Date('2026-07-06T21:10:30Z'), resultMeta: { hitCount: 0 } }),
      call({ toolName: 'file_edit', createdAt: new Date('2026-07-06T21:13:30Z'), resultMeta: { path: 'x.ts' } }),
    ]

    const result = buildHistoryGatewayMessages(messages, toolCalls, '')
    const turn1 = result[1].content
    const turn2 = result[3].content
    assert.ok(turn1.includes('kb_search'))
    assert.ok(!turn1.includes('file_edit'), 'a 2. kör tool-hívása nem kerülhet az 1. kör szinopszisába')
    assert.ok(turn2.includes('file_edit'))
    assert.ok(!turn2.includes('kb_search'), 'az 1. kör tool-hívása nem kerülhet a 2. kör szinopszisába')
  })

  await test('ha nem volt tool-hívás a fordulóban, nincs szinopszis-blokk', () => {
    const messages: ContextAssemblyMessage[] = [
      msg({ id: 'u1', seq: 1, role: 'user', content: 'szia', createdAt: new Date('2026-07-06T21:10:00Z') }),
      msg({ id: 'a1', seq: 2, role: 'agent', content: 'szia, miben segíthetek?', createdAt: new Date('2026-07-06T21:11:00Z') }),
    ]
    const result = buildHistoryGatewayMessages(messages, [], '')
    assert.equal(result[1].role, 'assistant')
    assert.equal(result[1].content, 'szia, miben segíthetek?')
  })

  await test('megtagadott/hibás tool-hívás státusza magyarul jelenik meg, a zaj-mezők kimaradnak', () => {
    const messages: ContextAssemblyMessage[] = [
      msg({ id: 'u1', seq: 1, role: 'user', content: 'küldd el', createdAt: new Date('2026-07-06T21:10:00Z') }),
      msg({ id: 'a1', seq: 2, role: 'agent', content: 'nem sikerült', createdAt: new Date('2026-07-06T21:11:00Z') }),
    ]
    const toolCalls: ToolCall[] = [
      call({
        toolName: 'gmail_send',
        createdAt: new Date('2026-07-06T21:10:30Z'),
        status: 'denied',
        resultMeta: { conversationId: 'conv-1', actingUserId: 'user-1', reason: 'no_grant' },
      }),
    ]
    const result = buildHistoryGatewayMessages(messages, toolCalls, '')
    const content = result[1].content
    assert.ok(content.includes('gmail_send (megtagadva): reason=no_grant'))
    assert.ok(!content.includes('conversationId'))
    assert.ok(!content.includes('actingUserId'))
  })

  await test('megszakított forduló: tool-összefoglaló + folytatás-útmutató, nincs stream-chunk', () => {
    const content = buildCancelledTurnMessage({
      turnToolCalls: [
        call({
          toolName: 'web_search',
          createdAt: new Date('2026-07-06T21:11:00Z'),
          resultMeta: { query: '24.hu utolsó cikk', resultCount: 5 },
        }),
      ],
      activities: [],
    })
    assert.ok(content.includes('Megszakítva'))
    assert.ok(content.includes('Lefutott eszközök: web_search'))
    assert.ok(content.includes('folytasd'))
    assert.ok(!content.includes('chunk'))
    assert.ok(!content.includes('[Ebben a körben lefutott eszközhívások]'))
  })

  await test('megszakított forduló: kész válasz kerül mentésre, nem félbemaradt token', () => {
    const fullReply = 'Az utolsó cikk a 24.hu-n a következő témában jelent meg: gazdaság.'
    const content = buildCancelledTurnMessage({
      completedReply: fullReply,
      turnToolCalls: [
        call({
          toolName: 'web_search',
          createdAt: new Date('2026-07-06T21:11:00Z'),
          resultMeta: { query: '24.hu', resultCount: 3 },
        }),
      ],
    })
    assert.ok(content.includes('[Válasz]'))
    assert.ok(content.includes(fullReply))
    assert.ok(!content.includes('félbemaradt'))
  })

  await test('megszakított forduló szinopszisa bekerül a következő kör promptjába', () => {
    const cancelledReply = buildCancelledTurnMessage({
      turnToolCalls: [
        call({
          toolName: 'web_search',
          createdAt: new Date('2026-07-06T21:11:00Z'),
          resultMeta: { query: '24.hu', resultCount: 2 },
        }),
      ],
    })
    const toolCalls = [
      call({
        toolName: 'web_search',
        createdAt: new Date('2026-07-06T21:11:00Z'),
        resultMeta: { query: '24.hu', resultCount: 2 },
      }),
    ]
    const messages: ContextAssemblyMessage[] = [
      msg({ id: 'u1', seq: 1, role: 'user', content: 'mi az utolsó cikk?', createdAt: new Date('2026-07-06T21:10:00Z') }),
      msg({ id: 'a1', seq: 2, role: 'agent', content: cancelledReply, createdAt: new Date('2026-07-06T21:12:00Z') }),
      msg({ id: 'u2', seq: 3, role: 'user', content: 'folytasd', createdAt: new Date('2026-07-06T21:14:00Z') }),
    ]
    const result = buildHistoryGatewayMessages(messages, toolCalls, '')
    assert.equal(result.length, 3)
    assert.ok(result[1].content.includes('web_search (siker)'))
    assert.ok(result[1].content.includes('Megszakítva'))
    assert.equal(result[2].content, 'folytasd')
  })

  if (failures > 0) {
    console.log(`\n${failures} teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld.')
}

void main()
