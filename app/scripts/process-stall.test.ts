/**
 * Folyamat-elakadás nézetmodell — a „Kész feladat, közben áll a futás" eset.
 * Futtatás: npx tsx scripts/process-stall.test.ts
 */
import assert from 'node:assert/strict'
import {
  buildProcessStallNotice,
  classifyProcessSiblingKind,
  extraProcessTickets,
  findOpenHumanTicket,
  isProcessStalled,
  pickProcessOpenTicket,
  plainStallReason,
  processStepTraceStatus,
  siblingTicketKindLabel,
  stalledStepStatusLabel,
  ticketIdForProcessNode,
  type ProcessSiblingTicket,
} from '../src/lib/process-stall'

let failures = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.error(`  ❌ ${name}`)
    console.error(e)
  }
}

console.log('process-stall')

// A valós eset: 2 lépéses folyamat, az 1. lépés ticketje `done`, mellette
// „Emberi felülvizsgálat" ticket `awaiting_human`, a folyamat `awaiting_human`.
const stepTicket: ProcessSiblingTicket = {
  ticketId: 'ticket-step-1',
  title: 'Tulajdoni lap PDF beolvasása',
  state: 'done',
  stepId: 'pdf_beolvasas',
  kind: 'step',
}
const reviewTicket: ProcessSiblingTicket = {
  ticketId: 'ticket-review',
  title: 'Emberi felülvizsgálat: pdf_beolvasas',
  state: 'awaiting_human',
  stepId: 'pdf_beolvasas',
  kind: 'review',
}

test('a futó folyamat nem számít elakadtnak, a lezárt sem', () => {
  assert.equal(isProcessStalled('running'), false)
  assert.equal(isProcessStalled('completed'), false)
  assert.equal(isProcessStalled('awaiting_human'), true)
  assert.equal(isProcessStalled('blocked'), true)
  assert.equal(isProcessStalled(null), false)
})

test('gépi hibakód helyett hétköznapi mondat kerül a felületre', () => {
  const text = plainStallReason({ outcomeReason: 'tool_denied', routingReason: 'unhandled_failed' })
  assert.match(text, /nincs joga|engedély/)
  assert.doesNotMatch(text, /tool_denied|unhandled_failed|skill hatókör/)
})

test('az agent saját magyarázata megelőzi a kódfordítást', () => {
  assert.equal(
    plainStallReason({ humanSummary: 'Hiányzik a helyrajzi szám.', outcomeReason: 'tool_denied' }),
    'Hiányzik a helyrajzi szám.',
  )
})

test('ismeretlen kód sem tűnik el nyomtalanul', () => {
  assert.equal(plainStallReason({ outcomeReason: 'valami_uj_kod' }), 'valami_uj_kod')
  assert.match(plainStallReason({}), /emberi döntésre vár/)
})

test('a nyitott emberi ticketet találja meg, a lezártat nem', () => {
  assert.equal(findOpenHumanTicket([stepTicket, reviewTicket])?.ticketId, 'ticket-review')
  assert.equal(findOpenHumanTicket([stepTicket]), null)
})

test('kapu-ticket előbbre való, mint az általános felülvizsgálat', () => {
  const gate: ProcessSiblingTicket = {
    ticketId: 'ticket-gate',
    title: 'Kapu jóváhagyás: penzugy',
    state: 'awaiting_human',
    stepId: 'feltoltes',
    kind: 'gate',
  }
  assert.equal(findOpenHumanTicket([reviewTicket, gate])?.ticketId, 'ticket-gate')
})

test('a lezárt lépés-ticketen kimondja az elakadást és a következő ticketre mutat', () => {
  const notice = buildProcessStallNotice({
    processStatus: 'awaiting_human',
    currentTicketId: stepTicket.ticketId,
    siblings: [stepTicket, reviewTicket],
    blocked: { outcomeReason: 'tool_denied', routingReason: 'unhandled_failed' },
    pendingNextStep: { position: 2, stepName: 'Adatok feltöltése az API-n' },
  })
  assert.ok(notice)
  assert.equal(notice.tone, 'warning')
  assert.match(notice.headline, /elakadt/)
  assert.match(notice.reason, /nincs joga|engedély/)
  assert.match(notice.consequence ?? '', /2\. lépés/)
  assert.equal(notice.action?.ticketId, 'ticket-review')
  assert.equal(notice.action?.href, '/control-plane/tickets/ticket-review')
})

