/**
 * 1:1 agent-chat a csatornán (CT-*) — a csatorna-forduló feldolgozó VARRATA (Telegram
 * feature-spec #70/#73/#74, D5/D8/D9/D10/D11/D13). Fakes-szel, DB nélkül.
 *
 * A tesztek KIZÁRÓLAG külső viselkedést figyelnek: hatás éri a szolgáltatást (sor-írás vagy
 * forduló-feldolgozás), és megnézzük, milyen KIMENŐ hívások keletkeztek — vagy nem — és milyen
 * audit-hatás született. Az agent-futásidő BEFECSKENDEZETT dublőr (a teszt a CSATORNÁT méri,
 * nem a modellt). A varrat: a `ChannelOutboundTransport` rögzítő dublőre + az audit-sor.
 *
 * Lefedett esetek (a #74 AC és a #70 Testing lista alapján):
 *   CT-1  címkézés: minden kimenő válasz elején agent + projekt (§29/§10)
 *   CT-2  gépelés-jelzés a feldolgozás alatt (§20)
 *   CT-3  24 órás gördülés: 24 órán belül ugyanaz a beszélgetés, utána új (§19/#11)
 *   CT-4  projekt-hatókör: a forduló az engedély projektkulcsával fut (D9/#12)
 *   CT-5  érzékenységi kapu: tiltott/érzékeny kimenet → blokk, a nyers szöveg SEHOL (D10/#13)
 *   CT-6  hibák: időtúllépés / modellhiba / keret elfogyott → hétköznapi magyar (§23/§24)
 *   CT-7  darabolás: hosszú válasz több, önmagában érvényes, sorrendhelyes darab (§21/#18)
 *   CT-8  fájl/hang: érthető „még nem tudom kezelni", agent-futás nélkül (§27)
 *   CT-9  agent nélkül: „szólj az adminodnak", agent-futás nélkül (§10)
 *   CT-10 fail-closed: visszavont kötés → a futásidő NEM hívódik (D2/#8)
 *   CT-11 worker-tartósság: elszállt feldolgozás → a forduló újrapróbálható (D8/#21)
 *   CT-12 bot letiltva: a küldés hibája után a kötés `blocked` (D15/#20)
 *   CT-13 tenant-határ: másik szervezet agentje nem oldódik fel (D2/#2)
 *   CT-14 sor-írás: a linking-sink bekötött üzenete tartós forduló-sort ír (D8/#73)
 *
 * Futtatás: npm run test:channel-turn
 */
import assert from 'node:assert/strict'
import type {
  ChannelAgentGrant,
  ChannelIdentity,
  ChannelIdentityStatus,
  ChannelSession,
  ChannelTurn,
} from '@prisma/client'
import {
  ChannelTurnService,
  NO_AGENT_TEXT,
  UNSUPPORTED_CONTENT_TEXT,
  SENSITIVITY_BLOCK_TEXT,
  TIMEOUT_TEXT,
  BUDGET_EXHAUSTED_TEXT,
  type ChannelAgentRuntime,
  type ChannelAgentRuntimeResult,
} from '../src/domain/channel/channel-turn-service'
import { RecordingChannelTransport } from '../src/domain/channel/channel-outbound-transport'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'

