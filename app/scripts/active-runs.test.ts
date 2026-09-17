/**
 * Unit tesztek: ticket progress flusher + active-run mapping.
 * Futtatás: npx tsx scripts/active-runs.test.ts
 */
import assert from 'node:assert/strict'
import {
  TicketProgressFlusher,
  assessTicketRunLiveness,
  boardRunPulse,
  formatTicketProgressAge,
  isTicketRunLive,
  mergeRuntimeProgressIntoPayload,
  presentTicketRunStatus,
  readTicketRuntimeProgress,
  TICKET_PROGRESS_ACTIVE_MS,
  TICKET_PROGRESS_FLUSH_INTERVAL_MS,
  TICKET_PROGRESS_STALL_MS,
} from '../src/domain/agent/ticket-runtime-progress'
import { activeRunFromChatTurn, activeRunFromTicket } from '../src/lib/active-runs-map'
import { composeRunsPanel, runsSummaryChips, summarizeRuns } from '../src/lib/active-runs-compose'
import {
  formatRunClock,
  formatRunElapsed,
  formatWorkElapsedMmSs,
  runDayLabel,
  statusLabel,
} from '../src/lib/active-runs-labels'
import { activeRunKey, workingAgentIds, type ActiveRun } from '../src/lib/active-runs'
import { summarizeAgentActivity } from '../src/lib/agent-activity'
import type { AgentTurn, Ticket } from '@prisma/client'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

console.log('active-runs / ticket-progress')

check('progress flusher throttles by interval', () => {
  let now = 0
  const flusher = new TicketProgressFlusher(() => now, TICKET_PROGRESS_FLUSH_INTERVAL_MS)
  assert.equal(
    flusher.pushActivity({ id: 'a1', kind: 'tool', title: 'tool', status: 'running' }),
    true,
  )
  // Runtime szerződés: due=true után snapshotIfDue NEM null (regresszió: dirty
  // flaget a pushActivity fogyasztotta el → soha nem íródott runtimeProgress).
  const firstSnap = flusher.snapshotIfDue()
  assert.ok(firstSnap)
  assert.equal(firstSnap!.activities.length, 1)
  assert.equal(firstSnap!.activities[0]?.status, 'running')

  assert.equal(
    flusher.pushActivity({ id: 'a1', kind: 'tool', title: 'tool', status: 'done' }),
    false,
  )
  assert.equal(flusher.snapshotIfDue(), null)

  now += TICKET_PROGRESS_FLUSH_INTERVAL_MS + 1
  assert.equal(
    flusher.pushActivity({ id: 'a2', kind: 'reasoning', title: 'gondolkodik', status: 'running' }),
    true,
  )
  const snap = flusher.snapshotIfDue()
  assert.ok(snap)
  assert.equal(snap!.activities.length, 2)
  assert.equal(snap!.activities[0]?.status, 'done')
})

check('progress flusher mirrors general-task onActivity persist path', () => {
  let now = 1_000
  const flusher = new TicketProgressFlusher(() => now, TICKET_PROGRESS_FLUSH_INTERVAL_MS)
  const persisted: string[] = []

  const onActivity = (activity: {
    id: string
    kind: 'tool' | 'reasoning'
    title: string
    status: 'running' | 'done' | 'error' | 'skipped'
  }) => {
    if (flusher.pushActivity(activity)) {
      const snap = flusher.snapshotIfDue()
      if (snap) persisted.push(snap.activities.map((a) => `${a.title}:${a.status}`).join(','))
    }
  }

  onActivity({ id: 't1', kind: 'tool', title: 'kb_search', status: 'running' })
  assert.deepEqual(persisted, ['kb_search:running'])

  onActivity({ id: 't1', kind: 'tool', title: 'kb_search', status: 'done' })
  assert.deepEqual(persisted, ['kb_search:running'])

  now += TICKET_PROGRESS_FLUSH_INTERVAL_MS + 1
  onActivity({ id: 't2', kind: 'tool', title: 'file_write', status: 'running' })
  assert.deepEqual(persisted, ['kb_search:running', 'kb_search:done,file_write:running'])
})

check('mergeRuntimeProgressIntoPayload preserves other fields', () => {
  const merged = mergeRuntimeProgressIntoPayload(
    { question: 'hello', answer: null },
    { updatedAt: '2026-01-01T00:00:00.000Z', activities: [] },
  )
  assert.equal(merged.question, 'hello')
  assert.ok(merged.runtimeProgress)
})

