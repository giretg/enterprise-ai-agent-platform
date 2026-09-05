/**
 * Ütemezett ticket payload- és címke-szabályok.
 *
 * Futtatás: npx tsx scripts/ticket-schedule.test.ts
 */
import assert from 'node:assert/strict'
import {
  buildTicketScheduleStamp,
  clampIntervalHours,
  isScheduleSeriesTicket,
  isScheduledTicket,
  localDateTimeToIso,
  occurrenceTitle,
  readTicketSchedule,
  recurrenceCaption,
  stampTicketSchedule,
} from '../src/lib/ticket-schedule'
import { addRecurrence } from '../src/domain/scheduled-task/scheduled-task-service'
import { createBoardTicketSchema } from '../src/lib/validators/actions'
import { applyTicketTaskDescription, canEditTicketTask } from '../src/lib/ticket-display'

let failures = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}:`, error)
  }
}

console.log('=== ticket schedule ===')

test('egyszeri executeAfter ticket ütemezettnek számít', () => {
  const runAt = new Date('2026-08-24T10:00:00.000Z')
  assert.equal(isScheduledTicket({ executeAfter: runAt, payload: { source: 'board' } }), true)
  const view = readTicketSchedule({ scheduledRun: true, schedule: buildTicketScheduleStamp({
    kind: 'once',
    runAt,
  }) }, runAt, new Date('2026-08-24T09:00:00.000Z'))
  assert.ok(view)
  assert.equal(view.kind, 'once')
  assert.equal(view.pending, true)
  assert.match(view.compactLabel, /Ütemezve/)
})

test('rendszeres napi ütemezés címkéje', () => {
  const runAt = new Date('2026-08-24T10:00:00.000Z')
  const payload = stampTicketSchedule(
    { question: 'Riport' },
    buildTicketScheduleStamp({ kind: 'recurring', runAt, recurrence: 'daily' }),
    { scheduledTaskId: 'aaaaaaaa-0000-4000-8000-000000000001' },
  )
  const view = readTicketSchedule(payload, runAt, new Date('2026-08-24T09:00:00.000Z'))
  assert.ok(view)
  assert.equal(view.kind, 'recurring')
  assert.equal(view.recurrence, 'daily')
  assert.match(view.label, /naponta/)
})

test('rendszeres sorozat és példány címkéje különbözik', () => {
  const runAt = new Date('2026-08-24T10:00:00.000Z')
  const series = stampTicketSchedule(
    { question: 'Riport' },
    buildTicketScheduleStamp({ kind: 'recurring', runAt, recurrence: 'daily', role: 'series' }),
    { scheduledTaskId: 'aaaaaaaa-0000-4000-8000-000000000001', role: 'series' },
  )
  assert.equal(isScheduleSeriesTicket({ payload: series }), true)
  const seriesView = readTicketSchedule(series, runAt, new Date('2026-08-24T09:00:00.000Z'))
  assert.ok(seriesView)
  assert.equal(seriesView.role, 'series')
  assert.match(seriesView.compactLabel, /Következő/)

  const occurrence = stampTicketSchedule(
    { question: 'Riport' },
    buildTicketScheduleStamp({
      kind: 'recurring',
      runAt,
      recurrence: 'daily',
      role: 'occurrence',
    }),
    {
      scheduledTaskId: 'aaaaaaaa-0000-4000-8000-000000000001',
      role: 'occurrence',
      seriesTicketId: 'bbbbbbbb-0000-4000-8000-000000000002',
    },
  )
  assert.equal(isScheduleSeriesTicket({ payload: occurrence }), false)
  const occurrenceView = readTicketSchedule(occurrence, null, new Date('2026-08-24T11:00:00.000Z'))
  assert.ok(occurrenceView)
  assert.equal(occurrenceView.role, 'occurrence')
  assert.match(occurrenceView.compactLabel, /Futás/)
  assert.ok(occurrenceTitle('Riport', runAt).startsWith('Riport — '))
})

test('óránkénti köz 1–168 közé van szorítva', () => {
  assert.equal(clampIntervalHours(0), 1)
  assert.equal(clampIntervalHours(6), 6)
  assert.equal(clampIntervalHours(200), 168)
  assert.equal(recurrenceCaption('hourly', 1), 'óránként')
  assert.equal(recurrenceCaption('hourly', 6), 'minden 6. órában')
})

test('addRecurrence hourly UTC órákat lép', () => {
  const start = new Date('2026-08-24T10:00:00.000Z')
  const next = addRecurrence(start, 'hourly', 6)
  assert.ok(next)
  assert.equal(next.toISOString(), '2026-08-24T16:00:00.000Z')
})

test('datetime-local helyi időt ISO-ra visz', () => {
  const iso = localDateTimeToIso('2026-08-24T12:30')
  assert.ok(iso)
  assert.equal(Number.isNaN(new Date(iso).getTime()), false)
})

test('createBoardTicketSchema: rendszeres ütemezéshez időpont és gyakoriság kell', () => {
  const base = {
    title: 'Riport',
    assigneeType: 'agent' as const,
    assigneeId: 'aaaaaaaa-0000-4000-8000-000000000001',
  }
  assert.equal(
    createBoardTicketSchema.safeParse({
      ...base,
      scheduleMode: 'recurring',
      recurrence: 'weekly',
    }).success,
    false,
  )
  assert.equal(
    createBoardTicketSchema.safeParse({
      ...base,
      scheduleMode: 'recurring',
      recurrence: 'hourly',
      intervalHours: 4,
      runAt: '2026-08-24T10:00:00.000Z',
    }).success,
    true,
  )
  assert.equal(
    createBoardTicketSchema.safeParse({
      ...base,
      assigneeType: 'human',
      scheduleMode: 'once',
      runAt: '2026-08-24T10:00:00.000Z',
    }).success,
    false,
  )
})

test('végrehajtásra váró ticket szerkeszthető, futás közben nem', () => {
  const ctx = { canManage: true, userId: 'user-1' }
  const base = {
    createdById: 'user-1',
    lockToken: null,
    processInstanceId: null,
  }
  assert.equal(canEditTicketTask({ ...base, state: 'ready' }, ctx), true)
  assert.equal(canEditTicketTask({ ...base, state: 'backlog' }, ctx), true)
  assert.equal(canEditTicketTask({ ...base, state: 'in_progress' }, ctx), false)
  assert.equal(
    canEditTicketTask({ ...base, state: 'ready', processInstanceId: 'proc-1' }, ctx),
    false,
  )
  assert.equal(
    canEditTicketTask({ ...base, state: 'ready' }, { canManage: false, userId: 'other' }),
    false,
  )
})

test('feladat-szöveg szerkesztése a template question/task mezőket viszi, az ütemezést meghagyja', () => {
  const next = applyTicketTaskDescription(
    {
      question: 'Régi feladat',
      source: 'scheduled_task',
      scheduleSeries: true,
      briefing: { goal: 'Régi feladat', source: '', constraint: '', approval: 'a feladó nevében fut' },
    },
    'Új havi riport',
  )
  assert.equal(next.question, 'Új havi riport')
  assert.equal(next.task, 'Új havi riport')
  assert.equal(next.scheduleSeries, true)
  assert.equal((next.briefing as { goal: string }).goal, 'Új havi riport')
})

console.log(failures === 0 ? '\nOK minden ticket-schedule teszt zöld' : `\n${failures} teszt bukott`)
process.exit(failures === 0 ? 0 : 1)
