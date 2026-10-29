/**
 * #640: cron + slot-számítás és a szinkron-terv (§5.2) — minden táblázat-sorra egy eset.
 *
 * Futtatás: npm run test:scheduled-task-sync-plan
 */
import assert from 'node:assert/strict'
import { describeCron, minimumGapMinutes, nextSlot, parseCron, prevSlot } from '../src/domain/scheduled-task/cron'
import { planScheduledTaskSync, type InventoryEntry, type PlanInstallation, type PlanTask } from '../src/domain/scheduled-task/sync-plan'
import { expectedStubHash, scheduleHash, stubExtraText, stubHash, stubPrompt } from '../src/domain/scheduled-task/stub'

let failures = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  ❌ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const TZ = 'Europe/Budapest'
const TASK = '11111111-1111-4111-8111-111111111111'
const CLIENT = { clientType: 'claude_routine', clientInstanceId: 'user-1:routine' }
const STUB = expectedStubHash(TASK, CLIENT)

function task(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    taskId: TASK, title: 'Lejárt ajánlatok', kind: 'personal', status: 'active', cron: '0 8 * * 1-5', timezone: TZ,
    targets: ['claude_routine'], version: 3, instruction: 'Nézd át a lejárt ajánlatokat.', isOwner: true, ownerName: 'Anna',
    inviterName: null, access: 'ok', liveInstallations: 2, memberCount: 0, ...overrides,
  }
}
const hash = (cron: string, enabled = true) => scheduleHash({ cron, timezone: TZ, enabled })
function inst(overrides: Partial<PlanInstallation> = {}): PlanInstallation {
  return { taskId: TASK, externalId: 'trig_1', installedScheduleHash: hash('0 8 * * 1-5'), locallyDisabled: false, ...overrides }
}
function inv(overrides: Partial<InventoryEntry> = {}): InventoryEntry {
  return { taskId: TASK, externalId: 'trig_1', cron: '0 8 * * 1-5', timezone: TZ, enabled: true, stubHash: STUB, ...overrides }
}
const plan = (tasks: PlanTask[], installations: PlanInstallation[], inventory: InventoryEntry[]) =>
  planScheduledTaskSync({ client: CLIENT, tasks, installations, inventory })