check('activeRunFromChatTurn builds href; canStop only for creator (E9)', () => {
  const turn = {
    id: 'turn-1',
    conversationId: 'conv-1',
    agentId: 'agent-1',
    createdById: 'user-owner',
    status: 'running',
    activities: [{ id: 'x', kind: 'tool', title: 'file_read', status: 'done' }],
    startedAt: new Date('2026-07-19T10:00:00.000Z'),
    finishedAt: null,
    cancelRequested: false,
  } as unknown as AgentTurn
  const own = activeRunFromChatTurn(turn, { userId: 'user-owner' }, 'Réka')
  assert.equal(own.kind, 'chat_turn')
  assert.equal(own.title, 'Réka')
  assert.equal(own.phase, 'active')
  assert.equal(own.canStop, true)
  assert.ok(own.href.includes('/control-plane/agents/agent-1'))
  assert.ok(own.href.includes('conversation=conv-1'))
  assert.ok(own.latestActivity?.includes('file_read'))

  const other = activeRunFromChatTurn(turn, { userId: 'user-other' }, 'Réka')
  assert.equal(other.canStop, false)
})

check('activeRunFromChatTurn uses agent name; completed has no stop', () => {
  const turn = {
    id: 'turn-2',
    conversationId: 'conv-2',
    agentId: 'agent-9',
    createdById: 'user-owner',
    status: 'completed',
    activities: [],
    startedAt: new Date('2026-07-19T10:00:00.000Z'),
    finishedAt: new Date('2026-07-19T10:05:00.000Z'),
    cancelRequested: false,
  } as unknown as AgentTurn
  const run = activeRunFromChatTurn(turn, { userId: 'user-owner' }, 'Réka')
  assert.equal(run.title, 'Réka')
  assert.equal(run.phase, 'completed')
  assert.equal(run.canStop, false)
  assert.equal(run.finishedAt, '2026-07-19T10:05:00.000Z')
})

check('activeRunFromTicket reads runtimeProgress', () => {
  const ticket = {
    id: 'ticket-1',
    title: 'Teszt ticket',
    state: 'in_progress',
    agentId: 'agent-2',
    payload: {
      runtimeProgress: {
        updatedAt: '2026-07-19T10:00:00.000Z',
        activities: [{ id: 't1', kind: 'tool', title: 'kb_search', status: 'running' }],
      },
    },
    lockedAt: new Date('2026-07-19T10:00:00.000Z'),
    updatedAt: new Date('2026-07-19T10:00:00.000Z'),
  } as unknown as Ticket
  const run = activeRunFromTicket(ticket, { nowMs: Date.parse('2026-07-19T10:00:10.000Z') })
  assert.equal(run.kind, 'ticket')
  assert.equal(run.phase, 'active')
  assert.equal(run.status, 'in_progress')
  assert.equal(run.href, '/control-plane/tickets/ticket-1')
  assert.ok(run.latestActivity?.includes('kb_search'))
})

check('activeRunFromTicket: beragadt in_progress nem „Fut”', () => {
  const ticket = {
    id: 'ticket-stalled',
    title: 'Beragadt feladat',
    state: 'in_progress',
    agentId: 'agent-2',
    payload: {
      runtimeProgress: {
        updatedAt: '2026-08-22T11:33:00.000Z',
        activities: [
          {
            id: 'reasoning-n',
            kind: 'reasoning',
            title: 'Tool eredmények kiértékelése',
            status: 'running',
          },
        ],
      },
    },
    lockedAt: new Date('2026-08-22T11:33:00.000Z'),
    updatedAt: new Date('2026-08-22T11:33:00.000Z'),
  } as unknown as Ticket
  const run = activeRunFromTicket(ticket, { nowMs: Date.parse('2026-08-24T07:58:00.000Z') })
  assert.equal(run.status, 'stalled')
  assert.equal(run.phase, 'active')
  assert.equal(run.canStop, true)
  assert.equal(statusLabel(run), 'Megállt')
})

check('activeRunFromTicket keeps human input states visible, but only running ticket stops', () => {
  const ticket = {
    id: 'ticket-waiting',
    title: 'Emberi döntés kell',
    state: 'awaiting_human',
    agentId: 'agent-2',
    payload: {},
    lockedAt: null,
    updatedAt: new Date('2026-07-19T10:10:00.000Z'),
  } as unknown as Ticket
  const run = activeRunFromTicket(ticket)
  assert.equal(run.phase, 'active')
  assert.equal(run.canStop, false)
  assert.equal(run.canStart, false)
})

