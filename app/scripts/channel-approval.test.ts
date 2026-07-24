/**
 * Eseményvezérelt jóváhagyás Telegram-gombokkal (CA-*) — a csatorna-szolgáltatás NEGYEDIK
 * bejárata (Telegram feature-spec #70/#76, D5/D6/D11/D14). Fakes-szel, DB nélkül.
 *
 * A tesztek KIZÁRÓLAG külső viselkedést figyelnek: hatás éri a szolgáltatást (esemény- vagy
 * gomb-koppintás bejárat), és megnézzük, milyen KIMENŐ hívások keletkeztek (a rögzített
 * transporton), milyen állapotgép-léptetés történt (a befecskendezett transitioneren), és milyen
 * audit-hatás született. A jogosultság-forrás, a ticket-olvasó és a tárak BEFECSKENDEZETT dublőrök;
 * az ALÁÍRÓ token-port a VALÓS (a visszajátszás-védelmet élesben teszteljük).
 *
 * Varrat-esetek (#70 Testing Decisions 14–17):
 *  - 14: jóváhagyás-kapuk külön-külön (nem-jogosult / saját kérés / visszavont jog / visszajátszás
 *        / már eldöntött)
 *  - 15: gombok jogosultság-tudata (csak a jogosult döntés jelenik meg; `needs_info` sosem gomb)
 *  - 16: kettős koppintás → nyugtázás, nem hiba, nincs kettős hatás
 *  - 17: eseményvezérelt kiváltás: `awaiting_human` → azonnali értesítés
 *
 * Futtatás: npm run test:channel-approval
 */
import assert from 'node:assert/strict'
import type {
  ChannelApprovalPrompt,
  ChannelBot,
  ChannelIdentity,
  ChannelIdentityStatus,
} from '@prisma/client'
import {
  ChannelApprovalService,
  type ApprovalRecipientDirectory,
  type ApprovalTicketReader,
  type ApprovalTicketView,
  type ApprovalTransitioner,
  type ApprovalTransitionResult,
  ACKNOWLEDGED_TEXT,
  ALREADY_DECIDED_TEXT,
  NOT_RECIPIENT_TEXT,
  REPLAY_TEXT,
  REVOKED_TEXT,
  SELF_REQUEST_TEXT,
  TRANSITION_DENIED_TEXT,
} from '../src/domain/channel/channel-approval-service'
import { buildCallbackData, type ApprovalAction } from '../src/domain/channel/channel-approval-token'
import { RecordingChannelTransport } from '../src/domain/channel/channel-outbound-transport'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'
import type {
  ChannelApprovalPromptRepository,
  CreateChannelApprovalPromptInput,
} from '../src/repositories/interfaces'

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

type AuditRow = { action: string; targetType: string; policyDecision: string; metadata: Record<string, unknown> }

const TENANT_A = '11111111-1111-1111-1111-111111111111'
const TICKET = 'tttttttt-tttt-tttt-tttt-tttttttttttt'
const GATE = 'gate-1'
const USER_APPROVER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const USER_INITIATOR = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const USER_OTHER = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const SECRET = 'webhook-secret-xyz'
const clock = new Date('2026-07-24T10:00:00Z')

/**
 * Fake kripto — mint élesben: a kereső-hash egy hosszú, a nyers id-t NEM tartalmazó érték (így az
 * álnév sem szivárogtatja a chat_id-t), a chat_id feloldás `enc:<raw>` ↔ `<raw>`. Determinisztikus.
 */
const LOOKUP: Record<string, string> = {
  '9001': 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
  '9002': 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
  '9003': 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3',
}
const fakeCrypto = {
  deriveLookupHash: (_ct: string, raw: string) => LOOKUP[raw] ?? `nolookup${raw}`,
  decryptExternalId: (enc: string) => enc.replace(/^enc:/, ''),
}

