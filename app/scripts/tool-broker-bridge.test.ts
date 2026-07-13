/**
 * Tool Broker MCP bridge contract tests.
 * Futtatás: npm run test:tool-broker-bridge
 */
import assert from 'node:assert/strict'
import {
  handleMcpRequest,
  invokePlatformToolViaHttp,
} from '../src/harness/platform-mcp-bridge'

let failures = 0

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function main() {
  console.log('=== Tool Broker MCP bridge ===')

  await test('tools/list exposes Broker tools from the shared registry', async () => {
    const response = await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      async () => ({}),
    )
    const tools = (response.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
    assert.ok(tools.includes('kb_search'))
    assert.ok(tools.includes('board_write'))
    assert.ok(tools.includes('web_search'))
    assert.ok(tools.includes('pdf_create'))
    assert.ok(tools.includes('docx_create'))
    assert.ok(tools.includes('sandbox_app.update_artifact'))
  })

  await test('unsupported MCP tool stops before HTTP and never falls back to board_write', async () => {
    let fetchCalls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      fetchCalls++
      throw new Error('fetch should not be called')
    }) as typeof fetch

    try {
      await assert.rejects(
        () =>
          invokePlatformToolViaHttp(
            'definitely_not_a_tool',
            {},
            { PLATFORM_API_URL: 'http://platform.local', HARNESS_AGENT_API_KEY: 'key' },
          ),
        /Unsupported platform broker tool/,
      )
      assert.equal(fetchCalls, 0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await test('board_write is explicit and preserves the requested ticket id', async () => {
    const originalFetch = globalThis.fetch
    let requestBody: unknown = null
    globalThis.fetch = (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body))
      return {
        ok: true,
        json: async () => ({ success: true, data: { result: { ok: true } } }),
      } as Response
    }) as typeof fetch

    try {
      const result = await invokePlatformToolViaHttp(
        'board_write',
        { ticketId: 'ticket-2', patch: { payload: { done: true } } },
        {
          PLATFORM_API_URL: 'http://platform.local',
          HARNESS_AGENT_API_KEY: 'key',
          TICKET_ID: 'ticket-1',
        },
      )
      assert.deepEqual(result, { ok: true })
      assert.deepEqual(requestBody, {
        tool: 'board_write',
        ticketId: 'ticket-2',
        args: {
          ticketId: 'ticket-2',
          patch: { payload: { done: true } },
        },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  if (failures > 0) {
    console.error(`\n${failures} Tool Broker bridge teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden Tool Broker bridge teszt zöld.')
}

void main()
