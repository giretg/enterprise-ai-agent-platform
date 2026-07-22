/**
 * Kimenő átviteli kapu (CT-*) — a csatorna-réteg varrata a kimenő oldalon
 * (Telegram feature-spec #70/#71, D8/D10/D11). Fakes-szel, DB és hálózat nélkül.
 *
 * A varrat egyetlen dublőrözhető hely: a teszt-dublőr RÖGZÍTI a kimenő hívásokat, a valós
 * Telegram-adapter pedig deny-by-default egress-őrön megy át (CSAK az api.telegram.org),
 * és a bot-token SOHA nem szivárog ki a blokk-detailbe.
 */
import assert from 'node:assert/strict'
import {
  RecordingChannelTransport,
  TelegramOutboundTransport,
} from '../src/domain/channel/channel-outbound-transport'
import { TELEGRAM_API_HOST } from '../src/domain/channel/channel-types'

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

const BOT_TOKEN = '123456:SECRET-TOKEN-do-not-leak'

/** Rögzítő fetch: minden hívás url+body-ját eltárolja, konfigurálható választ ad. */
function makeFetchSpy(
  response: { status: number; body: unknown } = { status: 200, body: { ok: true, result: { message_id: 42 } } },
) {
  const calls: { url: string; body: unknown }[] = []
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    } as Response
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

async function main() {
  console.log('=== Csatorna kimenő átviteli kapu ===')

  await test('CT-1 teszt-dublőr rögzíti a kimenő hívásokat (a varrat)', async () => {
    const transport = new RecordingChannelTransport()
    const res = await transport.send({
      channelType: 'telegram',
      method: 'sendMessage',
      payload: { chat_id: 99, text: 'szia' },
    })
    assert.equal(res.ok, true)
    assert.equal(transport.calls.length, 1)
    assert.equal(transport.calls[0].method, 'sendMessage')
    assert.deepEqual(transport.calls[0].payload, { chat_id: 99, text: 'szia' })
  })

  await test('CT-2 dublőr: a rögzített hívás nem mutálódik a hívó későbbi módosításától', async () => {
    const transport = new RecordingChannelTransport()
    const payload = { chat_id: 1, text: 'eredeti' }
    await transport.send({ channelType: 'telegram', method: 'sendMessage', payload })
    payload.text = 'megváltoztatva'
    assert.equal((transport.calls[0].payload as { text: string }).text, 'eredeti')
  })

  await test('CT-3 dublőr: előre sorba állított eredmények (FIFO), pl. bot letiltva', async () => {
    const transport = new RecordingChannelTransport()
    transport.queueResults(
      { ok: false, reason: 'blocked_by_user' },
      { ok: true, providerMessageId: '7' },
    )
    const first = await transport.send({ channelType: 'telegram', method: 'sendMessage', payload: {} })
    const second = await transport.send({ channelType: 'telegram', method: 'sendMessage', payload: {} })
    assert.equal(first.ok, false)
    assert.equal(!first.ok && first.reason, 'blocked_by_user')
    assert.equal(second.ok, true)
    assert.equal(transport.calls.length, 2)
  })

  await test('CT-4 Telegram-adapter: sikeres küldés a helyes hoston + method path', async () => {
    const { calls, fetchFn } = makeFetchSpy()
    const transport = new TelegramOutboundTransport({
      resolveBotToken: async () => BOT_TOKEN,
      fetchFn,
    })
    const res = await transport.send({
      channelType: 'telegram',
      method: 'sendMessage',
      payload: { chat_id: 5, text: 'hello' },
    })
    assert.equal(res.ok, true)
    assert.equal(res.ok && res.providerMessageId, '42')
    assert.equal(calls.length, 1)
    const url = new URL(calls[0].url)
    assert.equal(url.host, TELEGRAM_API_HOST)
    assert.ok(url.pathname.endsWith('/sendMessage'))
    assert.deepEqual(calls[0].body, { chat_id: 5, text: 'hello' })
  })

  await test('CT-5 egress deny-by-default: nem-Telegram host BLOKKOLT, nincs hálózati hívás', async () => {
    const { calls, fetchFn } = makeFetchSpy()
    const transport = new TelegramOutboundTransport({
      resolveBotToken: async () => BOT_TOKEN,
      fetchFn,
      allowlistHosts: ['evil.example.com'], // a Telegram host szándékosan NINCS az engedélylistán
    })
    const res = await transport.send({ channelType: 'telegram', method: 'sendMessage', payload: {} })
    assert.equal(res.ok, false)
    assert.equal(!res.ok && res.reason, 'egress_blocked')
    assert.equal(calls.length, 0) // az őr a fetch ELŐTT megállított
  })

  await test('CT-6 a bot-token SOHA nem szivárog ki (sem URL-detailbe, sem blokk-okba)', async () => {
    const transport = new TelegramOutboundTransport({
      resolveBotToken: async () => BOT_TOKEN,
      allowlistHosts: ['evil.example.com'],
    })
    const res = await transport.send({ channelType: 'telegram', method: 'sendMessage', payload: {} })
    assert.equal(res.ok, false)
    const serialized = JSON.stringify(res)
    assert.ok(!serialized.includes('SECRET-TOKEN'), 'a token nem lehet a válaszban')
  })

  await test('CT-7 Telegram 403 → blocked_by_user (a küldés abbamarad, D15)', async () => {
    const { fetchFn } = makeFetchSpy({ status: 403, body: { ok: false, description: 'bot was blocked by the user' } })
    const transport = new TelegramOutboundTransport({ resolveBotToken: async () => BOT_TOKEN, fetchFn })
    const res = await transport.send({ channelType: 'telegram', method: 'sendMessage', payload: {} })
    assert.equal(res.ok, false)
    assert.equal(!res.ok && res.reason, 'blocked_by_user')
  })

  await test('CT-8 egyéb provider-hiba → provider_error (nem némán elnyelt)', async () => {
    const { fetchFn } = makeFetchSpy({ status: 500, body: { ok: false } })
    const transport = new TelegramOutboundTransport({ resolveBotToken: async () => BOT_TOKEN, fetchFn })
    const res = await transport.send({ channelType: 'telegram', method: 'sendMessage', payload: {} })
    assert.equal(res.ok, false)
    assert.equal(!res.ok && res.reason, 'provider_error')
  })

  await test('CT-9 feloldás-utáni privát IP → egress_blocked (DNS-rebinding re-check)', async () => {
    const transport = new TelegramOutboundTransport({
      resolveBotToken: async () => BOT_TOKEN,
      resolveHostIps: async () => ['10.0.0.5'], // a Telegram host privát IP-re oldódik → SSRF
    })
    const res = await transport.send({ channelType: 'telegram', method: 'sendMessage', payload: {} })
    assert.equal(res.ok, false)
    assert.equal(!res.ok && res.reason, 'egress_blocked')
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt BUKOTT.`)
    process.exit(1)
  }
  console.log('\nMinden kimenő átviteli kapu teszt zöld.')
}

void main()