check('activeRunFromTicket: ready agent ticket is startable', () => {
  const ticket = {
    id: 'ticket-ready',
    title: 'Tulajdoni lap frissítés',
    state: 'ready',
    agentId: 'agent-2',
    assigneeType: 'agent',
    assigneeId: 'agent-2',
    payload: {},
    lockedAt: null,
    updatedAt: new Date('2026-08-04T09:00:00.000Z'),
  } as unknown as Ticket
  const run = activeRunFromTicket(ticket)
  assert.equal(run.phase, 'active')
  assert.equal(run.status, 'ready')
  assert.equal(run.canStart, true)
  assert.equal(run.canStop, false)
  assert.ok(run.latestActivity?.includes('Indításra kész'))
})

check('activeRunFromTicket: ready process ticket with agentId and empty assigneeId is startable', () => {
  const ticket = {
    id: 'ticket-process-ready',
    title: 'Tulajdoni lap PDF beolvasása',
    state: 'ready',
    agentId: 'agent-marika',
    assigneeType: 'agent',
    assigneeId: null,
    payload: {},
    lockedAt: null,
    updatedAt: new Date('2026-08-19T12:43:00.000Z'),
  } as unknown as Ticket
  const run = activeRunFromTicket(ticket)
  assert.equal(run.canStart, true)
  assert.ok(run.latestActivity?.includes('Indításra kész'))
})

check('activeRunFromTicket: ready without agent assignee is not startable', () => {
  const ticket = {
    id: 'ticket-ready-human',
    title: 'Emberi feladat',
    state: 'ready',
    agentId: null,
    assigneeType: 'human',
    assigneeId: 'user-1',
    payload: {},
    lockedAt: null,
    updatedAt: new Date('2026-08-04T09:00:00.000Z'),
  } as unknown as Ticket
  const run = activeRunFromTicket(ticket)
  assert.equal(run.phase, 'active')
  assert.equal(run.canStart, false)
  assert.equal(statusLabel(run), 'Végrehajtásra vár')
})

function makeRun(partial: Partial<ActiveRun> & Pick<ActiveRun, 'id' | 'phase' | 'startedAt'>): ActiveRun {
  return {
    kind: 'chat_turn',
    title: partial.id,
    href: '/',
    status: partial.phase === 'active' ? 'running' : 'completed',
    latestActivity: null,
    finishedAt: partial.finishedAt ?? (partial.phase === 'completed' ? partial.startedAt : null),
    canStop: partial.phase === 'active',
    canStart: false,
    targetId: partial.id,
    agentId: null,
    ...partial,
  }
}

check('composeRunsPanel: keeps recency order; seen only flips flag (no drop / no re-order)', () => {
  const runs = [
    makeRun({ id: 'active-1', phase: 'active', startedAt: '2026-07-31T12:00:00.000Z' }),
    makeRun({
      id: 'unseen-new',
      phase: 'completed',
      startedAt: '2026-07-31T11:00:00.000Z',
      finishedAt: '2026-07-31T11:30:00.000Z',
    }),
    makeRun({
      id: 'seen-old',
      phase: 'completed',
      startedAt: '2026-07-31T10:00:00.000Z',
      finishedAt: '2026-07-31T10:30:00.000Z',
    }),
    makeRun({
      id: 'unseen-older',
      phase: 'completed',
      startedAt: '2026-07-31T09:00:00.000Z',
      finishedAt: '2026-07-31T09:30:00.000Z',
    }),
  ]
  const seenKeys = new Set([activeRunKey({ kind: 'chat_turn', id: 'seen-old' })])
  const composed = composeRunsPanel({ runs, seenKeys })
  assert.deepEqual(
    composed.runs.map((r) => r.id),
    ['active-1', 'unseen-new', 'seen-old', 'unseen-older'],
  )
  assert.equal(composed.badgeCount, 3)
  assert.deepEqual(
    composed.runs.map((r) => r.seen),
    [false, false, true, false],
  )
})