test('korábbi kész lépésen a banner a ténylegesen elakadt lépésre hivatkozik', () => {
  const notice = buildProcessStallNotice({
    processStatus: 'awaiting_human',
    currentTicketId: stepTicket.ticketId,
    currentStepId: 'pdf_beolvasas',
    siblings: [stepTicket, reviewTicket],
    blocked: { outcomeReason: 'tool_denied', stepId: 'adat_ertelmezes_es_feltoltes' },
    blockedStep: {
      position: 2,
      stepId: 'adat_ertelmezes_es_feltoltes',
      stepName: 'Adatok értelmezése és feltöltése az Ostoros Föld API-n',
    },
  })
  assert.ok(notice)
  assert.match(notice.headline, /2\. lépés/)
  assert.match(notice.headline, /Adatok értelmezése/)
  assert.doesNotMatch(notice.headline, /ezen a lépésen/)
  assert.equal(notice.action?.ticketId, 'ticket-review')
})

test('magán az elakadt lépésen „ezen a lépésen” marad a headline', () => {
  const notice = buildProcessStallNotice({
    processStatus: 'awaiting_human',
    currentTicketId: reviewTicket.ticketId,
    currentStepId: 'pdf_beolvasas',
    siblings: [stepTicket, reviewTicket],
    blocked: { outcomeReason: 'tool_denied', stepId: 'pdf_beolvasas' },
    blockedStep: { position: 1, stepId: 'pdf_beolvasas', stepName: 'Tulajdoni lap PDF beolvasása' },
  })
  assert.ok(notice)
  assert.match(notice.headline, /ezen a lépésen/)
  assert.doesNotMatch(notice.headline, /1\. lépés/)
})

test('magán a felülvizsgálati ticketen nincs továbbmutató gomb (a teendő itt van)', () => {
  const notice = buildProcessStallNotice({
    processStatus: 'awaiting_human',
    currentTicketId: reviewTicket.ticketId,
    siblings: [stepTicket, reviewTicket],
    blocked: { outcomeReason: 'tool_denied' },
    pendingNextStep: null,
  })
  assert.ok(notice)
  assert.equal(notice.action, null)
  assert.equal(notice.consequence, null)
})

test('rendben haladó folyamatnál nincs figyelmeztetés', () => {
  assert.equal(
    buildProcessStallNotice({
      processStatus: 'running',
      currentTicketId: stepTicket.ticketId,
      siblings: [stepTicket],
    }),
    null,
  )
})

test('hibás folyamat piros hangnemet kap', () => {
  const notice = buildProcessStallNotice({
    processStatus: 'failed',
    currentTicketId: stepTicket.ticketId,
    siblings: [stepTicket],
  })
  assert.equal(notice?.tone, 'danger')
  assert.match(notice?.headline ?? '', /hibával leállt/)
})

test('elakadt futásban a következő lépés nem „Következik", hanem „Nem indult el"', () => {
  assert.equal(stalledStepStatusLabel('pending', true, 'Következik'), 'Nem indult el')
  assert.equal(stalledStepStatusLabel('pending', false, 'Következik'), 'Következik')
  assert.equal(stalledStepStatusLabel('completed', true, 'Kész'), 'Kész')
})

test('a testvér-ticket fajtájának van magyar neve', () => {
  assert.equal(siblingTicketKindLabel('review'), 'Emberi felülvizsgálat')
  assert.equal(siblingTicketKindLabel('gate'), 'Jóváhagyási kapu')
  assert.equal(siblingTicketKindLabel('step'), 'Folyamat-lépés')
})

const step2Ticket: ProcessSiblingTicket & { createdAt: string } = {
  ticketId: 'ticket-step-2',
  title: 'Adatok értelmezése és feltöltése az Ostoros Föld API-n',
  state: 'done',
  stepId: 'adat_ertelmezes_es_feltoltes',
  kind: 'step',
  createdAt: '2026-08-26T13:28:53.000Z',
}
const step1Dated = { ...stepTicket, createdAt: '2026-08-26T13:28:27.000Z' }
const reviewDated = { ...reviewTicket, createdAt: '2026-08-26T13:32:22.000Z' }