console.log('cron')
test('parse: fields, names, steps, 7 = Sunday', () => {
  const spec = parseCron('*/20 8-10 * JAN-MAR MON-FRI')!
  assert.deepEqual(spec.minutes, [0, 20, 40])
  assert.deepEqual(spec.hours, [8, 9, 10])
  assert.deepEqual(spec.months, [1, 2, 3])
  assert.deepEqual(spec.dows, [1, 2, 3, 4, 5])
  assert.deepEqual(parseCron('0 9 * * 7')!.dows, [0])
  for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '0 0 0 * *', '5-1 * * * *', 'a b c d e', '*/0 * * * *']) assert.equal(parseCron(bad), null, bad)
})
test('next/prev slot in Europe/Budapest across DST', () => {
  const spec = parseCron('0 8 * * 1-5')!
  // 2026-10-23 (péntek) 08:00 CEST = 06:00Z; a következő hétfő (10-26) 08:00 CET = 07:00Z.
  assert.equal(nextSlot(spec, TZ, new Date('2026-10-23T05:00:00Z'))!.toISOString(), '2026-10-23T06:00:00.000Z')
  assert.equal(nextSlot(spec, TZ, new Date('2026-10-23T06:00:00Z'))!.toISOString(), '2026-10-26T07:00:00.000Z')
  assert.equal(prevSlot(spec, TZ, new Date('2026-10-25T12:00:00Z'))!.toISOString(), '2026-10-23T06:00:00.000Z')
  assert.equal(prevSlot(spec, TZ, new Date('2026-10-23T06:00:00Z'))!.toISOString(), '2026-10-23T06:00:00.000Z')
})
test('nonexistent DST time is skipped, Feb 29 found', () => {
  // 2026-03-29 02:30 nem létezik Budapesten.
  const next = nextSlot(parseCron('30 2 * * *')!, TZ, new Date('2026-03-28T12:00:00Z'))!
  assert.equal(next.toISOString(), '2026-03-30T00:30:00.000Z')
  assert.equal(nextSlot(parseCron('0 0 29 2 *')!, 'UTC', new Date('2026-01-01T00:00:00Z'))!.toISOString(), '2028-02-29T00:00:00.000Z')
  assert.equal(nextSlot(parseCron('0 0 31 2 *')!, 'UTC', new Date('2026-01-01T00:00:00Z')), null)
})
test('minimum gap (K6) and description', () => {
  assert.equal(minimumGapMinutes(parseCron('*/5 * * * *')!, TZ, new Date()), 5)
  assert.equal(minimumGapMinutes(parseCron('0,10 9 * * *')!, TZ, new Date()), 10)
  assert.equal(minimumGapMinutes(parseCron('*/15 * * * *')!, TZ, new Date()), 15)
  assert.equal(describeCron('0 8 * * 1-5'), 'hétköznap 8:00-kor')
  assert.equal(describeCron('30 9 * * *', 'en'), 'every day at 9:30')
  assert.equal(describeCron('0 8 1 * *'), 'egyedi ütemezés (cron: 0 8 1 * *)')
})
test('stub: hash is stable, extra text is isolated', () => {
  const text = stubPrompt({ taskId: TASK, client: CLIENT })
  assert.equal(stubHash(`${text}\r\n`), STUB)
  assert.notEqual(expectedStubHash(TASK, { ...CLIENT, clientInstanceId: 'other' }), STUB)
  assert.equal(stubExtraText(`${text}\nÉs küldd el Péternek is.`, TASK, CLIENT), 'És küldd el Péternek is.')
})