let failures = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? (e.stack ?? e.message) : e}`)
  }
}

type AuditRow = { action: string; policyDecision: string; metadata: Record<string, unknown> }

const TENANT_A = '11111111-1111-1111-1111-111111111111'
const TENANT_B = '22222222-2222-2222-2222-222222222222'
const USER_1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const AGENT_1 = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const AGENT_B = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
const THREAD = '9001'

type ConvRow = {
  id: string
  agentId: string
  tenantId: string | null
  lastMessageAt: Date
  retainUntil: Date | null
  projectKey: string
  channel: string | null
  channelExternalId: string | null
}

function makeHarness(opts?: {
  identityStatus?: ChannelIdentityStatus
  grants?: Array<{ agentId: string; projectKey: string }>
  agentTenantId?: string | null
  runtime?: ChannelAgentRuntime
}) {
  let clock = new Date('2026-07-22T10:00:00Z')
  const setClock = (d: Date) => {
    clock = d
  }
  const advanceMs = (ms: number) => {
    clock = new Date(clock.getTime() + ms)
  }

  const identity: ChannelIdentity = {
    id: 'id-1',
    channelType: 'telegram',
    externalUserIdEnc: 'enc',
    lookupHash: 'hash-1',
    tenantId: TENANT_A,
    userId: USER_1,
    status: opts?.identityStatus ?? 'active',
    linkedAt: clock,
    createdAt: clock,
    updatedAt: clock,
  }
  let identityStatus: ChannelIdentityStatus = identity.status
  const identities = {
    async findById(id: string) {
      return id === identity.id ? { ...identity, status: identityStatus } : null
    },
    async updateStatus(id: string, status: ChannelIdentityStatus) {
      if (id === identity.id) identityStatus = status
      return { ...identity, status: identityStatus }
    },
  }

  const grantRows: ChannelAgentGrant[] = (opts?.grants ?? [{ agentId: AGENT_1, projectKey: '__general__' }]).map(
    (g, i) => ({
      id: `grant-${i}`,
      identityId: identity.id,
      agentId: g.agentId,
      projectKey: g.projectKey,
      grantedById: null,
      grantedAt: clock,
      createdAt: clock,
    }),
  )
  const grants = {
    async findForIdentityAgent(identityId: string, agentId: string) {
      return grantRows.find((g) => g.identityId === identityId && g.agentId === agentId) ?? null
    },
    async listForIdentity(identityId: string) {
      return grantRows.filter((g) => g.identityId === identityId)
    },
  }

  const session: ChannelSession = {
    id: 'sess-1',
    botId: 'bot-1',
    externalThreadId: THREAD,
    conversationId: null,
    identityId: identity.id,
    activeAgentId: null,
    updateWatermark: null,
    unlinkedNoticeAt: null,
    lastActivityAt: clock,
    createdAt: clock,
    updatedAt: clock,
  }
  const sessions = {
    async findById(id: string) {
      return id === session.id ? { ...session } : null
    },
    async update(id: string, data: Partial<ChannelSession>) {
      if (id !== session.id) throw new Error('session not found')
      Object.assign(session, data)
      return { ...session }
    },
  }

  const agents = {
    async findById(id: string) {
      if (id === AGENT_1) {
        return { id: AGENT_1, name: 'Könyvelő', tenantId: opts?.agentTenantId ?? TENANT_A, personaNickname: null }
      }
      if (id === AGENT_B) {
        return { id: AGENT_B, name: 'Idegen', tenantId: TENANT_B, personaNickname: null }
      }
      return null
    },
  }

  const conversationRows = new Map<string, ConvRow>()
  let convSeq = 0
  const conversations = {
    async findById(id: string) {
      const c = conversationRows.get(id)
      return c
        ? { id: c.id, agentId: c.agentId, tenantId: c.tenantId, lastMessageAt: c.lastMessageAt, retainUntil: c.retainUntil }
        : null
    },
    async create(input: {
      tenantId: string | null
      agentId: string
      createdById: string
      projectKey: string
      channel: 'telegram'
      channelExternalId: string
      title: string | null
    }) {
      const id = `conv-${++convSeq}`
      const row: ConvRow = {
        id,
        agentId: input.agentId,
        tenantId: input.tenantId,
        lastMessageAt: new Date(clock),
        retainUntil: new Date(clock.getTime() + 30 * 24 * 60 * 60 * 1000),
        projectKey: input.projectKey,
        channel: input.channel,
        channelExternalId: input.channelExternalId,
      }
      conversationRows.set(id, row)
      return { id, retainUntil: row.retainUntil }
    },
  }

  const turnRows = new Map<string, ChannelTurn>()
  let turnSeq = 0
  const turns = {
    async enqueue(input: {
      sessionId: string
      inboundRef?: string | null
      inboundText: string | null
      inboundKind: 'text' | 'unsupported'
    }) {
      const id = `turn-${++turnSeq}`
      const row: ChannelTurn = {
        id,
        sessionId: input.sessionId,
        inboundRef: input.inboundRef ?? null,
        inboundText: input.inboundText,
        inboundKind: input.inboundKind,
        status: 'queued',
        attempts: 0,
        lastError: null,
        createdAt: new Date(clock),
        updatedAt: new Date(clock),
      }
      turnRows.set(id, row)
      return { ...row }
    },
    async findById(id: string) {
      const r = turnRows.get(id)
      return r ? { ...r } : null
    },
    async claimNextBatch(input: { limit: number; now: Date; staleRunningBefore: Date }) {
      const claimed: ChannelTurn[] = []
      for (const r of [...turnRows.values()].sort((a, b) => +a.createdAt - +b.createdAt)) {
        if (claimed.length >= input.limit) break
        const eligible =
          r.status === 'queued' || (r.status === 'running' && r.updatedAt < input.staleRunningBefore)
        if (!eligible) continue
        r.status = 'running'
        r.attempts += 1
        r.updatedAt = new Date(input.now)
        claimed.push({ ...r })
      }
      return claimed
    },
    async markDone(id: string) {
      const r = turnRows.get(id)!
      r.status = 'done'
      r.lastError = null
      return { ...r }
    },
    async markRetry(id: string, error: string) {
      const r = turnRows.get(id)!
      r.status = 'queued'
      r.lastError = error.slice(0, 500)
      return { ...r }
    },
    async markFailed(id: string, error: string) {
      const r = turnRows.get(id)!
      r.status = 'failed'
      r.lastError = error.slice(0, 500)
      return { ...r }
    },
  }

  const audits: AuditRow[] = []
  const audit = {
    append: async (data: { action: string; policyDecision: string; metadata?: unknown }) => {
      assertAuditActionRegistered(data.action)
      audits.push({
        action: data.action,
        policyDecision: data.policyDecision,
        metadata: (data.metadata ?? {}) as Record<string, unknown>,
      })
      return data as never
    },
  }

  const transport = new RecordingChannelTransport()

  const defaultRuntime: ChannelAgentRuntime = {
    async runTurn() {
      return { ok: true, text: 'Szia! Miben segíthetek?' }
    },
  }

  const svc = new ChannelTurnService({
    sessions: sessions as never,
    identities: identities as never,
    grants: grants as never,
    turns: turns as never,
    agents,
    conversations,
    runtime: opts?.runtime ?? defaultRuntime,
    transport,
    audit: audit as never,
    now: () => clock,
  })

  return {
    svc,
    transport,
    audits,
    session,
    identity,
    conversationRows,
    turnRows,
    setClock,
    advanceMs,
  }
}

/** Egy szöveges bejövő fordulót sorba ír és feldolgoz; visszaadja a lefoglalt forduló id-ját. */
async function enqueueAndProcess(
  h: ReturnType<typeof makeHarness>,
  text: string,
  kind: 'text' | 'unsupported' = 'text',
): Promise<void> {
  await h.svc.enqueueInbound({
    sessionId: h.session.id,
    identity: h.identity,
    message: { updateId: 10, externalThreadId: THREAD, externalUserId: '555', text, kind },
  })
  await h.svc.processQueued({ limit: 10 })
}

/** A rögzített `sendMessage` hívások szövegei (a `sendChatAction` nélkül). */
function sentTexts(transport: RecordingChannelTransport): string[] {
  return transport.calls
    .filter((c) => c.method === 'sendMessage')
    .map((c) => String(c.payload.text ?? ''))
}

async function main() {
  await test('CT-1 címkézés: a válasz elején agent + projekt', async () => {
    const h = makeHarness()
    await enqueueAndProcess(h, 'Szia')
    const texts = sentTexts(h.transport)
    assert.equal(texts.length, 1, 'egy kimenő üzenet')
    assert.ok(texts[0].startsWith('🤖 Könyvelő · Általános'), `címke a válasz elején: ${texts[0]}`)
    assert.ok(texts[0].includes('Szia! Miben segíthetek?'), 'a válasz szövege benne van')
  })

  await test('CT-2 gépelés-jelzés a feldolgozás alatt', async () => {
    const h = makeHarness()
    await enqueueAndProcess(h, 'Szia')
    const typing = h.transport.calls.find(
      (c) => c.method === 'sendChatAction' && c.payload.action === 'typing',
    )
    assert.ok(typing, 'kiment egy sendChatAction typing')
    // A typing MEGELŐZI a választ.
    const typingIdx = h.transport.calls.findIndex((c) => c.method === 'sendChatAction')
    const msgIdx = h.transport.calls.findIndex((c) => c.method === 'sendMessage')
    assert.ok(typingIdx < msgIdx, 'a typing a válasz előtt megy ki')
  })

  await test('CT-3 24 órás gördülés: 24 órán belül ugyanaz, utána új beszélgetés', async () => {
    const h = makeHarness()
    await enqueueAndProcess(h, 'első')
    assert.equal(h.conversationRows.size, 1, 'első üzenet → egy beszélgetés')
    const firstConvId = [...h.conversationRows.keys()][0]

    // 23 óra múlva: ugyanaz a beszélgetés folytatódik.
    h.advanceMs(23 * 60 * 60 * 1000)
    await enqueueAndProcess(h, 'másnap közel')
    assert.equal(h.conversationRows.size, 1, '24 órán belül nincs új beszélgetés')
    assert.equal(h.session.conversationId, firstConvId, 'ugyanaz a beszélgetés')

    // Újabb 25 óra múlva (az utolsó beszélgetés-üzenet a create-kori clock): új beszélgetés.
    h.advanceMs(25 * 60 * 60 * 1000)
    await enqueueAndProcess(h, 'sokkal később')
    assert.equal(h.conversationRows.size, 2, '24 óra tétlenség után új beszélgetés')
    assert.notEqual(h.session.conversationId, firstConvId, 'a munkamenet az új beszélgetésre mutat')
    const newConv = h.conversationRows.get(h.session.conversationId!)!
    assert.ok(newConv.retainUntil, 'az új beszélgetésnek saját megőrzési határideje van')
  })

  await test('CT-4 projekt-hatókör: a forduló az engedély projektkulcsával fut', async () => {
    let seenProjectKey: string | null = null
    const runtime: ChannelAgentRuntime = {
      async runTurn(input) {
        seenProjectKey = input.projectKey
        return { ok: true, text: 'ok' }
      },
    }
    const h = makeHarness({ grants: [{ agentId: AGENT_1, projectKey: 'profit-2026' }], runtime })
    await enqueueAndProcess(h, 'Szia')
    assert.equal(seenProjectKey, 'profit-2026', 'a futásidő az engedély projektkulcsával fut')
    const conv = h.conversationRows.get(h.session.conversationId!)!
    assert.equal(conv.projectKey, 'profit-2026', 'a beszélgetés az engedély projektkulcsával jött létre')
    assert.ok(sentTexts(h.transport)[0].startsWith('🤖 Könyvelő · profit-2026'), 'a címke a projektet mutatja')
  })

  await test('CT-5 érzékenységi kapu: tiltott kimenet → blokk, a nyers szöveg SEHOL', async () => {
    const raw = 'A kártyaszámod: 4111111111111111 — vigyázz rá.'
    const runtime: ChannelAgentRuntime = {
      async runTurn(): Promise<ChannelAgentRuntimeResult> {
        return { ok: true, text: raw }
      },
    }
    const h = makeHarness({ runtime })
    await enqueueAndProcess(h, 'add meg a kártyaszámom')
    const texts = sentTexts(h.transport)
    assert.equal(texts.length, 1, 'egy kimenő üzenet (a blokk)')
    assert.ok(texts[0].includes(SENSITIVITY_BLOCK_TEXT), 'a blokkoló üzenet megy ki')
    // A nyers szöveg (és a kártyaszám) EGYETLEN kimenő hívásban sem szerepel.
    for (const call of h.transport.calls) {
      const serialized = JSON.stringify(call.payload)
      assert.ok(!serialized.includes('4111111111111111'), 'a kártyaszám nincs kimenő hívásban')
    }
    const blocked = h.audits.find((a) => a.action === 'channel.message.blocked')
    assert.ok(blocked, 'channel.message.blocked audit született')
    assert.equal(blocked!.policyDecision, 'forbidden', 'a szint forbidden')
    assert.ok(
      !JSON.stringify(blocked!.metadata).includes('4111111111111111'),
      'a nyers találat nincs az auditban (csak a kategória)',
    )
  })

  await test('CT-6 hibák: időtúllépés és keret-elfogyás → hétköznapi magyar', async () => {
    for (const [reason, expected] of [
      ['timeout', TIMEOUT_TEXT],
      ['budget_exhausted', BUDGET_EXHAUSTED_TEXT],
    ] as const) {
      const runtime: ChannelAgentRuntime = {
        async runTurn(): Promise<ChannelAgentRuntimeResult> {
          return { ok: false, reason }
        },
      }
      const h = makeHarness({ runtime })
      await enqueueAndProcess(h, 'kérdés')
      const texts = sentTexts(h.transport)
      assert.equal(texts.length, 1, `${reason}: egy kimenő üzenet`)
      assert.ok(texts[0].includes(expected), `${reason}: a megfelelő hétköznapi üzenet megy ki`)
    }
  })

  await test('CT-7 darabolás: hosszú válasz több, önmagában érvényes, sorrendhelyes darab', async () => {
    // Két hosszú bekezdés, ~3000 karakter egyenként → két darab.
    const p1 = 'ALFA ' + 'a'.repeat(3000)
    const p2 = 'BÉTA ' + 'b'.repeat(3000)
    const runtime: ChannelAgentRuntime = {
      async runTurn(): Promise<ChannelAgentRuntimeResult> {
        return { ok: true, text: `${p1}\n\n${p2}` }
      },
    }
    const h = makeHarness({ runtime })
    await enqueueAndProcess(h, 'mesélj hosszan')
    const texts = sentTexts(h.transport)
    assert.ok(texts.length >= 2, `több darab keletkezett (${texts.length})`)
    // Minden darab önmagában érvényes: mindegyik a címkével kezdődik.
    for (const t of texts) {
      assert.ok(t.startsWith('🤖 Könyvelő · Általános'), 'minden darab elején ott a címke')
    }
    // Sorrendhelyes: az ALFA az első darabban, a BÉTA egy későbbiben.
    const alfaIdx = texts.findIndex((t) => t.includes('ALFA'))
    const betaIdx = texts.findIndex((t) => t.includes('BÉTA'))
    assert.ok(alfaIdx >= 0 && betaIdx >= 0 && alfaIdx < betaIdx, 'a darabok sorrendhelyesek')
    assert.ok(texts[0].includes('(1/'), 'darab-jelölő a több-darabos válaszon')
  })

  await test('CT-8 fájl/hang: érthető „még nem tudom kezelni", agent-futás nélkül', async () => {
    let ran = false
    const runtime: ChannelAgentRuntime = {
      async runTurn(): Promise<ChannelAgentRuntimeResult> {
        ran = true
        return { ok: true, text: 'nem szabadna' }
      },
    }
    const h = makeHarness({ runtime })
    await enqueueAndProcess(h, null as unknown as string, 'unsupported')
    assert.equal(ran, false, 'a futásidő NEM hívódott')
    const texts = sentTexts(h.transport)
    assert.equal(texts.length, 1, 'egy kimenő üzenet')
    assert.ok(texts[0].includes(UNSUPPORTED_CONTENT_TEXT), 'az érthető elutasítás megy ki')
  })

  await test('CT-9 agent nélkül: „szólj az adminodnak", agent-futás nélkül', async () => {
    let ran = false
    const runtime: ChannelAgentRuntime = {
      async runTurn(): Promise<ChannelAgentRuntimeResult> {
        ran = true
        return { ok: true, text: 'nem szabadna' }
      },
    }
    const h = makeHarness({ grants: [], runtime })
    await enqueueAndProcess(h, 'Szia')
    assert.equal(ran, false, 'a futásidő NEM hívódott')
    assert.ok(sentTexts(h.transport)[0].includes(NO_AGENT_TEXT), 'az útmutató üzenet megy ki')
  })

  await test('CT-10 fail-closed: visszavont kötés → a futásidő NEM hívódik', async () => {
    let ran = false
    const runtime: ChannelAgentRuntime = {
      async runTurn(): Promise<ChannelAgentRuntimeResult> {
        ran = true
        return { ok: true, text: 'nem szabadna' }
      },
    }
    const h = makeHarness({ identityStatus: 'revoked', runtime })
    await enqueueAndProcess(h, 'Szia')
    assert.equal(ran, false, 'a futásidő NEM hívódott (fail-closed)')
    assert.equal(sentTexts(h.transport).length, 0, 'nincs kimenő üzenet visszavont kötésnél')
  })

  await test('CT-11 worker-tartósság: elszállt feldolgozás → a forduló újrapróbálható', async () => {
    let calls = 0
    const runtime: ChannelAgentRuntime = {
      async runTurn(): Promise<ChannelAgentRuntimeResult> {
        calls += 1
        if (calls === 1) throw new Error('boom')
        return { ok: true, text: 'második nekifutásra siker' }
      },
    }
    const h = makeHarness({ runtime })
    await h.svc.enqueueInbound({
      sessionId: h.session.id,
      identity: h.identity,
      message: { updateId: 10, externalThreadId: THREAD, externalUserId: '555', text: 'Szia', kind: 'text' },
    })
    // Első kör: elszáll → a forduló visszakerül `queued`-re (nem `failed`).
    await h.svc.processQueued({ limit: 10 })
    const turnId = [...h.turnRows.keys()][0]
    assert.equal(h.turnRows.get(turnId)!.status, 'queued', 'elszállás után újrapróbálható (queued)')
    assert.ok(h.turnRows.get(turnId)!.lastError, 'a hibaok rögzült')
    assert.equal(sentTexts(h.transport).length, 0, 'első körben nincs válasz')
    // Második kör: siker.
    await h.svc.processQueued({ limit: 10 })
    assert.equal(h.turnRows.get(turnId)!.status, 'done', 'második körben kész')
    assert.ok(sentTexts(h.transport)[0].includes('második nekifutásra siker'), 'a válasz kiment')
  })

  await test('CT-12 bot letiltva: küldési hiba után a kötés blocked → utána fail-closed', async () => {
    const h = makeHarness()
    // A válasz-küldés „bot letiltva" hibát ad (a typing sikeres, a sendMessage 403-as).
    h.transport.queueResults(
      { ok: true, providerMessageId: null }, // sendChatAction typing
      { ok: false, reason: 'blocked_by_user' }, // sendMessage
    )
    await enqueueAndProcess(h, 'Szia')
    // A kötés blocked-re billent → a következő üzenet már fail-closed (nincs válasz).
    h.transport.reset()
    await enqueueAndProcess(h, 'még egy')
    assert.equal(sentTexts(h.transport).length, 0, 'letiltott kötésnél már nincs kimenő válasz')
  })

  await test('CT-13 tenant-határ: másik szervezet agentje nem oldódik fel', async () => {
    let ran = false
    const runtime: ChannelAgentRuntime = {
      async runTurn(): Promise<ChannelAgentRuntimeResult> {
        ran = true
        return { ok: true, text: 'nem szabadna' }
      },
    }
    // Az engedély egy AGENT_B-re szól, ami TENANT_B-hez tartozik — az identitás TENANT_A.
    const h = makeHarness({ grants: [{ agentId: AGENT_B, projectKey: '__general__' }], runtime })
    await enqueueAndProcess(h, 'Szia')
    assert.equal(ran, false, 'a másik szervezet agentje nem fut')
    assert.equal(h.conversationRows.size, 0, 'nem jön létre beszélgetés idegen agenttel')
  })

  await test('CT-14 sor-írás: a bekötött üzenet tartós forduló-sort ír + audit', async () => {
    const h = makeHarness()
    const turn = await h.svc.enqueueInbound({
      sessionId: h.session.id,
      identity: h.identity,
      message: { updateId: 42, externalThreadId: THREAD, externalUserId: '555', text: 'Szia', kind: 'text' },
    })
    assert.equal(turn.status, 'queued', 'a forduló queued állapotban jött létre')
    assert.equal(turn.inboundText, 'Szia', 'a bejövő szöveg a soron van (túléli a webhook-kérést)')
    const enq = h.audits.find((a) => a.action === 'channel.turn.enqueued')
    assert.ok(enq, 'channel.turn.enqueued audit született')
    assert.ok(String(enq!.metadata.pseudonym ?? '').length > 0, 'álnevesített azonosító az auditban')
  })

  await test('CT-15 audit-katalógus: az új forduló-események regisztráltak', () => {
    for (const a of [
      'channel.turn.enqueued',
      'channel.turn.completed',
      'channel.turn.retry',
      'channel.turn.failed',
    ]) {
      assertAuditActionRegistered(a)
    }
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt bukott.`)
    process.exit(1)
  }
  console.log('\nMinden channel-turn teszt zöld.')
}

void main()