test('a gyökér-ticket nem minősül felülvizsgálatnak csak azért, mert nincs a lépés-listában', () => {
  const stepIds = new Set(['ticket-step-2'])
  assert.equal(
    classifyProcessSiblingKind({ ticketId: 'ticket-step-1', title: 'PDF beolvasás', stepTicketIds: stepIds }),
    'step',
  )
  assert.equal(
    classifyProcessSiblingKind({
      ticketId: 'ticket-review',
      title: 'Emberi felülvizsgálat: adat_ertelmezes_es_feltoltes',
      playbookStepId: 'adat_ertelmezes_es_feltoltes',
      stepTicketIds: stepIds,
    }),
    'review',
  )
})

test('a folyamat megnyitása a nyitott felülvizsgálati ticketre visz, nem az első lépésre', () => {
  assert.equal(
    pickProcessOpenTicket([step1Dated, step2Ticket, reviewDated], step1Dated.ticketId)?.ticketId,
    'ticket-review',
  )
})

test('futó második lépésnél a folyamat a második ticketre nyílik', () => {
  const running = { ...step2Ticket, state: 'in_progress' }
  assert.equal(
    pickProcessOpenTicket([step1Dated, running], step1Dated.ticketId)?.ticketId,
    'ticket-step-2',
  )
})

test('kész folyamatnál a legutolsó lépés ticketjét nyitja', () => {
  const closedReview = { ...reviewDated, state: 'done' as const }
  assert.equal(
    pickProcessOpenTicket([step1Dated, step2Ticket, closedReview], step1Dated.ticketId)?.ticketId,
    'ticket-review',
  )
})

const gateTicket: ProcessSiblingTicket = {
  ticketId: 'ticket-gate',
  title: 'Kapu jóváhagyás: feltoltes',
  state: 'awaiting_human',
  stepId: 'adat_ertelmezes_es_feltoltes',
  gateId: 'feltoltes_kapu',
  kind: 'gate',
}

test('a kártyás nézetben a lépés-ticketek kimaradnak, a felülvizsgálat marad', () => {
  const extras = extraProcessTickets(
    [stepTicket, step2Ticket, reviewTicket],
    step2Ticket.ticketId,
  )
  assert.deepEqual(
    extras.map((t) => t.ticketId),
    ['ticket-review'],
  )
})

test('a gráfon látható lépés- és kapu-node ticketje nem ismétlődik a listában', () => {
  const extras = extraProcessTickets(
    [stepTicket, step2Ticket, reviewTicket, gateTicket],
    stepTicket.ticketId,
    ['pdf_beolvasas', 'adat_ertelmezes_es_feltoltes', 'feltoltes_kapu'],
  )
  assert.deepEqual(
    extras.map((t) => t.ticketId),
    ['ticket-review'],
  )
})

test('a gráf-node a lépés saját ticketjére visz, nem a felülvizsgálatra', () => {
  assert.equal(
    ticketIdForProcessNode({
      nodeId: 'pdf_beolvasas',
      nodeKind: 'step',
      steps: [
        { stepId: 'pdf_beolvasas', ticketId: stepTicket.ticketId },
        { stepId: 'adat_ertelmezes_es_feltoltes', ticketId: step2Ticket.ticketId },
      ],
      siblings: [stepTicket, step2Ticket, reviewTicket],
    }),
    stepTicket.ticketId,
  )
})

test('a kapu-node a kapu-ticketre visz', () => {
  assert.equal(
    ticketIdForProcessNode({
      nodeId: 'feltoltes_kapu',
      nodeKind: 'gate',
      steps: [{ stepId: 'adat_ertelmezes_es_feltoltes', ticketId: step2Ticket.ticketId }],
      siblings: [step2Ticket, gateTicket],
    }),
    gateTicket.ticketId,
  )
})

test('elakadt kész lépés a gráfon „vár”, nem „kész”', () => {
  assert.equal(processStepTraceStatus('completed'), 'done')
  assert.equal(processStepTraceStatus('completed', { stalledHere: true }), 'awaiting')
  assert.equal(
    processStepTraceStatus('completed', { stalledHere: true, processFailed: true }),
    'failed',
  )
  assert.equal(processStepTraceStatus('in_progress'), 'running')
  assert.equal(processStepTraceStatus('awaiting_gate'), 'awaiting')
})

if (failures > 0) {
  console.error(`\n${failures} teszt bukott`)
  process.exit(1)
}
console.log('ok')
