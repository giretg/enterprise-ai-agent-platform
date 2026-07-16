/**
 * Chat "thinking-trace" spec (docs/specs/chat-thinking-trace-spec.md) tesztek.
 * Futtatás: npx tsx scripts/chat-thinking-trace.test.ts
 *
 * Lefedi §9 kritikus eseteit:
 *  - Bridge-parser: reasoning-summary delták helyes sorrendben, a válasz-tokentől
 *    elkülönítve (WP-2).
 *  - Content-guard (D5/E2): a reasoning-szöveg PAN/IBAN/titok/email redakciója.
 *  - Feature-kapcsoló (D7/E4): kikapcsolt tenant → nincs engedély (fail-closed).
 */
import assert from 'node:assert/strict'
import { callChatGptOAuth } from '../src/domain/gateway/chatgpt-oauth-bridge'
import {
  StreamingSensitiveTextRedactor,
  redactSensitiveText,
} from '../src/domain/gateway/sensitivity-router'
import { OpenAiCompatibleProvider } from '../src/domain/gateway/model-gateway'
import { extractGeminiThoughtText } from '../src/domain/gateway/gemini-provider'
import { PlatformSettingsService } from '../src/domain/platform-settings/platform-settings-service'
import {
  appendThinkingDelta,
  canStartThinkingTraceStream,
} from '../src/lib/chat-thinking-trace'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'
import type { AuditRepository, PlatformSettingsRepository } from '../src/repositories/interfaces'

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