check('composeRunsPanel: keeps all seen completed in place (no limit/tail)', () => {
  const seenRuns = Array.from({ length: 7 }, (_, i) =>
    makeRun({
      id: `seen-${i}`,
      phase: 'completed',
      startedAt: `2026-07-31T0${i}:00:00.000Z`,
      finishedAt: `2026-07-31T0${i}:30:00.000Z`,
    }),
  )
  const seenKeys = new Set(seenRuns.map((r) => activeRunKey(r)))
  const composed = composeRunsPanel({ runs: seenRuns, seenKeys })
  assert.equal(composed.runs.length, 7)
  assert.equal(composed.badgeCount, 0)
  assert.deepEqual(
    composed.runs.map((r) => r.id),
    ['seen-6', 'seen-5', 'seen-4', 'seen-3', 'seen-2', 'seen-1', 'seen-0'],
  )
  assert.ok(composed.runs.every((r) => r.seen))
})

check('summarizeRuns: fut / indításra vár / vár rád / új eredmény / sikertelen bontás', () => {
  const startedAt = '2026-07-31T09:00:00.000Z'
  const runs = [
    { ...makeRun({ id: 'a', phase: 'active', status: 'running', startedAt }), seen: false },
    { ...makeRun({ id: 'b', phase: 'active', status: 'awaiting_human', startedAt }), seen: false },
    { ...makeRun({ id: 'ready', phase: 'active', status: 'ready', startedAt }), seen: false },
    { ...makeRun({ id: 'stalled', phase: 'active', status: 'stalled', startedAt }), seen: false },
    { ...makeRun({ id: 'c', phase: 'completed', status: 'done', startedAt }), seen: false },
    { ...makeRun({ id: 'd', phase: 'completed', status: 'done', startedAt }), seen: true },
    { ...makeRun({ id: 'e', phase: 'completed', status: 'failed', startedAt }), seen: false },
  ]
  const summary = summarizeRuns(runs)
  assert.deepEqual(summary, { running: 1, waiting: 1, ready: 1, fresh: 2, failed: 1 })
  assert.deepEqual(
    runsSummaryChips(summary).map((chip) => chip.label),
    ['1 fut', '1 indításra vár', '1 vár rád', '2 új eredmény', '1 sikertelen'],
  )
  // Üres helyzetben nincs mit kiírni — nem szemetel a felületen.
  assert.deepEqual(
    runsSummaryChips({ running: 0, waiting: 0, ready: 0, fresh: 0, failed: 0 }),
    [],
  )
})

check('workingAgentIds: csak aktívan futó agentek, awaiting_human / ready nem', () => {
  const startedAt = '2026-07-31T09:00:00.000Z'
  const ids = workingAgentIds([
    makeRun({ id: 'r1', phase: 'active', status: 'running', agentId: 'a1', startedAt }),
    makeRun({ id: 'r2', phase: 'active', status: 'awaiting_human', agentId: 'a2', startedAt }),
    makeRun({ id: 'r3', phase: 'active', status: 'streaming', agentId: 'a3', startedAt }),
    makeRun({ id: 'r4', phase: 'completed', status: 'done', agentId: 'a4', startedAt }),
    makeRun({ id: 'r5', phase: 'active', status: 'in_progress', agentId: 'a1', startedAt }),
    makeRun({ id: 'r6', phase: 'active', status: 'ready', agentId: 'a5', startedAt }),
    makeRun({ id: 'r7', phase: 'active', status: 'stalled', agentId: 'a6', startedAt }),
  ])
  assert.deepEqual([...ids].sort(), ['a1', 'a3'])
})

check('summarizeAgentActivity: a kártya azt mondja, épp min dolgozik', () => {
  const now = new Date('2026-08-03T12:00:00')
  const activity = summarizeAgentActivity(
    [
      // Ági: régebbi futó ügy + frissebb döntésre váró → a FUTÓ a „most ezen dolgozik”.
      makeRun({
        id: 'r1',
        phase: 'active',
        status: 'running',
        agentId: 'agi',
        title: 'Tulajdoni lap egyeztetés',
        href: '/control-plane/tickets/r1',
        startedAt: '2026-08-03T11:45:00',
      }),
      makeRun({
        id: 'r2',
        phase: 'active',
        status: 'awaiting_human',
        agentId: 'agi',
        href: '/control-plane/tickets/r2',
        startedAt: '2026-08-03T11:55:00',
      }),
      makeRun({
        id: 'r3',
        phase: 'completed',
        status: 'done',
        agentId: 'agi',
        startedAt: '2026-08-03T08:00:00',
        finishedAt: '2026-08-03T08:20:00',
      }),
      // Tegnap lezárult ügy nem számít bele a mai mérlegbe.
      makeRun({
        id: 'r4',
        phase: 'completed',
        status: 'done',
        agentId: 'agi',
        startedAt: '2026-08-02T08:00:00',
        finishedAt: '2026-08-02T08:20:00',
      }),
    ],
    now,
  )

  const agi = activity.get('agi')
  assert.ok(agi)
  assert.equal(agi.working, true)
  assert.equal(agi.awaitingHuman, 1)
  assert.equal(agi.completedToday, 1)
  assert.equal(agi.current?.title, 'Tulajdoni lap egyeztetés')
  assert.equal(agi.current?.href, '/control-plane/tickets/r1')
  assert.equal(agi.current?.label, 'Fut')
  assert.equal(agi.current?.elapsed, '15 perce')
  assert.equal(agi.current?.needsYou, false)
  // A pill a várakozóra megy, nem a futóra — még ha a „most ezen dolgozik” a futó is.
  assert.equal(agi.attentionHref, '/control-plane/tickets/r2')
})

