/**
 * Model Gateway tartalomszűrő (#773 / V1-4) — DB- és hálózat-mentes tesztek (memória-vault + hamis provider).
 * Futtatás: npm run test:model-gateway-content-filter
 */
import assert from 'node:assert/strict'
import { handleChatCompletion, type ModelCallEvent, type ModelGatewayDeps } from '../src/domain/model-gateway/proxy'
import { createContentFilterHooks, PAN_BLOCK_MESSAGE, type GatewayValVault } from '../src/domain/model-gateway/content-filter'
import { SurrogateTakenError, type InsertValInput, type ValVaultRecord } from '../src/domain/privacy/surrogate-vault'

const TENANT = '22222222-2222-4222-8222-222222222222'
const USER = '11111111-1111-4111-8111-111111111111'
const AGENT = '33333333-3333-4333-8333-333333333333'
let failures = 0

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${(e as Error).message}`)
  }
}

/** Memória-vault; a `conflictOnce` egy párhuzamos kérés ütközését szimulálja. */
function memoryVault() {
  const rows: ValVaultRecord[] = []
  const vault: GatewayValVault & { rows: ValVaultRecord[] } = {
    rows,
    async list(tenantId, scope) {
      return rows.filter((r) => r.tenantId === tenantId && r.scopeType === scope.type && r.scopeId === scope.id)
    },
    async insert(input: InsertValInput) {
      const clash = rows.some(
        (r) =>
          r.tenantId === input.tenantId &&
          r.scopeId === input.scope.id &&
          (r.surrogate === input.surrogate || (r.entityType === input.entityType && r.sourceId === input.fingerprint)),
      )
      if (clash) throw new SurrogateTakenError(input.surrogate)
      rows.push({
        id: `row-${rows.length}`, tenantId: input.tenantId, scopeType: input.scope.type, scopeId: input.scope.id,
        entityType: input.entityType, surrogate: input.surrogate, class: 'val', connectorId: '', sourceId: input.fingerprint,
        hmac: 'x', encryptedValue: input.encryptedValue,
      })
    },
  }
  return vault
}

const enc = new TextEncoder()
const completion = (message: object) =>
  new Response(JSON.stringify({ model: 'x', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }] }), { status: 200 })
const sseData = (obj: object) => `data: ${JSON.stringify(obj)}\n\n`
const chunk = (delta: object, finish: string | null = null) => sseData({ id: 'c1', model: 'x', created: 1, choices: [{ index: 0, delta, finish_reason: finish }] })
/** A hamis provider a válaszát tetszőleges (akár bájt-közepi) darabokra vágva adja. */
const streamOf = (text: string, size: number) =>
  new Response(new ReadableStream({ start(c) { for (let i = 0; i < text.length; i += size) c.enqueue(enc.encode(text.slice(i, i + size))); c.close() } }), { status: 200 })

function setup(opts: { vault?: ReturnType<typeof memoryVault>; scripts?: Array<Response | (() => Response)> } = {}) {
  const vault = opts.vault ?? memoryVault()
  const calls: Array<Record<string, unknown>> = []
  const events: ModelCallEvent[] = []
  const scripts = [...(opts.scripts ?? [])]
  const deps: ModelGatewayDeps = {
    verify: async () =>
      ({
        ok: true,
        claims: { sub: USER, tenant: 'acme', agentId: AGENT, installId: 'inst', policyVersion: 'pv1', jti: 'j', iat: 0, exp: 9e9 },
        principal: { userId: USER, tenantId: TENANT, tenantSlug: 'acme', role: 'operator', assumed: false },
      }) as never,
    loadAgentModelConfig: async () => ({ provider: 'openrouter', model: 'vendor/a', fallbackModels: [] }),
    getTenantPolicy: async () => ({ enabled: [{ provider: 'openrouter', model: 'vendor/a' }] }),
    getGlobalFallbackChain: async () => [],
    getAllowedModels: async () => null,
    providers: () => ({ baseUrl: 'https://or.test/v1', apiKey: 'sk' }),
    audit: { record: async (e) => void events.push(e) },
    hooks: createContentFilterHooks({ vault }),
    maxAttempts: 1,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string))
      const next = scripts.shift()
      if (!next) throw new Error('nincs több szkriptelt válasz')
      return typeof next === 'function' ? next() : next
    }) as never,
  }
  const call = (body: Record<string, unknown>, session = 'sess-1') =>
    handleChatCompletion(
      deps,
      new Request('https://app.test/api/model-gateway/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer t', 'x-excellence-session': session },
        body: JSON.stringify(body),
      }),
    )
  return { call, calls, events, vault }
}

const user = (content: string) => ({ role: 'user', content })
const sentTo = (calls: Array<Record<string, unknown>>, i = 0) => JSON.stringify(calls[i].messages)

async function main() {
  console.log('PAN-blokk')

  await check('PAN-t tartalmazó prompt nem jut a providerig; 200 + érthető asszisztens-üzenet', async () => {
    const s = setup()
    const res = await s.call({ messages: [user('A kártyám 4111 1111 1111 1111, ellenőrizd.')] })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.choices[0].message.content, PAN_BLOCK_MESSAGE)
    assert.equal(data.choices[0].finish_reason, 'stop')
    assert.equal(s.calls.length, 0)
  })

  await check('stream kérésre is szintetikus SSE-blokk; nincs provider-hívás', async () => {
    const s = setup()
    const res = await s.call({ stream: true, messages: [user('4111111111111111')] })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /event-stream/)
    assert.match(await res.text(), /bankkártyaszámot találtam[\s\S]*\[DONE\]/)
    assert.equal(s.calls.length, 0)
  })

  await check('tool-üzenetben, tool-argumentumban és system-ben lévő PAN is blokkol', async () => {
    const pan = '5555 5555 5555 4444'
    for (const messages of [
      [user('szia'), { role: 'tool', tool_call_id: 't1', content: `{"card":"${pan}"}` }],
      [user('szia'), { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'pay', arguments: JSON.stringify({ pan: '4111111111111111' }) } }] }],
      [{ role: 'system', content: `memória: ${pan}` }, user('szia')],
      [{ role: 'user', content: [{ type: 'text', text: `kártya ${pan}` }] }],
    ]) {
      const s = setup()
      const data = await (await s.call({ messages })).json()
      assert.equal(data.choices[0].message.content, PAN_BLOCK_MESSAGE)
      assert.equal(s.calls.length, 0)
    }
  })

  await check('audit: blocked + pan_detected, a PAN értéke nélkül (V1-5 sink a kérés nélkül kapja)', async () => {
    const s = setup()
    await s.call({ messages: [user('4012 8888 8888 1881')] })
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(s.events.length, 1)
    assert.equal(s.events[0].outcome, 'blocked')
    assert.equal(s.events[0].blockReason, 'pan_detected')
    assert.equal(s.events[0].request, null)
    assert.doesNotMatch(JSON.stringify(s.events[0]), /4012|8888|1881/)
  })

  await check('Luhn-bukó számsor és üzenethatáron összeolvadó számjegyek nem hamis PAN', async () => {
    const s = setup({ scripts: [completion({ content: 'ok' })] })
    const res = await s.call({
      messages: [
        { role: 'tool', tool_call_id: 'a', content: 'sorszám 4111 1111 11' },
        { role: 'tool', tool_call_id: 'b', content: '11 1111 rendelés 1234 5678 9012 3456' },
        user('A bevétel növekedése pozitív trendet mutat. REQ-2026-0819.'),
      ],
    })
    assert.equal((await res.json()).choices[0].message.content, 'ok')
    assert.equal(s.calls.length, 1)
  })

  console.log('Tokenizálás + visszaállítás')

  await check('e-mail a modellnél álnév, a válaszban valódi érték (legacy ft-pat-1 fixture)', async () => {
    const s = setup({ scripts: [completion({ content: 'Megírom a [[EMAIL_1]] címre.' })] })
    const res = await s.call({ messages: [user('Írjon a kovacs.janos@tesco.hu címre a részletekért.')] })
    assert.doesNotMatch(sentTo(s.calls), /kovacs\.janos@tesco\.hu/)
    assert.match(sentTo(s.calls), /\[\[EMAIL_1\]\]/)
    assert.equal((await res.json()).choices[0].message.content, 'Megírom a kovacs.janos@tesco.hu címre.')
    // az audit a providernek ténylegesen küldött (álneves) kérést tárolja, valódi érték nélkül
    await new Promise((r) => setTimeout(r, 0))
    assert.doesNotMatch(JSON.stringify(s.events[0].request), /tesco\.hu/)
  })

  await check('a következő kérésben ugyanaz az álnév (prompt-cache stabil), új érték új sorszámot kap', async () => {
    const s = setup({ scripts: [completion({ content: 'a' }), completion({ content: 'b' })] })
    await s.call({ messages: [user('Írj a kovacs.janos@tesco.hu-ra.')] })
    await s.call({ messages: [user('Írj a kovacs.janos@tesco.hu-ra.'), { role: 'assistant', content: 'ok' }, user('és a Kovacs.Janos@Tesco.hu mellé a nagy@lidl.hu-ra is')] })
    assert.equal(JSON.parse(sentTo(s.calls, 0))[0].content, 'Írj a [[EMAIL_1]]-ra.')
    const second = JSON.parse(sentTo(s.calls, 1))
    assert.equal(second[0].content, JSON.parse(sentTo(s.calls, 0))[0].content)
    assert.match(second[2].content, /\[\[EMAIL_1\]\].*\[\[EMAIL_2\]\]/)
  })

  await check('másik session másik hatókör: nem látja az előző session álneveit', async () => {
    const vault = memoryVault()
    const s = setup({ vault, scripts: [completion({ content: 'a' }), completion({ content: '[[EMAIL_1]]' })] })
    await s.call({ messages: [user('a@x.hu')] }, 'sess-A')
    const res = await s.call({ messages: [user('szia')] }, 'sess-B')
    assert.equal((await res.json()).choices[0].message.content, '[[EMAIL_1]]') // sess-B-ben nincs ilyen → nem oldódik fel
  })

  await check('tool-argumentum és tool-üzenet: a modell tool-hívásában valódi érték, a tool-eredmény álneves', async () => {
    const s = setup({
      scripts: [completion({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'gmail_send', arguments: '{"to":"[[EMAIL_1]]","body":"szia"}' } }] })],
    })
    const res = await s.call({
      messages: [user('Küldj levelet Kiss Jánosnak'), { role: 'tool', tool_call_id: 'x', content: '{"from":"Kiss János <kiss.janos@x.hu>"}' }],
    })
    assert.match(sentTo(s.calls), /\[\[PERSON_1\]\] <\[\[EMAIL_1\]\]>/)
    assert.doesNotMatch(sentTo(s.calls), /kiss\.janos@x\.hu/)
    const call = (await res.json()).choices[0].message.tool_calls[0]
    assert.deepEqual(JSON.parse(call.function.arguments), { to: 'kiss.janos@x.hu', body: 'szia' })
  })

  await check('személynév: fejlécből tanulva a session bárhol, magyar raggal is álnevezi (a későn érkező fejléc sem számít)', async () => {
    const s = setup({ scripts: [completion({ content: '[[PERSON_1]]nak megírtam' })] })
    const res = await s.call({
      messages: [
        user('Kiss Jánosnak megy a szerződés, a Kiss János aláírta.'),
        { role: 'tool', tool_call_id: 'x', content: 'From: "Kiss János" <kiss.janos@x.hu>' },
      ],
    })
    const sent = JSON.parse(sentTo(s.calls))
    assert.equal(sent[0].content, '[[PERSON_1]]nak megy a szerződés, a [[PERSON_1]] aláírta.')
    assert.equal(sent[1].content, 'From: "[[PERSON_1]]" <[[EMAIL_1]]>')
    assert.doesNotMatch(sentTo(s.calls), /Kiss/)
    assert.equal((await res.json()).choices[0].message.content, 'Kiss Jánosnak megírtam')
  })

  await check('hamis pozitív nincs: legacy FP-fixture-ök változatlanul mennek ki', async () => {
    const texts = [
      'A bevétel növekedése pozitív trendet mutat.', 'Az átlagos rendelés értéke 12 500 forint volt.', 'A jelentés 2026. augusztus 20-án készült.',
      'A kérés azonosítója: REQ-2026-0819.', 'A raktár Budapesten található.', 'A növekedés 15,3%-ot ért el az előző negyedévhez képest.',
    ]
    for (const text of texts) {
      const s = setup({ scripts: [completion({ content: 'ok' })] })
      await s.call({ messages: [user(text)] })
      assert.equal(JSON.parse(sentTo(s.calls))[0].content, text)
    }
  })

  await check('párhuzamos kérés ütközése: újratölt és a már kiosztott álnevet használja', async () => {
    const vault = memoryVault()
    const realInsert = vault.insert.bind(vault)
    let first = true
    vault.insert = async (input) => {
      if (first) {
        first = false
        await realInsert(input) // a „másik kérés" közben kiosztotta ugyanezt
        throw new SurrogateTakenError(input.surrogate)
      }
      return realInsert(input)
    }
    const s = setup({ vault, scripts: [completion({ content: 'ok' })] })
    await s.call({ messages: [user('a@x.hu és b@x.hu')] })
    assert.equal(JSON.parse(sentTo(s.calls))[0].content, '[[EMAIL_1]] és [[EMAIL_2]]')
    assert.equal(vault.rows.length, 2)
  })

  await check('fail-closed: ha a vault nem elérhető, a kérés nem megy ki', async () => {
    const vault = memoryVault()
    vault.list = async () => { throw new Error('db down') }
    const s = setup({ vault })
    const data = await (await s.call({ messages: [user('a@x.hu')] })).json()
    assert.match(data.choices[0].message.content, /személyes adatok védelme most nem működik/)
    assert.equal(s.calls.length, 0)
  })

  console.log('Streamelt visszaállítás')

  const run = async (text: string, size: number, vaultRows?: ReturnType<typeof memoryVault>) => {
    const s = setup({ vault: vaultRows, scripts: [() => streamOf(text, size)] })
    const res = await s.call({ stream: true, messages: [user('Írj a kovacs.janos@tesco.hu-ra.')] })
    return { out: await res.text(), s }
  }
  const contentOf = (sse: string) =>
    sse.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? '').join('')

  await check('darabokra szakadt álnév helyesen áll vissza, bármilyen bájt-határon', async () => {
    const text = chunk({ role: 'assistant', content: 'Küldöm a ' }) + chunk({ content: '[[EM' }) + chunk({ content: 'AIL_' }) + chunk({ content: '1]]' }) + chunk({ content: '-ra.' }, 'stop') + 'data: [DONE]\n\n'
    for (const size of [1, 2, 3, 7, 1000]) {
      const { out } = await run(text, size)
      assert.equal(contentOf(out), 'Küldöm a kovacs.janos@tesco.hu-ra.', `size=${size}`)
      assert.doesNotMatch(out, /\[\[/)
      assert.match(out, /\[DONE\]/)
    }
  })

  await check('tool-hívás argumentuma streamben, szétszakadt álnévvel is valódi értéket kap', async () => {
    const text =
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'gmail_send', arguments: '{"to":"[[EMA' } }] }) +
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'IL_1]]","body":"hi"}' } }] }, 'tool_calls') + 'data: [DONE]\n\n'
    for (const size of [1, 5, 1000]) {
      const { out } = await run(text, size)
      const args = out.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments ?? '').join('')
      assert.deepEqual(JSON.parse(args), { to: 'kovacs.janos@tesco.hu', body: 'hi' }, `size=${size}`)
    }
  })

  await check('lezáratlan „[[” a stream végén nem vész el, és a sorrend megmarad', async () => {
    const text = chunk({ role: 'assistant', content: 'Lásd: [[EMA' }, 'stop') + 'data: [DONE]\n\n'
    const { out } = await run(text, 1000)
    assert.equal(contentOf(out), 'Lásd: [[EMA')
  })

  await check('ismeretlen (kitalált) álnév érintetlen marad, a nem álnév szöveg is', async () => {
    const text = chunk({ role: 'assistant', content: 'A [[EMAIL_9]] és a tömb[[0]] meg [x]' }, 'stop') + 'data: [DONE]\n\n'
    const { out } = await run(text, 3)
    assert.equal(contentOf(out), 'A [[EMAIL_9]] és a tömb[[0]] meg [x]')
  })

  console.log(failures ? `\n${failures} teszt bukott` : '\nminden teszt zöld')
  process.exit(failures ? 1 : 0)
}

void main()