function sseResponse(lines: string[]): Response {
  const body = lines.map((l) => `${l}\n`).join('')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Több chunkra bontva, hogy a puffer-összefűzést is teszteljük.
      const enc = new TextEncoder()
      const mid = Math.floor(body.length / 2)
      controller.enqueue(enc.encode(body.slice(0, mid)))
      controller.enqueue(enc.encode(body.slice(mid)))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function main() {
  console.log('=== Chat thinking-trace teszt ===')

  await check('bridge: reasoning-summary deltak sorrendben, kulon a valasz-tokentol', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      sseResponse([
        'data: {"type":"response.reasoning_summary_text.delta","delta":"Elemzem a "}',
        'data: {"type":"response.reasoning_summary_text.delta","delta":"kérdést."}',
        'data: {"type":"response.output_text.delta","delta":"Kész a "}',
        'data: {"type":"response.output_text.delta","delta":"válasz."}',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}',
      ])) as typeof fetch

    try {
      const reasoning: string[] = []
      const result = await callChatGptOAuth({
        tokens: { accessToken: 'a', accountId: 'b' },
        messages: [{ role: 'user', content: 'kérdés' }],
        model: 'gpt-5.5',
        onReasoningDelta: (d) => reasoning.push(d),
      })
      assert.deepEqual(reasoning, ['Elemzem a ', 'kérdést.'])
      assert.equal(result.content, 'Kész a válasz.')
      assert.equal(result.usage.completionTokens, 5)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await check('bridge: onReasoningDelta nelkul nem hasal el, reasoning eldobva', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      sseResponse([
        'data: {"type":"response.reasoning_summary_text.delta","delta":"belső gondolat"}',
        'data: {"type":"response.output_text.delta","delta":"Szia"}',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
      ])) as typeof fetch
    try {
      const result = await callChatGptOAuth({
        tokens: { accessToken: 'a', accountId: 'b' },
        messages: [{ role: 'user', content: 'szia' }],
        model: 'gpt-5.5',
      })
      assert.equal(result.content, 'Szia')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await check('content-guard: PAN redaktalva', () => {
    const { text, redactedCount } = redactSensitiveText('A kártyaszám 4111 1111 1111 1111 lehet.')
    assert.ok(!text.includes('4111 1111 1111 1111'), 'a PAN nem maradhat a szövegben')
    assert.ok(text.includes('«redaktált:'), 'redakciós jelölő')
    assert.ok(redactedCount >= 1)
  })

  await check('content-guard: IBAN + titok + email redaktalva, tiszta szoveg valtozatlan', () => {
    const iban = redactSensitiveText('Számla: HU42 1177 3016 1111 1018 0000 0000')
    assert.ok(!iban.text.includes('HU42 1177 3016'), 'IBAN nem maradhat')

    const secret = redactSensitiveText('api_key: sk-abcdefghijklmnopqrstuvwxyz012345')
    assert.ok(!secret.text.includes('sk-abcdefghijklmnopqrstuvwxyz012345'), 'titok nem maradhat')
    assert.ok(secret.text.includes('api_key:'), 'a kulcs kontextus megmarad')

    const email = redactSensitiveText('Írj a teszt.user@example.com címre.')
    assert.ok(!email.text.includes('teszt.user@example.com'), 'email nem maradhat')

    const clean = redactSensitiveText('Ez egy teljesen ártalmatlan gondolat.')
    assert.equal(clean.redactedCount, 0)
    assert.equal(clean.text, 'Ez egy teljesen ártalmatlan gondolat.')
  })

  await check('content-guard stream: delta-határon szétszakadó PAN és IBAN sem szivárog ki', () => {
    const emitted: string[] = []
    const guard = new StreamingSensitiveTextRedactor((text) => emitted.push(text))

    guard.push('Kártya: 4111 1111')
    guard.push(' 1111 1111.\nIBAN: HU42 1177 3016')
    guard.push(' 1111 1018 0000 0000\n')
    guard.finish()

    const output = emitted.join('')
    assert.ok(!output.includes('4111 1111 1111 1111'), 'a szétszakított PAN nem mehet ki')
    assert.ok(!output.includes('HU42 1177 3016 1111'), 'a szétszakított IBAN nem mehet ki')
    assert.ok(output.includes('«redaktált:'), 'redakciós jelölő kimegy')
  })

  await check('content-guard stream: többsoros privát kulcs teljes törzse visszatartva és redaktálva', () => {
    const emitted: string[] = []
    const guard = new StreamingSensitiveTextRedactor((text) => emitted.push(text))

    guard.push('Előtte biztonságos sor.\n-----BEGIN PRIVATE KEY-----\nMIIE')
    assert.ok(emitted.join('').startsWith('Előtte biztonságos sor.\n'))
    assert.ok(emitted.join('').includes('«redaktált:titok»'))
    guard.push('vQIBADANBgkqhkiG9w0BAQEFAASCBK')
    assert.ok(!emitted.join('').includes('MIIEvQIB'), 'a nyitott kulcsblokk törzse nem mehet ki')
    guard.push('QAwggSkAgEAAoIBAQ==\n-----END PRIVATE KEY-----\nUtána.\n')
    guard.finish()

    const output = emitted.join('')
    assert.ok(!output.includes('MIIEvQIB'), 'a privát kulcs törzse nem maradhat a kimenetben')
    assert.ok(output.includes('«redaktált:titok»'))
    assert.ok(output.endsWith('Utána.\n'))
  })

  await check('content-guard stream: lezáratlan privát kulcs törzse korlátosan eldobódik', () => {
    const emitted: string[] = []
    const guard = new StreamingSensitiveTextRedactor((text) => emitted.push(text))
    guard.push(`-----BEGIN PRIVATE KEY-----\n${'A'.repeat(10_000)}`)
    guard.push('további-kulcstörzs')
    guard.finish()

    assert.equal(emitted.join(''), '«redaktált:titok»')
  })

  await check('content-guard stream: hosszú, újsor nélküli reasoning menet közben is ürül', () => {
    const emitted: string[] = []
    const guard = new StreamingSensitiveTextRedactor((text) => emitted.push(text))
    guard.push('Biztonságos gondolat '.repeat(40))
    assert.ok(emitted.length > 0, 'a guard nem várhat a teljes turn végéig')
    guard.finish()
    assert.equal(emitted.join(''), 'Biztonságos gondolat '.repeat(40))
  })

  await check('content-guard stream: határoló nélküli óriás secret fail-closed és korlátos', () => {
    const emitted: string[] = []
    const guard = new StreamingSensitiveTextRedactor((text) => emitted.push(text))
    const secret = `api_key:${'x'.repeat(5000)}`
    guard.push(secret)
    guard.push(' biztonságos folytatás\n')
    guard.finish()

    const output = emitted.join('')
    assert.ok(!output.includes('x'.repeat(100)), 'az óriás secret részlete sem mehet ki')
    assert.ok(output.includes('«redaktált:hosszú, nem ellenőrizhető reasoning-token»'))
    assert.ok(output.endsWith('biztonságos folytatás\n'))
  })

  await check('WP-7 openrouter: reasoning.exclude=false + delta forward ha keres reasoning-et', async () => {
    const originalFetch = globalThis.fetch
    let capturedBody: Record<string, unknown> = {}
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return sseResponse([
        'data: {"choices":[{"delta":{"reasoning":"Elemzem a "}}]}',
        'data: {"choices":[{"delta":{"reasoning":"kérdést."}}]}',
        'data: {"choices":[{"delta":{"content":"Kész a "}}]}',
        'data: {"choices":[{"delta":{"content":"válasz."}}]}',
        'data: [DONE]',
      ])
    }) as typeof fetch

    process.env.OR_TEST_BASE_URL = 'https://openrouter.example/api/v1'
    process.env.OR_TEST_KEY = 'k'
    const provider = new OpenAiCompatibleProvider('or-test', 'OR_TEST_BASE_URL', undefined, 'OR_TEST_KEY', {
      apiKeyRequired: true,
      extraBody: ({ reasoningRequested }) => ({ reasoning: { exclude: !reasoningRequested } }),
    })
    try {
      const reasoning: string[] = []
      let content = ''
      for await (const chunk of provider.chatStream({
        agentId: 'a',
        messages: [{ role: 'user', content: 'kérdés' }],
        modelConfig: { provider: 'or-test', model: 'x' },
        onReasoningDelta: (d) => reasoning.push(d),
      })) {
        content += chunk
      }
      assert.deepEqual(reasoning, ['Elemzem a ', 'kérdést.'])
      assert.equal(content, 'Kész a válasz.')
      assert.deepEqual(capturedBody.reasoning, { exclude: false }, 'reasoning kért → exclude:false')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await check('WP-7 openrouter: reasoning.exclude=true ha nincs onReasoningDelta (default)', async () => {
    const originalFetch = globalThis.fetch
    let capturedBody: Record<string, unknown> = {}
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return sseResponse(['data: {"choices":[{"delta":{"content":"Szia"}}]}', 'data: [DONE]'])
    }) as typeof fetch

    process.env.OR_TEST_BASE_URL = 'https://openrouter.example/api/v1'
    process.env.OR_TEST_KEY = 'k'
    const provider = new OpenAiCompatibleProvider('or-test', 'OR_TEST_BASE_URL', undefined, 'OR_TEST_KEY', {
      apiKeyRequired: true,
      extraBody: ({ reasoningRequested }) => ({ reasoning: { exclude: !reasoningRequested } }),
    })
    try {
      let content = ''
      for await (const chunk of provider.chatStream({
        agentId: 'a',
        messages: [{ role: 'user', content: 'szia' }],
        modelConfig: { provider: 'or-test', model: 'x' },
      })) {
        content += chunk
      }
      assert.equal(content, 'Szia')
      assert.deepEqual(capturedBody.reasoning, { exclude: true }, 'nincs reasoning-kérés → exclude:true')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await check('WP-8 gemini: thought-partok kulon valnak a valasz-parttol', () => {
    const thought = extractGeminiThoughtText({
      candidates: [
        {
          content: {
            parts: [
              { text: 'Először átgondolom. ', thought: true },
              { text: 'Aztán döntök.', thought: true },
              { text: 'A végleges válasz.' },
            ],
          },
        },
      ],
    })
    assert.equal(thought, 'Először átgondolom. Aztán döntök.')

    // Thought-part nélkül üres string (E1 fallback: nincs event).
    assert.equal(
      extractGeminiThoughtText({ candidates: [{ content: { parts: [{ text: 'csak válasz' }] } }] }),
      '',
    )
    assert.equal(extractGeminiThoughtText({}), '')
  })

  await check('feature-flag: fail-closed default off, set utan on, tenant nelkul off', async () => {
    const store = new Map<string, unknown>()
    const settingsRepo: PlatformSettingsRepository = {
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => {
        store.set(key, value)
      },
    }
    const auditRepo = {
      append: async (event: { action: string }) => assertAuditActionRegistered(event.action),
    } as unknown as AuditRepository
    const svc = new PlatformSettingsService(settingsRepo, auditRepo)

    assert.equal(await svc.isChatThinkingTraceEnabledForTenant('tenant-1'), false)
    assert.equal(await svc.isChatThinkingTraceEnabledForTenant(null), false)

    await svc.setTenantThinkingTraceControls('tenant-1', { enabled: true }, 'user-1')
    assert.equal(await svc.isChatThinkingTraceEnabledForTenant('tenant-1'), true)
    // Az érték változatlan mentése a config_changed audit actiont is ellenőrzi.
    await svc.setTenantThinkingTraceControls('tenant-1', { enabled: true }, 'user-1')
    // Más tenant nem érintett.
    assert.equal(await svc.isChatThinkingTraceEnabledForTenant('tenant-2'), false)
    // A system (tenant nélküli) agent továbbra is kikapcsolt.
    assert.equal(await svc.isChatThinkingTraceEnabledForTenant(null), false)

    await svc.setTenantThinkingTraceControls('tenant-1', { enabled: false }, 'user-1')
    assert.equal(await svc.isChatThinkingTraceEnabledForTenant('tenant-1'), false)
  })

  await check('feature-flag kliens: kikapcsolva eldobja, bekapcsolva felhalmozza a thinking deltát', () => {
    const current = { 'reasoning-0': 'Első ' }
    const event = { turnId: 'reasoning-0', delta: 'második.' }

    assert.equal(
      appendThinkingDelta(current, event, 'disabled'),
      current,
      'kikapcsolva ugyanazt az állapotot adja vissza',
    )
    assert.equal(canStartThinkingTraceStream('loading'), false)
    assert.equal(canStartThinkingTraceStream('disabled'), true)
    assert.equal(canStartThinkingTraceStream('enabled'), true)
    assert.deepEqual(appendThinkingDelta(current, event, 'enabled'), {
      'reasoning-0': 'Első második.',
    })
  })

  console.log(`\n=== Osszesites === ${failures === 0 ? 'MIND ZOLD' : `${failures} sikertelen`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
