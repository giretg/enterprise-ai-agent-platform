/**
 * #1126 fokozatos bevezetés: kiértékelő, cache, jogosultság, összegzés, audit-sorok, kapuk és a kódbeli lista.
 * Adatbázis nélkül fut. Futtatás: npm run test:feature-flags
 */
import assert from 'node:assert/strict'
import type { PlatformRole } from '@prisma/client'
import {
  FeatureFlagAdminService,
  FeatureFlagAuditWriteError,
  featureFlagSnapshotOf,
  type FeatureFlagCommit,
  type FeatureFlagHistoryEntry,
  type FeatureFlagRow,
  type FeatureFlagStore,
} from '../src/domain/feature-flags/admin-service'
import { decideFeatureFlag, diffFeatureFlagEffect, type FeatureFlagState } from '../src/domain/feature-flags/evaluate'
import { createFeatureFlagEvaluator, createStaticFeatureFlags } from '../src/domain/feature-flags/evaluator'
import { createExternalClientFlags } from '../src/domain/feature-flags/external-client-flags'
import { createFeatureFlagGateClosed, createFeatureGates, createToolFeatureGate, FeatureNotEnabledError, hideDisabledTools } from '../src/domain/feature-flags/gates'
import {
  FEATURE_FLAGS,
  RETIRED_FEATURE_FLAG_KEYS,
  isRealDate,
  validateFeatureFlagRegistry,
  type FeatureFlagDefinition,
} from '../src/domain/feature-flags/registry'
import { TOOL_FEATURE_FLAGS } from '../src/domain/feature-flags/tool-flags'
import { assertAuditMetadataSafe } from '../src/lib/audit/payload-guard'
import { assertAuditActionRegistered } from '../src/lib/audit/event-catalog'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'
const KEY = 'test.feature'