check('summarizeAgentActivity: ha csak várakozó ügy van, a felhasználón a sor', () => {
  const now = new Date('2026-08-03T12:00:00')
  const activity = summarizeAgentActivity(
    [
      makeRun({
        id: 'r1',
        phase: 'active',
        status: 'needs_info',
        agentId: 'reka',
        title: 'CRM adatpótlás',
        href: '/control-plane/tickets/r1',
        startedAt: '2026-08-03T10:00:00',
      }),
      // agentId nélküli futás senkihez sem tartozik — nem torzítja a kártyát.
      makeRun({ id: 'r2', phase: 'active', status: 'running', startedAt: '2026-08-03T11:00:00' }),
    ],
    now,
  )

  const reka = activity.get('reka')
  assert.ok(reka)
  assert.equal(reka.working, false)
  assert.equal(reka.awaitingHuman, 1)
  assert.equal(reka.current?.needsYou, true)
  assert.equal(reka.current?.label, 'Információra vár')
  assert.equal(reka.attentionHref, '/control-plane/tickets/r1')
  assert.equal(activity.size, 1)
})

check('runDayLabel / formatRunClock: mai és tegnapi napok magyarul', () => {
  const now = new Date('2026-08-03T12:00:00')
  assert.equal(runDayLabel('2026-08-03T09:20:00', now), 'Ma')
  assert.equal(runDayLabel('2026-08-02T23:50:00', now), 'Tegnap')
  assert.ok(!['Ma', 'Tegnap'].includes(runDayLabel('2026-08-01T10:00:00', now)))
  assert.match(formatRunClock('2026-08-03T09:20:00', now), /^09:20$/)
  assert.match(formatRunClock('2026-08-02T08:22:00', now), /^tegnap 08:22$/)
})

check('formatRunElapsed: aktív futásnál a kor a fő információ', () => {
  const now = new Date('2026-08-03T12:00:00')
  assert.equal(formatRunElapsed('2026-08-03T11:59:40', now), 'most indult')
  assert.equal(formatRunElapsed('2026-08-03T11:45:00', now), '15 perce')
  assert.equal(formatRunElapsed('2026-08-03T09:00:00', now), '3 órája')
  assert.equal(formatRunElapsed('2026-08-01T09:00:00', now), '2 napja')
})

check('formatWorkElapsedMmSs: perc:mp óra a chat munka-sávhoz', () => {
  const started = Date.parse('2026-08-03T12:00:00')
  assert.equal(formatWorkElapsedMmSs(started, started + 34_000), '0:34')
  assert.equal(formatWorkElapsedMmSs(started, started + 125_000), '2:05')
  assert.equal(formatWorkElapsedMmSs(started, started - 1_000), '0:00')
})

