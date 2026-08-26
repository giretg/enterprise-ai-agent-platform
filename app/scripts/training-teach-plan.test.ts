/**
 * Tanítás: szemantikus terv alkalmazása a meglévő szabályokra.
 * Futtatás: npm run test:training-teach-plan
 */
import assert from 'node:assert/strict'
import { serializeMemoryItems } from '../src/domain/training/memory-items'
import {
  applyTeachPlan,
  changeSummaryFromTeachPlan,
  emptyTeachPlan,
  sanitizeTeachPlan,
} from '../src/domain/training/teach-plan'
import { LlmTeachAnalyzer } from '../src/domain/training/teach-analyzer'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

const existing = [
  'A riport legyen vezetői felhasználásra alkalmas.',
  'Ha nem kér mást felhasználó, akkor a riport formátuma legyen html',
  'A riportokat html formában készítsd.',
]

async function run() {
  await test('kiegészítő tanítás csak hozzáad', () => {
  const plan = emptyTeachPlan('PDF-et csatolj')
  const next = applyTeachPlan(serializeMemoryItems(existing), plan)
  assert.match(next, /PDF-et csatolj/)
  assert.match(next, /html formában/)
  const summary = changeSummaryFromTeachPlan(existing, plan)
  assert.deepEqual(summary.added, ['PDF-et csatolj'])
  assert.deepEqual(summary.rewritten, [])
  assert.deepEqual(summary.removed, [])
})

  await test('ellentmondó formátum átírja a html szabályokat, nem fűzi mellé', () => {
  const teaching = 'A riportok mindig Microsoft Word formátumban készüljenek.'
  const plan = sanitizeTeachPlan(
    existing,
    {
      added: [teaching],
      rewritten: [
        {
          from: 'Ha nem kér mást felhasználó, akkor a riport formátuma legyen html',
          to: 'Ha nem kér mást felhasználó, akkor a riport formátuma legyen Microsoft Word',
        },
        {
          from: 'A riportokat html formában készítsd.',
          to: 'A riportokat Microsoft Word formában készítsd.',
        },
      ],
      removed: [],
    },
    teaching,
  )
  const next = applyTeachPlan(serializeMemoryItems(existing), plan)
  assert.doesNotMatch(next, /html/)
  assert.match(next, /Microsoft Word/)
  const summary = changeSummaryFromTeachPlan(existing, plan)
  assert.equal(summary.rewritten.length, 2)
  assert.equal(summary.removed.length, 0)
  assert.ok(summary.unchanged.includes('A riport legyen vezetői felhasználásra alkalmas.'))
})

  await test('ismeretlen from-ot eldob, üres tervre a tanítás hozzáadása marad', () => {
  const plan = sanitizeTeachPlan(
    existing,
    { added: [], rewritten: [{ from: 'ilyen szabály nincs', to: 'semmi' }], removed: [] },
    'Új szabály',
  )
  assert.deepEqual(plan, emptyTeachPlan('Új szabály'))
})

  await test('LLM analyzer a modell tervét a meglévő szabályokra illeszti', async () => {
  const analyzer = new LlmTeachAnalyzer({
    model: {
      async call() {
        return {
          content: JSON.stringify({
            added: ['A riportok mindig Microsoft Word formátumban készüljenek.'],
            rewritten: [
              {
                from: 'A riportokat html formában készítsd.',
                to: 'A riportokat Microsoft Word formában készítsd.',
              },
            ],
            removed: [],
          }),
        }
      },
    },
    modelConfig: { provider: 'ollama', model: 'test' },
  })
  const plan = await analyzer.analyze({
    existingItems: existing,
    teaching: 'A riportok mindig Microsoft Word formátumban készüljenek.',
    agentId: 'agent-1',
  })
  assert.equal(plan.rewritten.length, 1)
  assert.equal(plan.rewritten[0]?.from, 'A riportokat html formában készítsd.')
  assert.ok(plan.added[0]?.includes('Microsoft Word'))
})

  await test('üres szabálykészletre nincs modellhívás, csak hozzáadás', async () => {
  let calls = 0
  const analyzer = new LlmTeachAnalyzer({
    model: {
      async call() {
        calls += 1
        return { content: '{}' }
      },
    },
    modelConfig: { provider: 'ollama', model: 'test' },
  })
  const plan = await analyzer.analyze({
    existingItems: [],
    teaching: 'PDF-et csatolj',
    agentId: 'agent-1',
  })
  assert.equal(calls, 0)
  assert.deepEqual(plan, emptyTeachPlan('PDF-et csatolj'))
})

  await test('az elemző nem örökli az agent 16k maxTokens-ét', async () => {
  let seenMaxTokens: number | undefined
  const analyzer = new LlmTeachAnalyzer({
    model: {
      async call(params) {
        seenMaxTokens = params.modelConfig.maxTokens
        return {
          content: JSON.stringify({
            added: ['PDF-et csatolj'],
            rewritten: [],
            removed: [],
          }),
        }
      },
    },
  })
  await analyzer.analyze({
    existingItems: existing,
    teaching: 'PDF-et csatolj',
    agentId: 'agent-1',
    modelConfig: {
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash-0731',
      maxTokens: 16384,
    },
  })
  assert.equal(seenMaxTokens, 4096)
})

  await test('beragadt modellhívásra időtúllépés, nem végtelen várakozás', async () => {
  const analyzer = new LlmTeachAnalyzer({
    model: {
      call: () => new Promise(() => {}),
    },
    modelConfig: { provider: 'openrouter', model: 'test' },
    timeoutMs: 40,
  })
  await assert.rejects(
    () =>
      analyzer.analyze({
        existingItems: existing,
        teaching: 'PDF-et csatolj',
        agentId: 'agent-1',
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /túl sokáig tartott/i)
      return true
    },
  )
})

  await test('részleges from-egyezés, ha egyértelmű', () => {
  const plan = sanitizeTeachPlan(
    existing,
    {
      added: [],
      rewritten: [{ from: 'html formában készítsd', to: 'Word formában készítsd.' }],
      removed: [],
    },
    'Word',
  )
  assert.equal(plan.rewritten[0]?.from, 'A riportokat html formában készítsd.')
})

  if (failures > 0) {
    console.error(`\n${failures} training-teach-plan teszt piros`)
    process.exit(1)
  }
  console.log('\nÖsszes training-teach-plan teszt zöld')
}

void run()