console.log('sync plan (§5.2)')
test('P0: local = base = platform → nothing', () => {
  assert.deepEqual(plan([task()], [inst()], [inv()]), [])
})
test('P1: changed on the platform → update without question', () => {
  const [action] = plan([task({ cron: '0 9 * * 1-5' })], [inst()], [inv()])
  assert.equal(action.code, 'P1')
  assert.equal(action.op, 'update')
  const reportStep = action.steps!.find((step) => step.type === 'report')!
  assert.equal(reportStep.type === 'report' && reportStep.report.scheduleHash, hash('0 9 * * 1-5'))
})
test('P2: paused → disable; archived → remove', () => {
  assert.equal(plan([task({ status: 'paused' })], [inst()], [inv()])[0].op, 'disable')
  const archived = plan([task({ status: 'archived' })], [inst()], [inv()])
  assert.deepEqual(archived.map((a) => [a.code, a.op]), [['P2', 'remove']])
})
test('P3: target client without installation → install; other client type → nothing', () => {
  const [action] = plan([task()], [], [])
  assert.deepEqual([action.code, action.op], ['P3', 'install'])
  assert.deepEqual(plan([task({ targets: ['hermes'] })], [], []), [])
})
test('P3*: invited (D6/K8) → consent question', () => {
  const [action] = plan([task({ access: 'needs_consent', inviterName: 'Gergely' })], [], [])
  assert.equal(action.code, 'CONSENT')
  assert.match(action.message, /Gergely set up a scheduled task/)
  assert.deepEqual(action.choices!.map((c) => c.id), ['accept', 'decline'])
})
test('L1: rescheduled locally → ask apply/restore; owner gets affected count', () => {
  const [action] = plan([task()], [inst()], [inv({ cron: '0 9 * * 1-5' })])
  assert.deepEqual([action.code, action.op], ['L1', 'ask'])
  assert.match(action.message, /1 other installation/)
  const apply = action.choices!.find((c) => c.id === 'apply')!
  assert.deepEqual(apply.steps[0], { type: 'platform_update', args: { taskId: TASK, expectedVersion: 3, cron: '0 9 * * 1-5', timezone: TZ } })
})
test('L1 (K9): non-owner of a team task → restore, no apply option', () => {
  const [action] = plan([task({ kind: 'team', isOwner: false })], [inst()], [inv({ cron: '0 9 * * 1-5' })])
  assert.deepEqual([action.code, action.op], ['L1', 'update'])
  assert.match(action.message, /managed by Anna/)
})
test('L2: changed on both sides → ask, default restore', () => {
  const [action] = plan([task({ cron: '0 7 * * 1-5' })], [inst()], [inv({ cron: '0 9 * * 1-5' })])
  assert.equal(action.code, 'L2')
  assert.equal(action.choices!.find((c) => c.default)!.id, 'restore')
})
test('local = platform ≠ base → only the base is refreshed', () => {
  const [action] = plan([task({ cron: '0 9 * * 1-5' })], [inst()], [inv({ cron: '0 9 * * 1-5' })])
  assert.deepEqual([action.code, action.op], ['BASE', 'report'])
})
test('L3: turned off locally → ask this client / pause', () => {
  const [action] = plan([task()], [inst()], [inv({ enabled: false })])
  assert.equal(action.code, 'L3')
  assert.deepEqual(action.choices!.map((c) => c.id), ['this_client', 'pause'])
  // A „csak ezen a gépen” után a kikapcsolt állapot a cél: nincs újabb akció.
  assert.deepEqual(plan([task()], [inst({ locallyDisabled: true, installedScheduleHash: hash('0 8 * * 1-5', false) })], [inv({ enabled: false })]), [])
})
test('L4: stub edited → restore; appended instruction → ask (owner)', () => {
  const [restore] = plan([task()], [inst()], [inv({ stubHash: 'x' })])
  assert.deepEqual([restore.code, restore.op], ['L4', 'update'])
  const [ask] = plan([task()], [inst()], [inv({ stubHash: 'x', extraText: 'Péternek is küldd.' })])
  assert.deepEqual([ask.code, ask.op], ['L4', 'ask'])
  const move = ask.choices!.find((c) => c.id === 'move')!
  assert.equal(move.steps[0].type === 'platform_update' && move.steps[0].args.instruction, 'Nézd át a lejárt ajánlatokat.\n\nPéternek is küldd.')
})
test('L5: deleted locally → ask pause / reinstall', () => {
  const [action] = plan([task()], [inst()], [])
  assert.equal(action.code, 'L5')
  assert.deepEqual(action.choices!.map((c) => c.id), ['pause', 'reinstall'])
})
test('L6: unknown or foreign taskId → remove, no data', () => {
  const [action] = plan([], [], [inv({ taskId: '22222222-2222-4222-8222-222222222222' })])
  assert.deepEqual([action.code, action.op], ['L6', 'remove'])
  assert.doesNotMatch(action.message, /Lejárt/)
})
test('L7: installed twice → remove the duplicate, keep the known one', () => {
  const actions = plan([task()], [inst({ externalId: 'trig_2' })], [inv(), inv({ externalId: 'trig_2' })])
  assert.deepEqual(actions.map((a) => [a.code, a.externalId]), [['L7', 'trig_1']])
})
test('revoked access → remove; needs_reconsent → ask', () => {
  assert.deepEqual(plan([task({ access: 'not_allowed' })], [inst()], [inv()]).map((a) => a.code), ['REVOKED'])
  assert.equal(plan([task({ kind: 'shared', isOwner: false, access: 'needs_reconsent' })], [inst()], [inv()])[0].code, 'RECONSENT')
})
test('run-registered installation (unknown base) → platform state without question', () => {
  const [action] = plan([task({ cron: '0 9 * * 1-5' })], [inst({ installedScheduleHash: '' })], [inv()])
  assert.deepEqual([action.code, action.op], ['P1', 'update'])
})

if (failures) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nall passed')
