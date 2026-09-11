/**
 * Turn-continuation + skill runtimeHints unit tesztek.
 * Futtatás: npx tsx scripts/turn-continuation.test.ts
 */
import assert from 'node:assert/strict'
import {
  LOOP_GUARD_DEFAULTS,
  mergeSkillRuntimeHints,
  resolveLoopGuardLimits,
} from '../src/domain/agent/loop-stop-decision'
import {
  buildReturnedDelegationPrompt,
  buildTurnContinuationPrompt,
  isExplicitContinuationRequest,
  shouldInjectTurnContinuation,
} from '../src/domain/agent/turn-continuation'
import {
  aggregateSkillRuntimeHints,
  parseSkillContent,
} from '../src/lib/skill/skill-content'
import { parseSkillMd } from '../src/lib/skill/skill-md-adapter'
import { buildLoadedSkillPrompt } from '../src/lib/skill/skill-context'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

console.log('\nturn-continuation + skill runtimeHints\n')

check('continuation: csak exhausted + resource reason', () => {
  assert.equal(
    shouldInjectTurnContinuation({
      status: 'exhausted',
      reason: 'wallclock_timeout',
      activities: [],
    }),
    true,
  )
  assert.equal(
    shouldInjectTurnContinuation({
      status: 'completed',
      reason: 'wallclock_timeout',
      activities: [],
    }),
    false,
  )
  assert.equal(
    shouldInjectTurnContinuation({
      status: 'exhausted',
      reason: 'cancelled',
      activities: [],
    }),
    false,
  )
})

check('explicit folytatás: rövid folytasd/continue igen, új feladat nem', () => {
  assert.equal(isExplicitContinuationRequest('folytasd'), true)
  assert.equal(isExplicitContinuationRequest('Continue!'), true)
  assert.equal(isExplicitContinuationRequest('készíts inkább egy Excelt'), false)
})

check('continuation prompt: ne kezdj elölről + aktivitások', () => {
  const prompt = buildTurnContinuationPrompt(
    {
      status: 'exhausted',
      reason: 'wallclock_timeout',
      activities: [
        { kind: 'tool', title: 'tulajdoni_lap_parse', detail: 'valid', status: 'done' },
        {
          kind: 'tool',
          title: 'xlsx_append_rows',
          detail: 'a futás leállt — kimaradt',
          status: 'skipped',
        },
        { kind: 'reasoning', title: 'Gondolkodás', status: 'done' },
      ],
    },
    ['egyeztetes.xlsx'],
  )
  assert.match(prompt, /NE kezdd elölről/)
  assert.match(prompt, /reconcile_records/)
  assert.match(prompt, /tulajdoni_lap_parse/)
  assert.match(prompt, /xlsx_append_rows/)
  assert.match(prompt, /egyeztetes\.xlsx/)
  assert.match(prompt, /1 kész, 1 kimaradt/)
})

check('mergeSkillRuntimeHints: csak emelhet', () => {
  const base = resolveLoopGuardLimits({}, 20, 'chat')
  assert.equal(base.maxWallClockMs, LOOP_GUARD_DEFAULTS.maxWallClockMs)
  const raised = mergeSkillRuntimeHints(base, { maxWallClockMs: 900_000, maxToolCalls: 120 })
  assert.equal(raised.maxWallClockMs, 900_000)
  assert.equal(raised.maxToolCalls, 120)
  const ignoredLower = mergeSkillRuntimeHints(raised, { maxWallClockMs: 60_000 })
  assert.equal(ignoredLower.maxWallClockMs, 900_000)
})

check('parseSkillContent: runtimeHints megmarad', () => {
  const content = parseSkillContent({
    instructions: ['Tedd meg.'],
    runtimeHints: { maxWallClockMs: 900_000, preferredMode: 'task' },
  })
  assert.equal(content.runtimeHints?.maxWallClockMs, 900_000)
  assert.equal(content.runtimeHints?.preferredMode, 'task')
})

check('aggregateSkillRuntimeHints: max + task nyer', () => {
  const agg = aggregateSkillRuntimeHints([
    { maxWallClockMs: 300_000, preferredMode: 'chat' },
    { maxWallClockMs: 900_000, maxToolCalls: 80, preferredMode: 'task' },
  ])
  assert.equal(agg?.maxWallClockMs, 900_000)
  assert.equal(agg?.maxToolCalls, 80)
  assert.equal(agg?.preferredMode, 'task')
})

check('SKILL.md frontmatter → runtimeHints', () => {
  const parsed = parseSkillMd(`---
name: long-job
description: Hosszú feladat
max-wall-clock-ms: 900000
max-tool-calls: 120
preferred-mode: task
---

# Lépések
Csináld meg.
`)
  assert.equal(parsed.content.runtimeHints?.maxWallClockMs, 900_000)
  assert.equal(parsed.content.runtimeHints?.maxToolCalls, 120)
  assert.equal(parsed.content.runtimeHints?.preferredMode, 'task')
})

check('buildLoadedSkillPrompt említi a keretet', () => {
  const text = buildLoadedSkillPrompt(
    {
      skillId: 's1',
      skillVersionId: 'v1',
      name: 'demo',
      description: 'd',
      version: 1,
    },
    {
      instructions: ['Lépés.'],
      triggerKeywords: [],
      parameters: [],
      runtimeHints: { maxWallClockMs: 900_000 },
    },
  )
  assert.match(text, /900 s/)
})

check('megérkezett delegáció: a válasz bekerül és tiltja az újrakérdezést', () => {
  const text = buildReturnedDelegationPrompt([
    {
      answeredBy: 'Ákos',
      question: 'Milyen formátumú a /reports/query q paramétere?',
      answer: 'base64url(JSON), a period objektummal.',
      confidence: 'high',
    },
  ])
  assert.match(text, /Ákos/)
  assert.match(text, /base64url/)
  assert.match(text, /NE kérdezd meg ugyanazt/)
  assert.match(text, /magabiztosság: high/)
})

check('megérkezett delegáció: üres válasz nem ad blokkot', () => {
  assert.equal(buildReturnedDelegationPrompt([]), '')
  assert.equal(
    buildReturnedDelegationPrompt([
      { answeredBy: 'Ákos', question: 'kérdés', answer: '   ' },
    ]),
    '',
  )
})

check('megérkezett delegáció: túl hosszú válasz levágva', () => {
  const text = buildReturnedDelegationPrompt([
    { answeredBy: 'Ákos', question: 'kérdés', answer: 'x'.repeat(6_000) },
  ])
  assert.match(text, /levágva/)
  assert.ok(text.length < 6_000, 'a blokk nem viheti be a teljes választ')
})

if (failures > 0) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log('\nAll passed')