check('assessTicketRunLiveness: active vs stalled vs cancelling', () => {
  const base = Date.parse('2026-07-31T09:10:00.000Z')
  const progress = readTicketRuntimeProgress({
    runtimeProgress: {
      updatedAt: new Date(base).toISOString(),
      activities: [{ id: 't1', kind: 'tool', title: 'file_read', status: 'running' }],
    },
  })
  assert.ok(progress)

  assert.equal(
    assessTicketRunLiveness({
      ticketState: 'in_progress',
      progress,
      nowMs: base + 10_000,
    }).kind,
    'active',
  )
  assert.equal(
    assessTicketRunLiveness({
      ticketState: 'in_progress',
      progress,
      nowMs: base + TICKET_PROGRESS_ACTIVE_MS + 1,
    }).kind,
    'quiet',
  )
  assert.equal(
    assessTicketRunLiveness({
      ticketState: 'in_progress',
      progress,
      nowMs: base + TICKET_PROGRESS_STALL_MS + 1,
    }).kind,
    'stalled',
  )
  assert.equal(
    assessTicketRunLiveness({
      ticketState: 'in_progress',
      cancelRequested: true,
      progress,
      nowMs: base + TICKET_PROGRESS_STALL_MS + 1,
    }).kind,
    'cancelling',
  )
  assert.equal(
    assessTicketRunLiveness({
      ticketState: 'done',
      progress,
      nowMs: base,
    }).kind,
    'idle',
  )
})

check('formatTicketProgressAge is Hungarian relative', () => {
  assert.equal(formatTicketProgressAge(12_000), '12 másodperce')
  assert.equal(formatTicketProgressAge(125_000), '2 perce')
})

check('in_progress + 44h csend: a fejléc nem mondja, hogy éppen dolgozik', () => {
  const updatedAt = '2026-08-22T11:33:00.000Z'
  const nowMs = Date.parse('2026-08-24T07:58:00.000Z')
  const progress = readTicketRuntimeProgress({
    runtimeProgress: {
      updatedAt,
      activities: [
        {
          id: 'reasoning-n',
          kind: 'reasoning',
          title: 'Tool eredmények kiértékelése',
          status: 'running',
        },
      ],
    },
  })
  assert.ok(progress)
  const liveness = assessTicketRunLiveness({
    ticketState: 'in_progress',
    progress,
    nowMs,
  })
  assert.equal(liveness.kind, 'stalled')
  assert.equal(isTicketRunLive(liveness), false)

  const presented = presentTicketRunStatus({
    liveness,
    stateLabel: 'Végrehajtás alatt',
    stateHint: 'Az AI munkatárs éppen dolgozik rajta.',
  })
  assert.equal(presented.label, 'Úgy tűnik megállt')
  assert.equal(presented.live, false)
  assert.equal(presented.stalled, true)
  assert.match(presented.hint, /nincs friss jelzés 44 órája/)
  assert.doesNotMatch(presented.hint, /éppen dolgozik/)
})

check('élő in_progress megtartja a workflow-címkét', () => {
  const base = Date.parse('2026-08-24T07:58:00.000Z')
  const progress = readTicketRuntimeProgress({
    runtimeProgress: {
      updatedAt: new Date(base).toISOString(),
      activities: [{ id: 't1', kind: 'tool', title: 'file_read', status: 'running' }],
    },
  })
  assert.ok(progress)
  const liveness = assessTicketRunLiveness({
    ticketState: 'in_progress',
    progress,
    nowMs: base + 10_000,
  })
  const presented = presentTicketRunStatus({
    liveness,
    stateLabel: 'Végrehajtás alatt',
    stateHint: 'Az AI munkatárs éppen dolgozik rajta.',
  })
  assert.equal(presented.label, 'Végrehajtás alatt')
  assert.equal(presented.hint, 'Az AI munkatárs éppen dolgozik rajta.')
  assert.equal(presented.live, true)
  assert.equal(presented.stalled, false)
})

check('boardRunPulse: beragadt in_progress kártya nem live', () => {
  const pulse = boardRunPulse({
    state: 'in_progress',
    payload: {
      runtimeProgress: {
        updatedAt: '2026-08-22T11:33:00.000Z',
        activities: [
          {
            id: 'reasoning-n',
            kind: 'reasoning',
            title: 'Tool eredmények kiértékelése',
            status: 'running',
          },
        ],
      },
    },
    nowMs: Date.parse('2026-08-24T07:58:00.000Z'),
  })
  assert.equal(pulse, 'stalled')
  assert.equal(
    boardRunPulse({
      state: 'in_progress',
      payload: {
        runtimeProgress: {
          updatedAt: '2026-08-24T07:57:50.000Z',
          activities: [{ id: 't1', kind: 'tool', title: 'file_read', status: 'running' }],
        },
      },
      nowMs: Date.parse('2026-08-24T07:58:00.000Z'),
    }),
    'live',
  )
  assert.equal(boardRunPulse({ state: 'ready' }), 'idle')
})

if (failures > 0) {
  console.error(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nAll passed')