let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures++
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : error}`)
  }
}

const state = (mode: FeatureFlagState['mode'], tenants: Record<string, 'included' | 'excluded'> = {}): FeatureFlagState => ({
  mode,
  tenants: new Map(Object.entries(tenants)),
})

const definition: FeatureFlagDefinition = {
  title: { hu: 'Próba funkció', en: 'Test feature' },
  whatChanges: { hu: 'Új működés', en: 'New behaviour' },
  whenOff: { hu: 'A régi működés', en: 'The old behaviour' },
  owner: 'Teszt',
  issue: 1126,
  reviewBy: '2027-01-01',
}

class MemoryStore implements FeatureFlagStore {
  rows = new Map<string, FeatureFlagRow>()
  audit: FeatureFlagCommit['audit'][number][] = []
  failAudit = false
  commits = 0
  async loadAll() {
    return [...this.rows.values()]
  }
  async find(key: string) {
    return this.rows.get(key) ?? null
  }
  async commit(input: FeatureFlagCommit) {
    if ((this.rows.get(input.key)?.version ?? 0) !== input.expectedVersion) return 'conflict' as const
    if (this.failAudit && input.audit.length > 0) throw new FeatureFlagAuditWriteError(new Error('audit down'))
    const tenants = new Map((this.rows.get(input.key)?.tenants ?? []).map((t) => [t.tenantId, t.access]))
    for (const { tenantId, access } of input.tenantAccess) {
      if (access === null) tenants.delete(tenantId)
      else tenants.set(tenantId, access)
    }
    this.rows.set(input.key, {
      key: input.key,
      mode: input.mode,
      version: input.expectedVersion + 1,
      fullRolloutAt: input.fullRolloutAt,
      removeBy: input.removeBy,
      stoppedAt: input.stoppedAt,
      updatedAt: new Date(),
      tenants: [...tenants].map(([tenantId, access]) => ({ tenantId, access })),
    })
    for (const row of input.audit) {
      assertAuditActionRegistered(row.action)
      assertAuditMetadataSafe(row.metadata)
    }
    this.audit.push(...input.audit)
    this.commits += 1
    return 'committed' as const
  }
  async listHistory(): Promise<FeatureFlagHistoryEntry[]> {
    return []
  }
}

const NOW = new Date('2026-11-07T10:00:00Z')
const operator = { id: 'op', platformRoles: ['platform_operator'] as PlatformRole[] }
const superadmin = { id: 'sa', platformRoles: ['superadmin'] as PlatformRole[] }
const auditor = { id: 'au', platformRoles: ['platform_auditor'] as PlatformRole[] }

function setup(registry: Record<string, FeatureFlagDefinition> = { [KEY]: definition }) {
  const store = new MemoryStore()
  let invalidations = 0
  const tenants = [
    { id: A, displayName: 'Alfa' },
    { id: B, displayName: 'Béta' },
    { id: C, displayName: 'Gamma' },
  ]
  const service = new FeatureFlagAdminService({
    registry,
    store,
    listTenants: async () => tenants,
    onChanged: () => {
      invalidations += 1
    },
    now: () => NOW,
  })
  return { store, service, tenants, invalidations: () => invalidations }
}

async function main() {
  console.log('Kiértékelés')
  await check('Ki: senkinél; hiányzó sor is Ki', async () => {
    assert.equal(decideFeatureFlag(state('off', { [A]: 'included' }), A).active, false)
    const reader = createFeatureFlagEvaluator({ load: async () => new Map() })
    assert.equal(await reader.isEnabled(KEY, { tenantId: A }), false)
  })
  await check('Kiválasztott: csak a felvett cégnél, új és kizárt cégnél nem', () => {
    const s = state('selected', { [A]: 'included', [B]: 'excluded' })
    assert.deepEqual(decideFeatureFlag(s, A), { active: true, reason: 'selected_included' })
    assert.deepEqual(decideFeatureFlag(s, B), { active: false, reason: 'selected_other' })
    assert.deepEqual(decideFeatureFlag(s, C), { active: false, reason: 'selected_other' })
  })
  await check('Mindenkinek: új cég aktív, kizárt nem', () => {
    const s = state('all', { [B]: 'excluded' })
    assert.deepEqual(decideFeatureFlag(s, 'uj-ceg'), { active: true, reason: 'all' })
    assert.deepEqual(decideFeatureFlag(s, B), { active: false, reason: 'all_excluded' })
  })
  await check('Üres tenant nem lehet aktív, Mindenkinek állapotban sem', async () => {
    const reader = createFeatureFlagEvaluator({ load: async () => new Map([[KEY, state('all')]]) })
    assert.equal(await reader.isEnabled(KEY, { tenantId: '' }), false)
  })

  console.log('Cache és hibatűrés')
  await check('Több flag és több hívás egy lekérdezés; az egyidejű betöltések összevonódnak', async () => {
    let loads = 0
    const reader = createFeatureFlagEvaluator({
      load: async () => {
        loads += 1
        return new Map([['a.a', state('all')], ['b.b', state('off')]])
      },
    })
    const results = await Promise.all([
      reader.isEnabled('a.a', { tenantId: A }),
      reader.isEnabled('b.b', { tenantId: A }),
      reader.isEnabled('c.c', { tenantId: A }),
    ])
    assert.deepEqual(results, [true, false, false])
    await reader.isEnabled('a.a', { tenantId: B })
    assert.equal(loads, 1)
  })
  await check('A leállítás a gyorsítótár lejártával (30 mp) érvényesül a többi példányon', async () => {
    let time = 0
    let mode: FeatureFlagState['mode'] = 'all'
    const reader = createFeatureFlagEvaluator({ now: () => time, load: async () => new Map([[KEY, state(mode)]]) })
    assert.equal(await reader.isEnabled(KEY, { tenantId: A }), true)
    mode = 'off'
    time = 29_000
    assert.equal(await reader.isEnabled(KEY, { tenantId: A }), true, 'még a gyorsítótárból')
    time = 30_000
    assert.equal(await reader.isEnabled(KEY, { tenantId: A }), false)
  })
  await check('A módosító példány azonnal üríti a saját cache-ét', async () => {
    let mode: FeatureFlagState['mode'] = 'all'
    const reader = createFeatureFlagEvaluator({ load: async () => new Map([[KEY, state(mode)]]) })
    assert.equal(await reader.isEnabled(KEY, { tenantId: A }), true)
    mode = 'off'
    reader.invalidate()
    assert.equal(await reader.isEnabled(KEY, { tenantId: A }), false)
  })
  await check('Az ürítés előtt indult betöltés nem írja vissza a régi állapotot', async () => {
    let release: (value: Map<string, FeatureFlagState>) => void = () => undefined
    const responses: Array<() => Promise<Map<string, FeatureFlagState>>> = [
      () => new Promise((resolve) => { release = resolve }),
      async () => new Map([[KEY, state('off')]]),
    ]
    const reader = createFeatureFlagEvaluator({ load: () => (responses.shift() as () => Promise<Map<string, FeatureFlagState>>)() })
    const slow = reader.isEnabled(KEY, { tenantId: A })
    reader.invalidate()
    assert.equal(await reader.isEnabled(KEY, { tenantId: A }), false)
    release(new Map([[KEY, state('all')]]))
    await slow
    assert.equal(await reader.isEnabled(KEY, { tenantId: A }), false, 'a régi válasz nem élhet tovább')
  })
  await check('Adatbázis-hibánál az utolsó ismert állapot marad, a hiba naplózódik', async () => {
    let time = 0
    let fail = false
    const errors: unknown[] = []
    const reader = createFeatureFlagEvaluator({
      now: () => time,
      load: async () => {
        if (fail) throw new Error('db down')
        return new Map([[KEY, state('all')]])
      },
      onLoadError: (error) => errors.push(error),
    })
    assert.equal(await reader.isEnabled(KEY, { tenantId: A }), true)
    fail = true
    time = 31_000
    assert.equal(await reader.isEnabled(KEY, { tenantId: A }), true)
    assert.equal(errors.length, 1)
  })
  await check('Hidegindításnál adatbázis-hibával minden flag Ki, helyreállás után él', async () => {
    let time = 0
    let fail = true
    const reader = createFeatureFlagEvaluator({
      now: () => time,
      load: async () => {
        if (fail) throw new Error('db down')
        return new Map([[KEY, state('all')]])
      },
    })
    assert.equal(await reader.isEnabled(KEY, { tenantId: A }), false)
    fail = false
    time = 1_000
    assert.equal(await reader.isEnabled(KEY, { tenantId: A }), false, 'a visszatartás alatt nem próbálkozik újra')
    time = 6_000
    assert.equal(await reader.isEnabled(KEY, { tenantId: A }), true)
  })
  await check('Hiba után nem kérdez kérésenként: a visszatartás alatt nincs új lekérdezés', async () => {
    let loads = 0
    const reader = createFeatureFlagEvaluator({
      now: () => 0,
      load: async () => {
        loads += 1
        throw new Error('db down')
      },
    })
    await reader.isEnabled(KEY, { tenantId: A })
    await reader.isEnabled(KEY, { tenantId: A })
    assert.equal(loads, 1)
  })
  await check('Lassú adatbázisnál nem vár a végtelenségig, az ismert állapotból dönt', async () => {
    const reader = createFeatureFlagEvaluator({ loadTimeoutMs: 5, load: () => new Promise(() => undefined) })
    assert.equal(await reader.isEnabled(KEY, { tenantId: A }), false)
  })
  await check('Statikus teszt-kiértékelő', async () => {
    const reader = createStaticFeatureFlags({ 'a.a': true, 'b.b': [A], 'c.c': false })
    assert.equal(await reader.isEnabled('a.a', { tenantId: B }), true)
    assert.equal(await reader.isEnabled('b.b', { tenantId: A }), true)
    assert.equal(await reader.isEnabled('b.b', { tenantId: B }), false)
    assert.equal(await reader.isEnabled('c.c', { tenantId: A }), false)
  })

  console.log('Jogosultság')
  await check('Operátor nem állíthat Mindenkinek állapotot, auditor semmit, és ez a szolgáltatásban dől el', async () => {
    const { service, store } = setup()
    assert.equal((await service.apply({ key: KEY, expectedVersion: 0, mode: 'all', justification: 'mindenkinek', actor: operator })).status, 'forbidden')
    assert.equal((await service.preview({ key: KEY, expectedVersion: 0, mode: 'all', actor: operator })).status, 'forbidden')
    assert.equal((await service.apply({ key: KEY, expectedVersion: 0, mode: 'selected', justification: 'indok', actor: auditor })).status, 'forbidden')
    assert.equal(store.commits, 0)
  })
  await check('Operátor kezelheti a kiválasztott cégeket, kizárhat és leállíthat, Mindenkinek állapotból is', async () => {
    const { service, store } = setup()
    assert.equal((await service.apply({ key: KEY, expectedVersion: 0, mode: 'all', justification: 'teljes', actor: superadmin })).status, 'applied')
    assert.equal((await service.apply({ key: KEY, expectedVersion: 1, tenantAccess: [{ tenantId: A, access: 'excluded' }], justification: 'kizárás', actor: operator })).status, 'applied')
    assert.equal((await service.apply({ key: KEY, expectedVersion: 2, mode: 'off', justification: 'hiba van', actor: operator })).status, 'applied')
    assert.equal(store.rows.get(KEY)?.mode, 'off')
  })

  console.log('Összegzés és mentés')
  await check('Az összegzés ugyanazokat a cégeket mutatja, ahol a mentés után ténylegesen változik', async () => {
    const { service, store, tenants } = setup()
    const input = { key: KEY, expectedVersion: 0, mode: 'selected' as const, tenantAccess: [{ tenantId: A, access: 'included' as const }], actor: operator }
    const preview = await service.preview(input)
    assert.equal(preview.status, 'ok')
    const applied = await service.apply({ ...input, justification: 'saját cég' })
    assert.equal(applied.status, 'applied')
    if (preview.status !== 'ok' || applied.status !== 'applied') return
    assert.deepEqual(preview.gains, applied.gains)
    const after = featureFlagSnapshotOf(await store.loadAll()).get(KEY) as FeatureFlagState
    const actual = tenants.filter((t) => decideFeatureFlag(after, t.id).active).map((t) => t.id)
    assert.deepEqual(preview.gains.map((t) => t.id), actual)
    assert.deepEqual(actual, [A])
  })
  await check('A hatás-számítás a bővítést és a szűkítést is látja', () => {
    assert.deepEqual(diffFeatureFlagEffect(state('selected', { [A]: 'included' }), state('all', { [B]: 'excluded' }), [A, B, C]), { gains: [C], loses: [] })
    assert.deepEqual(diffFeatureFlagEffect(state('all'), state('selected', { [A]: 'included' }), [A, B]), { gains: [], loses: [B] })
  })
  await check('Változás nélkül nem ír semmit', async () => {
    const { service, store } = setup()
    const result = await service.apply({ key: KEY, expectedVersion: 0, mode: 'off', justification: 'semmi', actor: operator })
    assert.equal(result.status, 'no_change')
    assert.equal(store.commits, 0)
  })
  await check('Párhuzamos szerkesztés: a második érthető választ kap és nem ír felül semmit', async () => {
    const { service, store } = setup()
    const change = { key: KEY, expectedVersion: 0, tenantAccess: [{ tenantId: A, access: 'included' as const }], justification: 'első', actor: operator }
    assert.equal((await service.apply(change)).status, 'applied')
    assert.equal((await service.apply({ ...change, tenantAccess: [{ tenantId: B, access: 'included' }], justification: 'második' })).status, 'conflict')
    assert.equal((await service.preview({ key: KEY, expectedVersion: 0, mode: 'selected', actor: operator })).status, 'conflict')
    assert.deepEqual(store.rows.get(KEY)?.tenants.map((t) => t.tenantId), [A])
  })
  await check('Indoklás kötelező, leállításnál is', async () => {
    const { service } = setup()
    await service.apply({ key: KEY, expectedVersion: 0, mode: 'selected', tenantAccess: [{ tenantId: A, access: 'included' }], justification: 'indul', actor: operator })
    assert.equal((await service.apply({ key: KEY, expectedVersion: 1, mode: 'off', justification: '  ', actor: operator })).status, 'invalid_justification')
    assert.equal((await service.apply({ key: KEY, expectedVersion: 1, mode: 'off', justification: 'hiba', actor: operator })).status, 'applied')
  })
  await check('Leállítás után a cégek listája megmarad, onnan folytatható; a mentés üríti a cache-t', async () => {
    const { service, store, invalidations } = setup()
    await service.apply({ key: KEY, expectedVersion: 0, mode: 'selected', tenantAccess: [{ tenantId: A, access: 'included' }, { tenantId: B, access: 'included' }], justification: 'indul', actor: operator })
    await service.apply({ key: KEY, expectedVersion: 1, mode: 'off', justification: 'hiba', actor: operator })
    assert.equal(store.rows.get(KEY)?.tenants.length, 2)
    assert.equal(store.rows.get(KEY)?.stoppedAt?.getTime(), NOW.getTime())
    const resumed = await service.apply({ key: KEY, expectedVersion: 2, mode: 'selected', justification: 'javítva', actor: operator })
    assert.equal(resumed.status, 'applied')
    if (resumed.status === 'applied') assert.deepEqual(resumed.gains.map((t) => t.id), [A, B])
    assert.equal(store.rows.get(KEY)?.stoppedAt, null)
    assert.equal(invalidations(), 3)
  })
  await check('Kódból törölt flag nem jelenik meg és nem módosítható; ismeretlen cég nem vehető fel', async () => {
    const { service, store } = setup({})
    store.rows.set('torolt.flag', { key: 'torolt.flag', mode: 'all', version: 1, fullRolloutAt: null, removeBy: null, stoppedAt: null, updatedAt: NOW, tenants: [] })
    assert.deepEqual(await service.list(), [])
    assert.deepEqual(await service.tenantView(A), [])
    assert.equal(await service.detail('torolt.flag'), null)
    assert.equal((await service.apply({ key: 'torolt.flag', expectedVersion: 1, mode: 'off', justification: 'törlés', actor: operator })).status, 'unknown_flag')
    const other = setup()
    assert.equal((await other.service.apply({ key: KEY, expectedVersion: 0, tenantAccess: [{ tenantId: 'idegen', access: 'included' }], justification: 'rossz', actor: operator })).status, 'invalid_tenant')
    assert.equal((await other.service.apply({ key: 'constructor', expectedVersion: 0, mode: 'off', justification: 'proto', actor: operator })).status, 'unknown_flag')
  })
  await check('Lista és cég szerinti nézet: állapot, okok, számok', async () => {
    const { service } = setup()
    await service.apply({ key: KEY, expectedVersion: 0, mode: 'all', tenantAccess: [{ tenantId: B, access: 'excluded' }], justification: 'teljes', actor: superadmin })
    const [item] = await service.list()
    assert.equal(item.mode, 'all')
    assert.equal(item.excludedCount, 1)
    assert.equal((await service.tenantView(A))[0].decision.reason, 'all')
    assert.equal((await service.tenantView(B))[0].decision.reason, 'all_excluded')
    const detail = await service.detail(KEY)
    assert.equal(detail?.tenants.find((t) => t.id === B)?.access, 'excluded')
    assert.equal(detail?.tenants.find((t) => t.id === C)?.decision.active, true)
  })

  console.log('Törlési határidő (60 nap)')
  await check('Nem létező naptári nap nem értelmezhető át más határidővé', () => {
    assert.equal(isRealDate('2027-02-31'), false)
    assert.equal(isRealDate('2027-02-29'), false)
    assert.equal(isRealDate('2028-02-29'), true)
    assert.equal(isRealDate('2027-03-03'), true)
  })
  await check('Az első Mindenkinek állapot indítja, újabb teljes bevezetés nem tolja el', async () => {
    const { service, store } = setup()
    await service.apply({ key: KEY, expectedVersion: 0, mode: 'all', justification: 'teljes', actor: superadmin })
    const first = store.rows.get(KEY)
    assert.equal(first?.fullRolloutAt?.getTime(), NOW.getTime())
    assert.equal(first?.removeBy?.toISOString(), '2027-01-06T10:00:00.000Z')
    await service.apply({ key: KEY, expectedVersion: 1, mode: 'off', justification: 'hiba', actor: operator })
    await service.apply({ key: KEY, expectedVersion: 2, mode: 'all', justification: 'újra', actor: superadmin })
    assert.equal(store.rows.get(KEY)?.removeBy?.toISOString(), '2027-01-06T10:00:00.000Z')
  })
  await check('Hosszabbítás indoklással és auditálva; rövidíteni és auditor nem tud; teljes bevezetés előtt nincs mit', async () => {
    const { service, store } = setup()
    const later = new Date('2027-02-01T00:00:00Z')
    assert.equal((await service.extendDeadline({ key: KEY, expectedVersion: 0, removeBy: later, justification: 'még kell', actor: operator })).status, 'conflict')
    await service.apply({ key: KEY, expectedVersion: 0, mode: 'selected', justification: 'indul', actor: operator })
    assert.equal((await service.extendDeadline({ key: KEY, expectedVersion: 1, removeBy: later, justification: 'még kell', actor: operator })).status, 'invalid_date')
    await service.apply({ key: KEY, expectedVersion: 1, mode: 'all', justification: 'teljes', actor: superadmin })
    assert.equal((await service.extendDeadline({ key: KEY, expectedVersion: 2, removeBy: later, justification: 'még kell', actor: auditor })).status, 'forbidden')
    assert.equal((await service.extendDeadline({ key: KEY, expectedVersion: 2, removeBy: later, justification: '', actor: operator })).status, 'invalid_justification')
    assert.equal((await service.extendDeadline({ key: KEY, expectedVersion: 2, removeBy: new Date('2026-12-01T00:00:00Z'), justification: 'rövidebb', actor: operator })).status, 'invalid_date')
    assert.equal((await service.extendDeadline({ key: KEY, expectedVersion: 2, removeBy: later, justification: 'még kell', actor: operator })).status, 'extended')
    assert.equal(store.rows.get(KEY)?.removeBy?.getTime(), later.getTime())
    assert.ok(store.audit.some((row) => row.action === 'platform.feature_flag.deadline_extended' && row.tenantId === null))
  })
  await check('A lejárt határidő látszik: felülvizsgálat és törlés is', async () => {
    const expiredDefinition = { ...definition, reviewBy: '2026-01-01' }
    const { service, store } = setup({ [KEY]: expiredDefinition })
    assert.deepEqual([(await service.list())[0].deadline.kind, (await service.list())[0].deadline.expired], ['review', true])
    store.rows.set(KEY, { key: KEY, mode: 'all', version: 1, fullRolloutAt: NOW, removeBy: new Date('2026-11-01T00:00:00Z'), stoppedAt: null, updatedAt: NOW, tenants: [] })
    assert.deepEqual([(await service.list())[0].deadline.kind, (await service.list())[0].deadline.expired], ['remove', true])
    store.rows.set(KEY, { key: KEY, mode: 'all', version: 1, fullRolloutAt: NOW, removeBy: new Date('2027-01-06T00:00:00Z'), stoppedAt: null, updatedAt: NOW, tenants: [] })
    assert.equal((await service.list())[0].deadline.expired, false)
  })

  console.log('Audit')
  await check('A platform-sor mindent tartalmaz; a cég sora csak a nevet és az új állapotot, idegen adat nélkül', async () => {
    const { service, store } = setup()
    await service.apply({ key: KEY, expectedVersion: 0, mode: 'selected', tenantAccess: [{ tenantId: A, access: 'included' }, { tenantId: B, access: 'included' }], justification: 'titkos indok', actor: operator })
    const platform = store.audit.filter((row) => row.tenantId === null)
    assert.deepEqual(platform.map((row) => row.action).sort(), ['platform.feature_flag.mode_set', 'platform.feature_flag.tenant_access_set'])
    for (const row of platform) {
      assert.equal(row.targetId, null)
      assert.equal(row.actorId, operator.id)
      assert.equal((row.metadata as { flagKey: string }).flagKey, KEY)
      assert.equal((row.metadata as { justification: string }).justification, 'titkos indok')
      assert.equal(Object.hasOwn(row.metadata as object, 'tenantId'), false, 'a felső szintű tenantId a céghez kötné a sort')
    }
    const tenantRows = store.audit.filter((row) => row.tenantId !== null)
    assert.deepEqual(tenantRows.map((row) => row.tenantId).sort(), [A, B])
    for (const row of tenantRows) {
      assert.equal(row.actorId, null)
      assert.deepEqual(row.metadata, { flagKey: KEY, flagTitle: definition.title, active: true })
      const serialized = JSON.stringify(row)
      assert.equal(serialized.includes('titkos indok'), false)
      assert.equal(serialized.includes('Alfa') || serialized.includes('Béta'), false)
    }
  })
  await check('Csak ott keletkezik tenant-sor, ahol a működés tényleg változik', async () => {
    const { service, store } = setup()
    await service.apply({ key: KEY, expectedVersion: 0, tenantAccess: [{ tenantId: A, access: 'included' }], justification: 'kikapcsolva bővít', actor: operator })
    assert.equal(store.audit.filter((row) => row.tenantId !== null).length, 0)
    store.audit = []
    await service.apply({ key: KEY, expectedVersion: 1, mode: 'selected', justification: 'indul', actor: operator })
    assert.deepEqual(store.audit.filter((row) => row.tenantId !== null).map((row) => row.tenantId), [A])
    store.audit = []
    await service.apply({ key: KEY, expectedVersion: 2, tenantAccess: [{ tenantId: A, access: 'excluded' }], justification: 'kizár', actor: operator })
    const row = store.audit.find((entry) => entry.tenantId === A)
    assert.equal(row?.action, 'platform.feature_flag.tenant_access_set')
    assert.equal((row?.metadata as { active: boolean }).active, false)
  })
  await check('Bővítés nem történik meg audit nélkül', async () => {
    const { service, store } = setup()
    store.failAudit = true
    const result = await service.apply({ key: KEY, expectedVersion: 0, mode: 'selected', tenantAccess: [{ tenantId: A, access: 'included' }], justification: 'indul', actor: operator })
    assert.equal(result.status, 'audit_failed')
    assert.equal(store.rows.size, 0)
  })
  await check('Hatás nélküli változás sem megy át audit nélkül', async () => {
    const { service, store } = setup()
    store.failAudit = true
    const result = await service.apply({ key: KEY, expectedVersion: 0, tenantAccess: [{ tenantId: A, access: 'included' }], justification: 'előkészítés', actor: operator })
    assert.equal(result.status, 'audit_failed')
    assert.equal(store.rows.size, 0)
  })
  await check('Új cégekre bővítés sem megy át audit nélkül, ha minden jelenlegi céget kizárnak', async () => {
    const { service, store, tenants } = setup()
    await service.apply({ key: KEY, expectedVersion: 0, mode: 'selected', tenantAccess: [{ tenantId: A, access: 'included' }], justification: 'indul', actor: operator })
    const before = await store.find(KEY)
    store.failAudit = true
    const result = await service.apply({ key: KEY, expectedVersion: 1, mode: 'all', tenantAccess: tenants.map(({ id }) => ({ tenantId: id, access: 'excluded' })), justification: 'új cégeknek', actor: superadmin })
    assert.equal(result.status, 'audit_failed')
    assert.deepEqual(await store.find(KEY), before)
  })
  await check('Leállítás és szűkítés audit-kiesésnél is érvényesül, de látható hibát ad', async () => {
    const { service, store, invalidations } = setup()
    await service.apply({ key: KEY, expectedVersion: 0, mode: 'all', justification: 'teljes', actor: superadmin })
    const before = invalidations()
    store.failAudit = true
    const narrowed = await service.apply({ key: KEY, expectedVersion: 1, tenantAccess: [{ tenantId: A, access: 'excluded' }], justification: 'kizár', actor: operator })
    assert.deepEqual(narrowed.status === 'applied' && narrowed.auditFailed, true)
    const stopped = await service.apply({ key: KEY, expectedVersion: 2, mode: 'off', justification: 'hiba', actor: operator })
    assert.deepEqual(stopped.status === 'applied' && stopped.auditFailed, true)
    assert.equal(store.rows.get(KEY)?.mode, 'off')
    assert.equal(invalidations(), before + 2)
  })
  await check('Leállítás cég nélkül is átmegy audit-kiesésnél', async () => {
    const { service, store } = setup()
    await service.apply({ key: KEY, expectedVersion: 0, mode: 'selected', justification: 'indul', actor: operator })
    store.failAudit = true
    const stopped = await service.apply({ key: KEY, expectedVersion: 1, mode: 'off', justification: 'hiba', actor: operator })
    assert.deepEqual(stopped.status === 'applied' && stopped.auditFailed, true)
  })
  await check('Határidő-hosszabbítás audit nélkül nem történik meg', async () => {
    const { service, store } = setup()
    await service.apply({ key: KEY, expectedVersion: 0, mode: 'all', justification: 'teljes', actor: superadmin })
    store.failAudit = true
    assert.equal((await service.extendDeadline({ key: KEY, expectedVersion: 1, removeBy: new Date('2027-03-01T00:00:00Z'), justification: 'kell', actor: operator })).status, 'audit_failed')
  })

  console.log('Kapuk')
  await check('Szerverművelet és API: másik cég nem éri el, a hiba nem nevezi meg a flaget', async () => {
    const gates = createFeatureGates(createStaticFeatureFlags({ [KEY]: [A] }))
    await gates.requireFeature(KEY, { tenantId: A })
    await assert.rejects(gates.requireFeature(KEY, { tenantId: B }), (error: Error) => {
      assert.ok(error instanceof FeatureNotEnabledError)
      assert.equal(error.message.includes(KEY), false)
      return true
    })
    assert.equal(await gates.featureGuardResponse(KEY, { tenantId: A }), null)
    const denied = await gates.featureGuardResponse(KEY, { tenantId: B })
    assert.equal(denied?.status, 404)
    assert.equal(JSON.stringify(await denied?.json()).includes(KEY), false)
  })
  await check('Eszköz-kapu: flag nélküli eszközhöz nem nyúl, ismeretlen név nem vezet prototípushoz', async () => {
    const gate = createToolFeatureGate({ flagged_tool: KEY }, createStaticFeatureFlags({ [KEY]: [A] }))
    assert.equal(await gate.blocksTool('flagged_tool', A), false)
    assert.equal(await gate.blocksTool('flagged_tool', B), true)
    assert.equal(await gate.blocksTool('other_tool', B), false)
    assert.equal(await gate.blocksTool('constructor', B), false)
    assert.deepEqual([...(await gate.disabledTools(B))], ['flagged_tool'])
    assert.deepEqual([...(await gate.disabledTools(A))], [])
  })
  await check('Kiértékelő nélkül a flag mögötti eszköz tiltott', async () => {
    assert.equal(await createFeatureFlagGateClosed({ flagged_tool: KEY }).blocksTool('flagged_tool', A), true)
  })
  await check('Üres megfeleltetésnél nincs lekérdezés', async () => {
    let calls = 0
    const gate = createToolFeatureGate({}, { isEnabled: async () => { calls += 1; return false } })
    await gate.disabledTools(A)
    await gate.blocksTool('any_tool', A)
    assert.equal(calls, 0)
  })
  await check('A letiltott eszköz nem kerül a szerverre', () => {
    const registered: string[] = []
    const server = { registerTool: ((name: string) => { registered.push(name) }) as (...args: never[]) => unknown }
    hideDisabledTools(server, new Set(['hidden']))
    const register = server.registerTool as unknown as (name: string) => void
    register('hidden')
    register('visible')
    assert.deepEqual(registered, ['visible'])
  })

  console.log('Kódbeli lista')
  await check('Lista-ellenőrzés: kötelező mezők, kulcsformátum, törölt kulcs, dátum', () => {
    const today = new Date('2026-11-07T00:00:00Z')
    assert.deepEqual(validateFeatureFlagRegistry({ [KEY]: definition }, [], today), { errors: [], warnings: [] })
    const bad = validateFeatureFlagRegistry(
      {
        Rossz: definition,
        'nincs_pont': definition,
        'torolt.kulcs': definition,
        'hianyos.mezok': { ...definition, title: { hu: 'Csak magyar', en: '' }, owner: ' ', issue: 0, reviewBy: '2026-13-45' },
      },
      ['torolt.kulcs'],
      today,
    )
    for (const expected of ['Rossz', 'nincs_pont', 'torolt.kulcs: törölt', 'title', 'felelős', 'issue', 'dátum']) {
      assert.ok(bad.errors.some((error) => error.includes(expected)), expected)
    }
  })
  await check('A lejárt felülvizsgálat figyelmeztet, de nem hiba', () => {
    const result = validateFeatureFlagRegistry({ [KEY]: { ...definition, reviewBy: '2026-01-01' } }, [], new Date('2026-11-07T00:00:00Z'))
    assert.deepEqual(result.errors, [])
    assert.equal(result.warnings.length, 1)
  })
  await check('#1126 WP-5: a külső kliens-beállítás hibái megbuknak, a helyes átmegy', () => {
    const run = (externalClients: unknown) =>
      validateFeatureFlagRegistry({ [KEY]: { ...definition, externalClients } as FeatureFlagDefinition }, [], new Date('2026-11-07T00:00:00Z')).errors
    assert.deepEqual(run({ clients: ['platform_chat', 'hermes'], onStop: 'old_path' }), [])
    assert.equal(run({ clients: [], onStop: 'old_path' }).length, 1)
    assert.equal(run({ clients: ['ismeretlen'], onStop: 'old_path' }).length, 1)
    assert.equal(run({ clients: ['hermes'], onStop: 'kitalalt' }).length, 1)
  })
  await check('#1126 WP-5: a kliens csak a neki szánt, a cégnél aktív flageket kapja; más cég és a többi flag rejtve', async () => {
    const chat = { clients: ['platform_chat'], onStop: 'finish_run' } as const
    const hermes = { clients: ['hermes'], onStop: 'old_path' } as const
    const flags = createExternalClientFlags(
      {
        'z.chat': { ...definition, externalClients: chat },
        'a.chat': { ...definition, externalClients: chat },
        'b.hermes': { ...definition, externalClients: hermes },
        'c.internal': definition,
      },
      createStaticFeatureFlags({ 'z.chat': true, 'a.chat': [A], 'b.hermes': [A], 'c.internal': true }) as never,
    )
    assert.deepEqual(await flags('platform_chat', A), [{ key: 'a.chat', onStop: 'finish_run' }, { key: 'z.chat', onStop: 'finish_run' }])
    assert.deepEqual(await flags('platform_chat', B), [{ key: 'z.chat', onStop: 'finish_run' }])
    assert.deepEqual(await flags('hermes', A), [{ key: 'b.hermes', onStop: 'old_path' }])
    assert.deepEqual(await flags('hermes', B), [])
  })
  await check('#1126 WP-5: ha egy flag sincs külső kliensnek szánva, a kiértékelőt sem kérdezi', async () => {
    let reads = 0
    const flags = createExternalClientFlags({ 'c.internal': definition }, { isEnabled: async () => (reads++, true) })
    assert.deepEqual(await flags('platform_chat', A), [])
    assert.deepEqual(await flags('hermes', A), [])
    assert.equal(reads, 0)
  })
  await check('#1126 WP-5: az éles chat-folytatás és a Hermes-snapshot be van kötve a kiértékelőbe', async () => {
    const [{ clientPolicyStore }, { continuationDeps }] = await Promise.all([
      import('../src/auth/gateway-token-deps'),
      import('../src/auth/platform-chat-deps'),
    ])
    assert.equal(typeof clientPolicyStore.activeFeatureFlags, 'function')
    assert.equal(typeof continuationDeps().activeFeatureFlags, 'function')
  })
  await check('Az éles lista érvényes; a lejárt dátum csak figyelmeztetés a CI-ban', () => {
    const { errors, warnings } = validateFeatureFlagRegistry(FEATURE_FLAGS, RETIRED_FEATURE_FLAG_KEYS, new Date())
    assert.deepEqual(errors, [])
    for (const warning of warnings) console.log(`::warning title=Feature flag felülvizsgálat::${warning}`)
  })
  await check('Az eszköz-megfeleltetés csak létező flagre mutat', () => {
    for (const [tool, key] of Object.entries(TOOL_FEATURE_FLAGS)) {
      assert.ok(Object.hasOwn(FEATURE_FLAGS, key), `${tool} -> ${key}`)
    }
  })

  console.log(`\n${failures === 0 ? 'feature-flags: ok' : `feature-flags: ${failures} failed`}`)
  if (failures > 0) process.exit(1)
}

void main()
