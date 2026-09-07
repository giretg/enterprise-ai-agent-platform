/**
 * Telegram → webes chat-futásidő adapter (D8/D11).
 *
 * A grant `projectKey` a memória hatóköre. A ChannelTurnService átadja a
 * runTurn-nek; az adapternek tovább kell adnia a sendMessageStream-nek,
 * különben a 24 órás gördülő beszélgetésen a webes projektváltás után a
 * címke új projektet mutat, a memória pedig a régibe ír/olvas.
 */
import assert from 'node:assert/strict'
import { AgentChatChannelRuntime } from '../src/domain/channel/channel-agent-runtime-adapter'
import type { AgentChatStreamEvent } from '../src/domain/agent/agent-turn-runner'

let failures = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`)
  }
}

async function* doneStream(): AsyncGenerator<AgentChatStreamEvent> {
  yield { type: 'token', chunk: 'ok' }
  yield { type: 'done', conversationId: 'conv-1', messageId: 'msg-1' }
}

async function main() {
  await test('CA-R1 a grant projectKey eljut a sendMessageStream-hez', async () => {
    let seen: Record<string, unknown> | null = null
    const runtime = {
      sendMessageStream(params: Record<string, unknown>) {
        seen = params
        return doneStream()
      },
    }
    const adapter = new AgentChatChannelRuntime(runtime as never)
    const result = await adapter.runTurn({
      agentId: 'agent-1',
      tenantId: 'tenant-a',
      userId: 'user-1',
      conversationId: 'conv-1',
      projectKey: 'penzugy-2026',
      text: 'Szia',
    })
    assert.equal(result.ok, true)
    assert.ok(seen, 'a futásidőt meghívták')
    assert.equal(seen!.projectKey, 'penzugy-2026')
    assert.equal(seen!.conversationId, 'conv-1')
    assert.equal(seen!.agentId, 'agent-1')
    assert.equal(seen!.createdById, 'user-1')
    assert.equal(seen!.tenantId, 'tenant-a')
    assert.equal(seen!.content, 'Szia')
  })

  console.log(`\n${failures === 0 ? 'All passed' : `${failures} failed`}`)
  if (failures > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
