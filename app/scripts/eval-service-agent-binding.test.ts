/**
 * Eval governance regressziós teszt — tenant-határ, eval↔agent kötés és
 * golden-set kiértékelés.
 *
 * Kontextus (Eval / Governance review, 2026-07-29): az `EvalService.run` a hívó
 * által megadott `agentVersion`-t metaadatként az `EvalRun`-ba írja, és az
 * eredmény az adott agent MINŐSÉGI KAPUJAKÉNT jelenik meg a tanítás-jóváhagyási
 * úton. Két invariáns:
 *   1. Az eval csak a saját agentjéhez (`Eval.agentId`) futtatható — különben egy
 *      másik (akár enyhébb golden-setű) agent evalja hamisan a cél-agent
 *      kapujának eredménye lehetne. Mismatch esetén fail-closed: EvalRun nem jön
 *      létre.
 *   2. A control-plane belépési pontok (createEval/runEval/listEvalsForAgent) az
 *      agentet az aktív tenant-kontextusból oldják fel; cross-tenant agent opak
 *      `Agent not found`-dal elutasítva, megosztott (tenantId === null) agent
 *      elérhető marad. Ezt az `assertAgentTenantReachable` invariáns adja.
 *
 * A `Pick<typeof prisma, 'eval' | 'evalRun'>` konstruktor-DI-t használjuk:
 * in-memory fake, DB nélkül. Futtatás: npm run test:eval-service
 */
import assert from 'node:assert/strict'
import type { Eval, EvalRun } from '@prisma/client'
import { EvalService, type GoldenSetAssertion } from '../src/domain/eval/eval-service'
import { assertAgentTenantReachable } from '../src/lib/agent-tenant-access'

let passed = 0
let failed = 0

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
    passed += 1
  } catch (error) {
    console.log(`  FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`)
    failed += 1
  }
}

const TENANT_A = '11111111-1111-1111-1111-111111111111'
const TENANT_B = '22222222-2222-2222-2222-222222222222'

type EvalRow = Pick<Eval, 'id' | 'agentId' | 'goldenSet' | 'status'>

/** Minimális in-memory fake, csak a `run`-hoz szükséges felülettel. */
function makeDb(evals: EvalRow[]) {
  const created: Array<Record<string, unknown>> = []
  const db = {
    eval: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        evals.find((e) => e.id === where.id) ?? null,
    },
    evalRun: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data)
        return { id: `run-${created.length}`, createdAt: new Date(), ...data } as unknown as EvalRun
      },
    },
  }
  return { db, created }
}

function evalRow(id: string, agentId: string, goldenSet: GoldenSetAssertion[]): EvalRow {
  return { id, agentId, goldenSet: goldenSet as unknown as Eval['goldenSet'], status: 'active' }
}

async function main() {
  // ── Invariáns 2: tenant-kapu (assertAgentTenantReachable) ──
  await check('cross-tenant agent nem oldható fel (opak Agent not found)', () => {
    assert.throws(() => assertAgentTenantReachable({ tenantId: TENANT_B }, TENANT_A), /Agent not found/)
  })

  await check('saját tenant és megosztott (null) agent elérhető marad', () => {
    assert.doesNotThrow(() => assertAgentTenantReachable({ tenantId: TENANT_A }, TENANT_A))
    assert.doesNotThrow(() => assertAgentTenantReachable({ tenantId: null }, TENANT_A))
  })

  // ── Invariáns 1: eval↔agent kötés-őr + fail-closed ──
  await check('run visszautasít, ha az eval MÁS agenthez tartozik és nem ír EvalRun-t', async () => {
    const { db, created } = makeDb([
      evalRow('eval-1', 'agent-A', [{ description: 'x', type: 'contains', value: 'ok' }]),
    ])
    const svc = new EvalService(db as never)
    await assert.rejects(
      () =>
        svc.run({
          evalId: 'eval-1',
          agentId: 'agent-B', // idegen agent — nem eval-1 tulajdonosa
          proposedContent: 'ok',
          agentVersion: 3,
          trigger: 'manual',
        }),
      /Eval not found/,
    )
    assert.equal(created.length, 0)
  })

  await check('run visszautasít nem létező evalId-re', async () => {
    const { db } = makeDb([])
    const svc = new EvalService(db as never)
    await assert.rejects(
      () =>
        svc.run({
          evalId: 'missing',
          agentId: 'agent-A',
          proposedContent: 'x',
          agentVersion: 1,
          trigger: 'scheduled',
        }),
      /Eval not found/,
    )
  })

  // ── Golden-set kiértékelés ──
  await check('run lefut és rögzít, ha az eval ehhez az agenthez tartozik (pass=true)', async () => {
    const golden: GoldenSetAssertion[] = [
      { description: 'tartalmazza a köszönést', type: 'contains', value: 'szia' },
      { description: 'nem szivárogtat titkot', type: 'not_contains', value: 'password' },
      { description: 'elég hosszú', type: 'min_length', value: 3 },
    ]
    const { db, created } = makeDb([evalRow('eval-1', 'agent-A', golden)])
    const svc = new EvalService(db as never)
    const run = await svc.run({
      evalId: 'eval-1',
      agentId: 'agent-A',
      proposedContent: 'Szia, miben segíthetek?',
      agentVersion: 7,
      trigger: 'pre_training_approval',
    })
    assert.equal(run.passed, true)
    assert.equal(run.score, 1)
    assert.equal(created.length, 1)
    assert.equal(created[0].evalId, 'eval-1')
    assert.equal(created[0].agentVersion, 7)
    assert.equal(created[0].trigger, 'pre_training_approval')
  })

  await check('run megbukik és részletet rögzít, ha egy assertion nem teljesül', async () => {
    const golden: GoldenSetAssertion[] = [
      { description: 'köszönés', type: 'contains', value: 'szia' },
      { description: 'nincs titok', type: 'not_contains', value: 'password' },
    ]
    const { db, created } = makeDb([evalRow('eval-1', 'agent-A', golden)])
    const svc = new EvalService(db as never)
    const run = await svc.run({
      evalId: 'eval-1',
      agentId: 'agent-A',
      proposedContent: 'itt a password: 1234', // hiányzik a köszönés ÉS titkot szivárogtat
      agentVersion: 1,
      trigger: 'manual',
    })
    assert.equal(run.passed, false)
    assert.equal(run.score, 0)
    const details = created[0].details as { results: Array<{ passed: boolean }> }
    assert.equal(details.results.length, 2)
    assert.equal(details.results.every((r) => r.passed === false), true)
  })

  await check('üres golden-set score-ja 1, de az agent-kötést így is ellenőrzi', async () => {
    const { db } = makeDb([evalRow('eval-1', 'agent-A', [])])
    const svc = new EvalService(db as never)
    const run = await svc.run({
      evalId: 'eval-1',
      agentId: 'agent-A',
      proposedContent: 'bármi',
      agentVersion: 1,
      trigger: 'manual',
    })
    assert.equal(run.passed, true)
    assert.equal(run.score, 1)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
