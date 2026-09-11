/**
 * issue #375 — munka-nyomonkövethetőség tiszta nézetmodell.
 * Futtatás: npx tsx scripts/work-traceability.test.ts
 */
import assert from 'node:assert/strict'
import {
  assembleTaskBriefingDraft,
  briefingFromPayload,
  briefingHasSource,
  boardTicketTileStates,
  buildChatTaskCardView,
  buildMemoryStripView,
  compactTicketStateLabel,
  countBoardTicketsByTileState,
  conversationOriginHref,
  formatBecameLabel,
  formatChatTaskCardMeta,
  formatOriginLabel,
  formatTicketShortRef,
  nestProcessRunTickets,
  pickBoardColumnState,
  visibleBoardTickets,
} from '../src/lib/work-traceability'

let failures = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  ❌ ${name}`)
    console.error(error)
  }
}

function ticket(over: {
  id: string
  title: string
  state: string
  processInstanceId?: string | null
  playbookStepId?: string | null
  createdAt?: string
}) {
  return {
    id: over.id,
    title: over.title,
    state: over.state,
    processInstanceId: over.processInstanceId ?? null,
    playbookStepId: over.playbookStepId ?? null,
    createdAt: over.createdAt ?? '2026-08-22T12:00:00.000Z',
  }
}

console.log('work-traceability')

test('rövid feladat-jelölő a UUID elejéből, # nélkül sequential számot nem talál ki', () => {
  assert.equal(formatTicketShortRef('a1b2c3d4-e5f6-7890-abcd-ef0123456789'), '#a1b2c3d4')
})

test('kompakt állapot: in_progress → Fut', () => {
  assert.equal(compactTicketStateLabel('in_progress'), 'Fut')
  assert.equal(compactTicketStateLabel('awaiting_human'), 'Rád vár')
})

test('ready a chat-kártyán a valódi állapotot mutatja, nem „Készül”-t', () => {
  assert.equal(compactTicketStateLabel('ready'), 'Végrehajtásra vár')
  const card = buildChatTaskCardView({
    ticketId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    title: 'tárgyalasi-felkeszito: a Vino Trade -ről',
    state: 'ready',
    assigneeLabel: 'Réka',
    createdAt: '2026-09-11T10:30:00.000Z',
  })
  assert.equal(card.stateLabel, 'Végrehajtásra vár')
  assert.equal(card.live, false)
  assert.equal(card.state, 'ready')
})

test('Ebből lett sor a kártya állapotával', () => {
  assert.equal(
    formatBecameLabel({ ticketId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789', state: 'in_progress' }),
    'Ebből lett: #a1b2c3d4 ● Fut',
  )
})

test('eredet-címke beszélgetéscímmel és anélkül', () => {
  const at = '2026-08-22T14:03:00.000Z'
  const now = new Date('2026-08-25T10:00:00.000Z')
  assert.match(
    formatOriginLabel(
      {
        conversationId: 'c1',
        messageId: 'm1',
        agentId: 'ag1',
        agentNickname: 'Ági',
        conversationTitle: 'Ostoros feltöltés',
        at,
        href: '/x',
      },
      now,
    ),
    /^Eredet: Ági · „Ostoros feltöltés” · /,
  )
  assert.match(
    formatOriginLabel(
      {
        conversationId: 'c1',
        messageId: null,
        agentId: 'ag1',
        agentNickname: 'Ági',
        conversationTitle: null,
        at,
        href: null,
      },
      now,
    ),
    /^Eredet: Ági · /,
  )
})

test('ugrás a beszélgetés üzenetére a munkaterület chat-fülén', () => {
  assert.equal(
    conversationOriginHref({
      agentId: '11111111-1111-4111-8111-111111111111',
      conversationId: '22222222-2222-4222-8222-222222222222',
      messageId: '33333333-3333-4333-8333-333333333333',
    }),
    '/control-plane/agents/11111111-1111-4111-8111-111111111111/chat?conversation=22222222-2222-4222-8222-222222222222&message=33333333-3333-4333-8333-333333333333',
  )
  assert.equal(
    conversationOriginHref({ agentId: null, conversationId: 'c', messageId: 'm' }),
    null,
  )
})

test('élő kártya: lépés, eltelt idő, hozzárendelt', () => {
  const card = buildChatTaskCardView({
    ticketId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    title: 'Adatok értelmezése és feltöltése',
    state: 'in_progress',
    assigneeLabel: 'Ági',
    createdAt: '2026-08-25T09:41:00.000Z',
    stepsDone: 3,
    stepsTotal: 5,
    now: new Date('2026-08-25T10:00:00.000Z'),
  })
  assert.equal(card.shortRef, '#a1b2c3d4')
  assert.equal(card.stateLabel, 'Fut')
  assert.equal(card.live, true)
  assert.equal(formatChatTaskCardMeta(card), '3/5 lépés · 19 perce · Ági')
  assert.equal(card.href, '/control-plane/tickets/a1b2c3d4-e5f6-7890-abcd-ef0123456789')
})

test('kész kártyán nincs eltelt-idő sor', () => {
  const card = buildChatTaskCardView({
    ticketId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    title: 'Kész feladat',
    state: 'done',
    assigneeLabel: 'Ági',
    createdAt: '2026-08-25T09:41:00.000Z',
    now: new Date('2026-08-25T10:00:00.000Z'),
  })
  assert.equal(card.live, false)
  assert.equal(card.elapsedLabel, null)
  assert.equal(formatChatTaskCardMeta(card), 'Ági')
})

test('folyamat-lépések beolvadnak a szülő kártyába, a gyerekek eltűnnek a tábláról', () => {
  const root = ticket({
    id: 'root',
    title: 'Tulajdoni lap feltöltés',
    state: 'in_progress',
    processInstanceId: 'proc-1',
    createdAt: '2026-08-22T10:00:00.000Z',
  })
  const review = ticket({
    id: 'review',
    title: 'Emberi felülvizsgálat: A(z) «feldolgozottLapPath…»',
    state: 'awaiting_human',
    processInstanceId: 'proc-1',
    playbookStepId: 'human_review',
    createdAt: '2026-08-22T11:00:00.000Z',
  })
  const step = ticket({
    id: 'step',
    title: 'Adatok értelmezése',
    state: 'done',
    processInstanceId: 'proc-1',
    playbookStepId: 'parse',
    createdAt: '2026-08-22T10:30:00.000Z',
  })
  const lone = ticket({
    id: 'lone',
    title: 'Önálló chat-feladat',
    state: 'ready',
  })

  const nested = nestProcessRunTickets([root, review, step, lone], new Map([
    [
      'proc-1',
      {
        rootTicketId: 'root',
        steps: [
          { ticketId: 'step', stepId: 'parse', stepName: 'Értelmezés', status: 'completed' },
          { ticketId: 'review', stepId: 'human_review', stepName: 'Felülvizsgálat', status: 'awaiting_gate' },
        ],
      },
    ],
  ]))

  const visible = visibleBoardTickets(nested)
  assert.equal(visible.length, 2)
  const parent = visible.find((row) => row.id === 'root')
  assert.ok(parent)
  assert.equal(parent.hiddenAsProcessChild, false)
  assert.equal(parent.boardColumnState, 'awaiting_human')
  assert.equal(parent.openTicketId, 'review')
  assert.equal(parent.stepsTotal, 2)
  assert.equal(parent.stepsDone, 1)
  assert.equal(parent.nestedSteps.map((s) => s.stepName).join(','), 'Értelmezés,Felülvizsgálat')
  assert.equal(visible.find((row) => row.id === 'lone')?.boardColumnState, 'ready')
  assert.equal(nested.filter((row) => row.hiddenAsProcessChild).length, 2)
})

test('fallback emberi ticket a lépéslistában és a szülő oszlopában, ha nincs ProcessStepInstance-ben', () => {
  const root = ticket({
    id: 'root',
    title: 'PDF beolvasás',
    state: 'done',
    processInstanceId: 'proc-2',
    playbookStepId: 'pdf_beolvasas',
    createdAt: '2026-08-31T08:13:50.000Z',
  })
  const review = ticket({
    id: 'review',
    title: 'Emberi felülvizsgálat: pdf_beolvasas',
    state: 'awaiting_human',
    processInstanceId: 'proc-2',
    playbookStepId: 'pdf_beolvasas',
    createdAt: '2026-08-31T08:15:03.000Z',
  })
  const nested = nestProcessRunTickets([root, review], new Map([
    [
      'proc-2',
      {
        rootTicketId: 'root',
        processStatus: 'awaiting_human',
        steps: [
          { ticketId: 'root', stepId: 'pdf_beolvasas', stepName: 'PDF beolvasás', status: 'completed' },
        ],
      },
    ],
  ]))
  const visible = visibleBoardTickets(nested)
  const parent = visible.find((row) => row.id === 'root')
  assert.ok(parent)
  assert.equal(parent!.boardColumnState, 'awaiting_human')
  assert.equal(parent!.openTicketId, 'review')
  assert.equal(parent!.nestedSteps.length, 2)
  assert.equal(parent!.nestedSteps[1]?.kind, 'support')
  assert.equal(parent!.nestedSteps[1]?.state, 'awaiting_human')
  assert.equal(parent!.nestedSteps[1]?.ticketId, 'review')
})

test('a board-kártya a 2. lépés ticketjét nyitja, ha az a teendő (kész 1. lépés, futó 2.)', () => {
  const first = ticket({
    id: 'step-1',
    title: 'Tulajdoni lap PDF beolvasása',
    state: 'done',
    processInstanceId: 'proc-3',
    playbookStepId: 'pdf_beolvasas',
    createdAt: '2026-08-26T13:28:27.000Z',
  })
  const second = ticket({
    id: 'step-2',
    title: 'Adatok értelmezése és feltöltése az Ostoros Föld API-n',
    state: 'in_progress',
    processInstanceId: 'proc-3',
    playbookStepId: 'adat_ertelmezes_es_feltoltes',
    createdAt: '2026-08-26T13:28:53.000Z',
  })
  const nested = nestProcessRunTickets([first, second], new Map([
    [
      'proc-3',
      {
        rootTicketId: 'step-1',
        processStatus: 'running',
        steps: [
          { ticketId: 'step-1', stepId: 'pdf_beolvasas', stepName: 'PDF beolvasás', status: 'completed' },
          { ticketId: 'step-2', stepId: 'adat_ertelmezes_es_feltoltes', stepName: 'Feltöltés', status: 'in_progress' },
        ],
      },
    ],
  ]))
  const parent = visibleBoardTickets(nested).find((row) => row.id === 'step-1')
  assert.ok(parent)
  assert.equal(parent!.openTicketId, 'step-2')
  assert.equal(parent!.boardColumnState, 'in_progress')
})

test('ha a gyökér kártya nincs a listán, a legkorábbi lépés viszi a futást', () => {
  const first = ticket({
    id: 'a',
    title: 'Első lépés',
    state: 'done',
    processInstanceId: 'p',
    playbookStepId: 's1',
    createdAt: '2026-08-22T10:00:00.000Z',
  })
  const second = ticket({
    id: 'b',
    title: 'Második lépés',
    state: 'in_progress',
    processInstanceId: 'p',
    playbookStepId: 's2',
    createdAt: '2026-08-22T11:00:00.000Z',
  })
  const nested = nestProcessRunTickets([first, second], new Map([
    [
      'p',
      {
        rootTicketId: 'missing-root',
        steps: [
          { ticketId: 'a', stepId: 's1', stepName: 'Egy', status: 'completed' },
          { ticketId: 'b', stepId: 's2', stepName: 'Kettő', status: 'in_progress' },
        ],
      },
    ],
  ]))
  const visible = visibleBoardTickets(nested)
  assert.equal(visible.length, 1)
  assert.equal(visible[0].id, 'a')
  assert.equal(visible[0].openTicketId, 'b')
  assert.equal(visible[0].boardColumnState, 'in_progress')
})

test('figyelem-sorrend: emberi kapu megelőzi a futást', () => {
  assert.equal(pickBoardColumnState(['in_progress', 'awaiting_human', 'done']), 'awaiting_human')
  assert.equal(pickBoardColumnState(['done', 'ready']), 'ready')
})

test('eligazítás a felhasználó szövegéből készül, nem külön modellhívás', () => {
  const draft = assembleTaskBriefingDraft({
    userText: '  Töltsd fel a 12 lapot  ',
    attachmentNames: ['a.json', 'b.json'],
    processName: 'Ostoros feltöltés',
    authorizeRunAs: false,
  })
  assert.equal(draft.goal, 'Töltsd fel a 12 lapot')
  assert.equal(draft.source, 'folyamat: Ostoros feltöltés · a.json, b.json')
  assert.equal(draft.approval, 'a feladó nevében fut')
  assert.equal(draft.constraint, '')
  assert.equal(briefingHasSource(draft.source), true)
  assert.equal(briefingHasSource(''), false)
  assert.equal(briefingHasSource('—'), false)
})

test('eligazítás run-as esetén a felhasználó nevét viszi', () => {
  const draft = assembleTaskBriefingDraft({
    userText: 'dolgozz',
    authorizeRunAs: true,
    skillNames: ['tulajdoni-lap'],
  })
  assert.equal(draft.approval, 'ismétlődő futáskor a feladó nevében dolgozhat')
  assert.match(draft.source, /skill: tulajdoni-lap/)
})

test('eligazítás kerekítése a ticket payloadból', () => {
  assert.equal(briefingFromPayload({ question: 'x' }), null)
  const parsed = briefingFromPayload({
    briefing: { goal: 'feltöltés', source: '/ws/*.json', constraint: 'hiányzó hrsz-nél ne írj', approval: 'kell' },
  })
  assert.deepEqual(parsed, {
    goal: 'feltöltés',
    source: '/ws/*.json',
    constraint: 'hiányzó hrsz-nél ne írj',
    approval: 'kell',
  })
})

test('emlékezet-csík hétköznapi mondat, csonkolást megvallja', () => {
  const view = buildMemoryStripView({
    agentNickname: 'Ági',
    conversationMessageCount: 20,
    recencyWindowMessages: 16,
    projectMemory: [{ title: 'Döntés: API-ra töltsünk', type: 'decision' }],
    openTasks: [
      { id: 't1', title: 'Feltöltés', state: 'in_progress' },
      { id: 't2', title: 'Ellenőrzés', state: 'awaiting_human' },
    ],
    workspaceFiles: ['feldolgozott/a.json'],
  })
  assert.equal(view.truncated, true)
  assert.equal(view.droppedMessageCount, 4)
  assert.equal(
    view.summaryLine,
    'Ági most erre emlékszik: ez a beszélgetés (16 üzenet, 4 korábbi kiesett) · projekt-memória · 2 nyitott feladat.',
  )
  assert.equal(view.details.conversation.droppedReason, 'recency_window')
})

test('rövid beszélgetésen a csík nem beszél kieső üzenetről', () => {
  const view = buildMemoryStripView({
    agentNickname: 'Ági',
    conversationMessageCount: 3,
    projectMemory: [],
    openTasks: [],
    workspaceFiles: [],
  })
  assert.equal(view.truncated, false)
  assert.equal(view.summaryLine, 'Ági most erre emlékszik: ez a beszélgetés (3 üzenet).')
})

test('a csempe-számláló a beágyazott folyamat-lépéseket is látja', () => {
  // A szülő kártya oszlopa „emberre vár", de a futásban ott áll egy indításra
  // kész lépés — a fejléc eddig 0-t mutatott rá.
  const card = {
    state: 'done',
    boardColumnState: 'awaiting_human',
    nestedSteps: [{ state: 'done' }, { state: 'ready' }],
  }
  assert.deepEqual(boardTicketTileStates(card).sort(), ['awaiting_human', 'done', 'ready'])

  const counts = countBoardTicketsByTileState([card, { state: 'done' }])
  assert.equal(counts.get('ready'), 1)
  assert.equal(counts.get('awaiting_human'), 1)
  // Egy kártya állapotonként csak egyszer számít.
  assert.equal(counts.get('done'), 2)
})

if (failures > 0) {
  console.error(`\n${failures} teszt elbukott`)
  process.exit(1)
}
console.log('ok')