function identity(over: {
  id: string
  userId: string
  raw: string
  status?: ChannelIdentityStatus
  tenantId?: string | null
}): ChannelIdentity {
  return {
    id: over.id,
    channelType: 'telegram',
    externalUserIdEnc: `enc:${over.raw}`,
    lookupHash: LOOKUP[over.raw] ?? `nolookup${over.raw}`,
    tenantId: over.tenantId !== undefined ? over.tenantId : TENANT_A,
    userId: over.userId,
    status: over.status ?? 'active',
    linkedAt: clock,
    createdAt: clock,
    updatedAt: clock,
  }
}

function makeHarness(opts?: {
  ticketState?: string
  assigneeUserId?: string | null
  allowedActions?: ApprovalAction[]
  transition?: ApprovalTransitionResult
  roleMap?: Map<string, string[]>
}) {
  const bot: ChannelBot = {
    id: 'bot-1',
    channelType: 'telegram',
    tenantId: null,
    name: 'Platform Bot',
    accessKeySecretRef: 'env:X',
    webhookSecretRef: 'env:Y',
    status: 'active',
    createdById: null,
    createdAt: clock,
    updatedAt: clock,
  }
  const bots = { async findPlatformBot() { return bot } }

  const identityRows = new Map<string, ChannelIdentity>()
  for (const row of [
    identity({ id: 'id-appr', userId: USER_APPROVER, raw: '9001' }),
    identity({ id: 'id-init', userId: USER_INITIATOR, raw: '9002' }),
    identity({ id: 'id-other', userId: USER_OTHER, raw: '9003' }),
  ]) {
    identityRows.set(row.id, row)
  }
  const identities = {
    async findByLookupHash(_ct: 'telegram', lookupHash: string) {
      return [...identityRows.values()].find((i) => i.lookupHash === lookupHash) ?? null
    },
    async findById(id: string) {
      return identityRows.get(id) ?? null
    },
    async listByUser(userId: string) {
      return [...identityRows.values()].filter((i) => i.userId === userId)
    },
    async updateStatus(id: string, status: ChannelIdentityStatus) {
      const cur = identityRows.get(id)!
      const next = { ...cur, status }
      identityRows.set(id, next)
      return next
    },
  }

  // Prompt-tár fake — az atomi `consume` és `supersedeOthers` a valós szemantikát tükrözi.
  const promptRows = new Map<string, ChannelApprovalPrompt>()
  let seq = 0
  const prompts: ChannelApprovalPromptRepository = {
    async create(input: CreateChannelApprovalPromptInput) {
      const row = {
        id: `p-${++seq}`,
        promptId: input.promptId,
        channelType: input.channelType,
        ticketId: input.ticketId,
        tenantId: input.tenantId,
        gateId: input.gateId,
        stepId: input.stepId,
        requiredActorRole: input.requiredActorRole,
        recipientIdentityId: input.recipientIdentityId,
        recipientUserId: input.recipientUserId,
        initiatorUserId: input.initiatorUserId,
        allowedActions: input.allowedActions,
        externalThreadId: input.externalThreadId,
        providerMessageId: null,
        status: 'pending',
        decidedAction: null,
        decidedByLookupHash: null,
        decidedAt: null,
        createdAt: clock,
        updatedAt: clock,
      } as ChannelApprovalPrompt
      promptRows.set(input.promptId, row)
      return row
    },
    async findByPromptId(promptId: string) {
      return promptRows.get(promptId) ?? null
    },
    async setProviderMessageId(id: string, providerMessageId: string) {
      for (const r of promptRows.values()) if (r.id === id) r.providerMessageId = providerMessageId
    },
    async consume(promptId: string, action: string, lookupHash: string, now: Date) {
      const r = promptRows.get(promptId)
      if (!r || r.status !== 'pending') return null
      r.status = 'decided'
      r.decidedAction = action
      r.decidedByLookupHash = lookupHash
      r.decidedAt = now
      return r
    },
    async supersedeOthers(ticketId: string, exceptPromptId: string) {
      for (const r of promptRows.values()) {
        if (r.ticketId === ticketId && r.status === 'pending' && r.promptId !== exceptPromptId) {
          r.status = 'superseded'
        }
      }
    },
  }

  const ticket: ApprovalTicketView = {
    ticketId: TICKET,
    tenantId: TENANT_A,
    state: opts?.ticketState ?? 'awaiting_human',
    gateId: GATE,
    stepId: 'step-1',
    requiredActorRole: 'approver',
    initiatorUserId: USER_INITIATOR,
    assigneeUserId: opts?.assigneeUserId !== undefined ? opts.assigneeUserId : null,
    title: 'Kifizetés jóváhagyása',
    detailUrl: 'https://app.example.com/control-plane/board?ticket=' + TICKET,
    allowedActions: opts?.allowedActions ?? ['approve', 'reject'],
  }
  const tickets: ApprovalTicketReader = {
    async load({ ticketId }) {
      return ticketId === TICKET ? { ...ticket } : null
    },
  }

  const roleMap =
    opts?.roleMap ??
    new Map<string, string[]>([
      [USER_APPROVER, ['approver']],
      [USER_INITIATOR, ['approver']],
      [USER_OTHER, []],
    ])
  const recipients: ApprovalRecipientDirectory = {
    async listApprovers({ requiredActorRole }) {
      const out: { userId: string; roles: string[] }[] = []
      for (const [userId, roles] of roleMap) {
        if (!requiredActorRole || roles.includes(requiredActorRole)) out.push({ userId, roles })
      }
      return out
    },
    async rolesForUser({ userId }) {
      return roleMap.get(userId) ?? []
    },
  }

  const decideCalls: Array<{ ticketId: string; toState: string; actorUserId: string; gateId: string | null }> = []
  const transitioner: ApprovalTransitioner = {
    async decide(input) {
      decideCalls.push({ ticketId: input.ticketId, toState: input.toState, actorUserId: input.actorUserId, gateId: input.gateId })
      const res = opts?.transition ?? { ok: true }
      if (res.ok) ticket.state = input.toState
      return res
    },
  }

  const initiatorCalls: Array<{ decision: ApprovalAction; initiatorUserId: string }> = []
  const initiatorNotifier = {
    async decisionMade(input: { decision: ApprovalAction; initiatorUserId: string }) {
      initiatorCalls.push({ decision: input.decision, initiatorUserId: input.initiatorUserId })
    },
  }

  const audits: AuditRow[] = []
  const audit = {
    append: async (data: { action: string; targetType: string; policyDecision: string; metadata?: unknown }) => {
      assertAuditActionRegistered(data.action)
      audits.push({
        action: data.action,
        targetType: data.targetType,
        policyDecision: data.policyDecision,
        metadata: (data.metadata ?? {}) as Record<string, unknown>,
      })
      return data as never
    },
  }

  const transport = new RecordingChannelTransport()

  const svc = new ChannelApprovalService({
    bots: bots as never,
    identities: identities as never,
    prompts,
    tickets,
    recipients,
    transitioner,
    transport,
    audit: audit as never,
    resolveWebhookSecret: async () => SECRET,
    initiatorNotifier,
    crypto: fakeCrypto,
    now: () => clock,
  })

  return { svc, transport, audits, promptRows, identityRows, decideCalls, initiatorCalls, roleMap, prompts }
}

/** A rögzített gombüzenetből kiveszi egy adott chatId + döntés callback_data-ját. */
function callbackDataFor(
  transport: RecordingChannelTransport,
  chatId: string,
  label: 'approve' | 'reject',
): string | null {
  const wanted = label === 'approve' ? '✅' : '🚫'
  for (const call of transport.calls) {
    if (call.method !== 'sendMessage') continue
    if (String(call.payload.chat_id) !== chatId) continue
    const markup = call.payload.reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> }
    for (const row of markup?.inline_keyboard ?? []) {
      for (const btn of row) {
        if (btn.text.startsWith(wanted)) return btn.callback_data
      }
    }
  }
  return null
}

function buttonsFor(transport: RecordingChannelTransport, chatId: string): string[] {
  for (const call of transport.calls) {
    if (call.method !== 'sendMessage' || String(call.payload.chat_id) !== chatId) continue
    const markup = call.payload.reply_markup as { inline_keyboard?: Array<Array<{ text: string }>> }
    return (markup?.inline_keyboard ?? []).flat().map((b) => b.text)
  }
  return []
}

async function main() {
  console.log('=== Eseményvezérelt jóváhagyás gombokkal (varrat) ===')

  await test('CA-1 (17+15) esemény → azonnali, jogosultság-tudatos gombok; kezdeményező nem kap „Jóváhagyom"-ot', async () => {
    const h = makeHarness()
    const res = await h.svc.notifyAwaitingHuman({ ticketId: TICKET, tenantId: TENANT_A })
    assert.equal(res.outcome, 'notified')
    assert.equal(res.notified, 2, 'a jóváhagyói kör mindkét tagja kapott üzenetet')

    // A tiszta jóváhagyó BOTH gombot kapja; a kezdeményező CSAK „Elutasítom"-ot (saját kérés).
    const approverButtons = buttonsFor(h.transport, '9001')
    assert.equal(approverButtons.length, 2, 'a jóváhagyó két gombot kap')
    const initiatorButtons = buttonsFor(h.transport, '9002')
    assert.equal(initiatorButtons.length, 1, 'a kezdeményező egy gombot kap')
    assert.ok(initiatorButtons[0].startsWith('🚫'), 'a kezdeményező NEM kap „Jóváhagyom" gombot (saját kérés)')

    // Két prompt sor jött létre, egyik sem tartalmaz `needs_info` gombot.
    assert.equal(h.promptRows.size, 2)
    for (const p of h.promptRows.values()) {
      assert.ok(!p.allowedActions.includes('needs_info' as never), 'a needs_info sosem gomb')
    }
    // Audit: két notified, álnevesített azonosítóval, nyers chat_id sehol.
    assert.equal(h.audits.filter((a) => a.action === 'channel.approval.notified').length, 2)
    assert.ok(!JSON.stringify(h.audits).includes('9001'), 'nyers chat_id nem kerül auditba')
  })

  await test('CA-2 (17) nem awaiting_human ticket → nincs gomb, nincs kimenő hívás', async () => {
    const h = makeHarness({ ticketState: 'approved' })
    const res = await h.svc.notifyAwaitingHuman({ ticketId: TICKET, tenantId: TENANT_A })
    assert.equal(res.outcome, 'skipped_not_awaiting')
    assert.equal(h.transport.calls.length, 0)
  })

  await test('CA-3 (14 boldog út) koppintás → a KÖZÖS állapotgép lép; gombok eltűnnek; kezdeményező értesül', async () => {
    const h = makeHarness()
    await h.svc.notifyAwaitingHuman({ ticketId: TICKET, tenantId: TENANT_A })
    const cd = callbackDataFor(h.transport, '9001', 'approve')!
    assert.ok(cd, 'van approve callback_data a jóváhagyónak')
    h.transport.reset()

    const res = await h.svc.handleApprovalCallback({
      secretHeader: SECRET,
      externalUserId: '9001',
      externalThreadId: '9001',
      callbackQueryId: 'cbq-1',
      callbackData: cd,
      messageId: 555,
    })
    assert.equal(res.outcome, 'approved')

    // A közös állapotgép lépett (approved, a kapun keresztül, a jóváhagyó a helyes user).
    assert.equal(h.decideCalls.length, 1)
    assert.equal(h.decideCalls[0].toState, 'approved')
    assert.equal(h.decideCalls[0].actorUserId, USER_APPROVER)
    assert.equal(h.decideCalls[0].gateId, GATE)

    // A gombok eltűntek (editMessageText üres inline_keyboard-dal) + válasz a koppintásra.
    const edit = h.transport.calls.find((c) => c.method === 'editMessageText')
    assert.ok(edit, 'van editMessageText a gombok eltüntetéséhez')
    const markup = edit!.payload.reply_markup as { inline_keyboard: unknown[] }
    assert.equal(markup.inline_keyboard.length, 0, 'a gombok eltűntek')
    assert.ok(h.transport.calls.some((c) => c.method === 'answerCallbackQuery'))

    // A kezdeményező értesült; audit decided.
    assert.equal(h.initiatorCalls.length, 1)
    assert.equal(h.initiatorCalls[0].decision, 'approve')
    assert.ok(h.audits.some((a) => a.action === 'channel.approval.decided' && a.policyDecision === 'approved'))
    // A prompt egyszer-használatos: decided.
    const decided = [...h.promptRows.values()].find((p) => p.recipientUserId === USER_APPROVER)!
    assert.equal(decided.status, 'decided')
  })

  await test('CA-4 (16) kettős koppintás ugyanazzal a fiókkal → NYUGTÁZÁS, nincs második állapotgép-lépés', async () => {
    const h = makeHarness()
    await h.svc.notifyAwaitingHuman({ ticketId: TICKET, tenantId: TENANT_A })
    const cd = callbackDataFor(h.transport, '9001', 'approve')!
    await h.svc.handleApprovalCallback({
      secretHeader: SECRET, externalUserId: '9001', externalThreadId: '9001',
      callbackQueryId: 'cbq-1', callbackData: cd, messageId: 555,
    })
    const decideCountAfterFirst = h.decideCalls.length
    h.transport.reset()

    // Ugyanaz a fiú, ugyanaz a gomb, mégegyszer.
    const res = await h.svc.handleApprovalCallback({
      secretHeader: SECRET, externalUserId: '9001', externalThreadId: '9001',
      callbackQueryId: 'cbq-2', callbackData: cd, messageId: 555,
    })
    assert.equal(res.outcome, 'acknowledged')
    assert.equal(h.decideCalls.length, decideCountAfterFirst, 'nincs kettős hatás (nem lép újra az állapotgép)')
    const answer = h.transport.calls.find((c) => c.method === 'answerCallbackQuery')
    assert.equal(answer!.payload.text, ACKNOWLEDGED_TEXT, 'nyugtázás, nem ijesztő hiba')
    assert.ok(h.audits.some((a) => a.action === 'channel.approval.acknowledged'))
  })

  await test('CA-5 (14 saját kérés) a kezdeményező „Jóváhagyom" koppintása → tiltva', async () => {
    // Direkt seedelünk egy promptot, ahol a kezdeményező identitása a címzett és az approve KIAJÁNLOTT
    // (élesben a gomb-szűrés ezt kizárná; itt a callback-oldali kaput teszteljük külön).
    const h = makeHarness()
    await h.prompts.create({
      promptId: 'seed-self',
      channelType: 'telegram',
      ticketId: TICKET,
      tenantId: TENANT_A,
      gateId: GATE,
      stepId: 'step-1',
      requiredActorRole: 'approver',
      recipientIdentityId: 'id-init',
      recipientUserId: USER_INITIATOR,
      initiatorUserId: USER_INITIATOR,
      allowedActions: ['approve', 'reject'],
      externalThreadId: '9002',
    })
    const cd = buildCallbackData({
      promptId: 'seed-self', action: 'approve', ticketId: TICKET, gateId: GATE, recipientIdentityId: 'id-init',
    })
    const res = await h.svc.handleApprovalCallback({
      secretHeader: SECRET, externalUserId: '9002', externalThreadId: '9002',
      callbackQueryId: 'cbq-1', callbackData: cd, messageId: 1,
    })
    assert.equal(res.outcome, 'unauthorized')
    assert.equal(h.decideCalls.length, 0, 'a saját kérés nem lépteti az állapotgépet')
    const answer = h.transport.calls.find((c) => c.method === 'answerCallbackQuery')
    assert.equal(answer!.payload.text, SELF_REQUEST_TEXT)
    assert.ok(h.audits.some((a) => a.action === 'channel.approval.rejected' && a.policyDecision === 'self_request'))
  })

  await test('CA-6 (14 visszajátszás) ismeretlen payload és hamis aláírás → elutasítva, nincs állapotgép-lépés', async () => {
    // a) ismeretlen promptId
    const h = makeHarness()
    const unknown = buildCallbackData({
      promptId: 'does-not-exist', action: 'approve', ticketId: TICKET, gateId: GATE, recipientIdentityId: 'id-appr',
    })
    const r1 = await h.svc.handleApprovalCallback({
      secretHeader: SECRET, externalUserId: '9001', externalThreadId: '9001',
      callbackQueryId: 'cbq-1', callbackData: unknown, messageId: 1,
    })
    assert.equal(r1.outcome, 'replay')
    assert.equal(h.transport.calls.find((c) => c.method === 'answerCallbackQuery')!.payload.text, REPLAY_TEXT)

    // b) valós prompt, de MEGHAMISÍTOTT aláírás
    await h.svc.notifyAwaitingHuman({ ticketId: TICKET, tenantId: TENANT_A })
    const cd = callbackDataFor(h.transport, '9001', 'approve')!
    const tampered = cd.slice(0, -1) + (cd.endsWith('A') ? 'B' : 'A')
    h.transport.reset()
    const r2 = await h.svc.handleApprovalCallback({
      secretHeader: SECRET, externalUserId: '9001', externalThreadId: '9001',
      callbackQueryId: 'cbq-2', callbackData: tampered, messageId: 1,
    })
    assert.equal(r2.outcome, 'replay')
    assert.equal(h.decideCalls.length, 0)
    assert.ok(h.audits.some((a) => a.action === 'channel.approval.rejected'))
  })

  await test('CA-7 (14 visszavont jog) koppintáskor élő ellenőrzés: elvett szerep / inaktív kötés → érthető elutasítás', async () => {
    // a) visszavont szerep a koppintás pillanatában
    const h = makeHarness()
    await h.svc.notifyAwaitingHuman({ ticketId: TICKET, tenantId: TENANT_A })
    const cd = callbackDataFor(h.transport, '9001', 'approve')!
    h.roleMap.set(USER_APPROVER, []) // időközben elvették a jogát
    h.transport.reset()
    const r1 = await h.svc.handleApprovalCallback({
      secretHeader: SECRET, externalUserId: '9001', externalThreadId: '9001',
      callbackQueryId: 'cbq-1', callbackData: cd, messageId: 1,
    })
    assert.equal(r1.outcome, 'unauthorized')
    assert.equal(h.decideCalls.length, 0)
    assert.equal(h.transport.calls.find((c) => c.method === 'answerCallbackQuery')!.payload.text, REVOKED_TEXT)

    // b) inaktív (visszavont) kötés
    const h2 = makeHarness()
    await h2.svc.notifyAwaitingHuman({ ticketId: TICKET, tenantId: TENANT_A })
    const cd2 = callbackDataFor(h2.transport, '9001', 'approve')!
    await h2.identityRows.set('id-appr', { ...h2.identityRows.get('id-appr')!, status: 'revoked' })
    h2.transport.reset()
    const r2 = await h2.svc.handleApprovalCallback({
      secretHeader: SECRET, externalUserId: '9001', externalThreadId: '9001',
      callbackQueryId: 'cbq-2', callbackData: cd2, messageId: 1,
    })
    assert.equal(r2.outcome, 'unauthorized')
    assert.equal(h2.decideCalls.length, 0)
  })

  await test('CA-8 (14) más fiók koppintja a (továbbküldött) gombot → nem a címzett, elutasítva', async () => {
    const h = makeHarness()
    await h.svc.notifyAwaitingHuman({ ticketId: TICKET, tenantId: TENANT_A })
    const cd = callbackDataFor(h.transport, '9001', 'approve')!
    h.transport.reset()
    const res = await h.svc.handleApprovalCallback({
      secretHeader: SECRET, externalUserId: '9003', externalThreadId: '9003', // USER_OTHER fiókja
      callbackQueryId: 'cbq-1', callbackData: cd, messageId: 1,
    })
    assert.equal(res.outcome, 'unauthorized')
    assert.equal(h.decideCalls.length, 0)
    assert.equal(h.transport.calls.find((c) => c.method === 'answerCallbackQuery')!.payload.text, NOT_RECIPIENT_TEXT)
  })

  await test('CA-9 (14 már eldöntött) döntés után a másik címzett gombja → „már eldöntötte valaki"', async () => {
    const h = makeHarness()
    await h.svc.notifyAwaitingHuman({ ticketId: TICKET, tenantId: TENANT_A })
    const approverCd = callbackDataFor(h.transport, '9001', 'approve')!
    const initiatorRejectCd = callbackDataFor(h.transport, '9002', 'reject')!

    // A jóváhagyó dönt → a többi címzett gombja superseded lesz.
    await h.svc.handleApprovalCallback({
      secretHeader: SECRET, externalUserId: '9001', externalThreadId: '9001',
      callbackQueryId: 'cbq-1', callbackData: approverCd, messageId: 555,
    })
    h.transport.reset()

    // A kezdeményező most koppint a saját „Elutasítom" gombjára → már eldöntötték.
    const res = await h.svc.handleApprovalCallback({
      secretHeader: SECRET, externalUserId: '9002', externalThreadId: '9002',
      callbackQueryId: 'cbq-2', callbackData: initiatorRejectCd, messageId: 777,
    })
    assert.equal(res.outcome, 'already_decided')
    assert.equal(h.decideCalls.length, 1, 'csak az első döntés lépteti az állapotgépet')
    assert.equal(h.transport.calls.find((c) => c.method === 'answerCallbackQuery')!.payload.text, ALREADY_DECIDED_TEXT)
  })

  await test('CA-10 hibás titkos fejléc → csendes elutasítás, nincs kimenő hívás', async () => {
    const h = makeHarness()
    await h.svc.notifyAwaitingHuman({ ticketId: TICKET, tenantId: TENANT_A })
    const cd = callbackDataFor(h.transport, '9001', 'approve')!
    h.transport.reset()
    const res = await h.svc.handleApprovalCallback({
      secretHeader: 'WRONG', externalUserId: '9001', externalThreadId: '9001',
      callbackQueryId: 'cbq-1', callbackData: cd, messageId: 1,
    })
    assert.equal(res.outcome, 'bad_secret')
    assert.equal(h.transport.calls.length, 0, 'hibás fejlécnél nincs kimenő hívás')
  })

  await test('CA-11 a közös állapotgép elutasít (verseny/policy) → fail-closed, a webre irányít, nincs kettős hatás', async () => {
    const h = makeHarness({ transition: { ok: false, reason: 'GATE_ACTOR_ROLE' } })
    await h.svc.notifyAwaitingHuman({ ticketId: TICKET, tenantId: TENANT_A })
    const cd = callbackDataFor(h.transport, '9001', 'approve')!
    h.transport.reset()
    const res = await h.svc.handleApprovalCallback({
      secretHeader: SECRET, externalUserId: '9001', externalThreadId: '9001',
      callbackQueryId: 'cbq-1', callbackData: cd, messageId: 555,
    })
    assert.equal(res.outcome, 'transition_denied')
    assert.equal(h.transport.calls.find((c) => c.method === 'answerCallbackQuery')!.payload.text, TRANSITION_DENIED_TEXT)
    assert.ok(h.audits.some((a) => a.action === 'channel.approval.rejected' && a.policyDecision === 'transition_denied'))
    // A prompt így is elhasználódott (a retry nem halmoz kettős hatást).
    const p = [...h.promptRows.values()].find((p) => p.recipientUserId === USER_APPROVER)!
    assert.equal(p.status, 'decided')
  })

  await test('CA-12 (17) felelős beállítva → CSAK a felelős kap gombot (nem a teljes kör)', async () => {
    const h = makeHarness({ assigneeUserId: USER_APPROVER })
    const res = await h.svc.notifyAwaitingHuman({ ticketId: TICKET, tenantId: TENANT_A })
    assert.equal(res.notified, 1, 'a felelős az egyetlen címzett')
    assert.ok(buttonsFor(h.transport, '9001').length > 0)
    assert.equal(buttonsFor(h.transport, '9002').length, 0, 'a kör többi tagja nem kap, ha van felelős')
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt BUKOTT.`)
    process.exit(1)
  }
  console.log('\nMinden eseményvezérelt jóváhagyás varrat-teszt zöld.')
}

void main()
