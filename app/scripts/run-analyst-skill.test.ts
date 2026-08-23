/**
 * Futás-elemzés skill + loop-guard keret — unit tesztek (RA-07 / #351).
 *
 * Futtatás: npm run test:run-analyst-skill
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parseSkillMd } from '../src/lib/skill/skill-md-adapter'
import { validateSkill } from '../src/lib/skill/skill-validator'
import { skillAllowsAttachments } from '../src/lib/skill/skill-content'
import {
  RUN_ANALYSIS_SKILL_NAME,
  RUN_ANALYST_LOOP_GUARD_OVERRIDES,
  RUN_ANALYST_ROLE_TEMPLATE,
  mergeRunAnalystLoopGuardModelConfig,
} from '../src/domain/agents/run-analyst-role'
import { resolveLoopGuardLimits } from '../src/domain/agent/loop-stop-decision'
import {
  shouldPromoteSkillRunToTask,
  buildSkillTaskPromotionMessage,
} from '../src/domain/agent/skill-task-promotion'

let failures = 0

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`)
  }
}

const SKILL_MD = readFileSync(
  resolve(__dirname, '../../docs/skills/futas-elemzes.SKILL.md'),
  'utf8',
)

async function main() {
  console.log('=== Futás-elemzés skill (RA-07 / #351) ===')

  await test('SKILL.md: validál, preferredMode=task, run_* requires', () => {
    const parsed = parseSkillMd(SKILL_MD, { url: 'docs/skills/futas-elemzes.SKILL.md' })
    assert.equal(parsed.name, RUN_ANALYSIS_SKILL_NAME)
    assert.equal(parsed.content.runtimeHints?.preferredMode, 'task')
    assert.equal(skillAllowsAttachments(parsed.content.runtimeHints), false)
    assert.deepEqual(
      parsed.suggestedRequires.map((r) => r.toolName).sort(),
      ['run_index', 'run_stats', 'run_trace', 'ticket_create'].sort(),
    )
    const validation = validateSkill({
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      requires: parsed.suggestedRequires,
    })
    assert.equal(validation.ok, true, validation.errors.join(' · '))
    assert.equal(validation.riskTier, 't1')
    assert.ok(parsed.content.instructions.join('\n').includes('run_index'))
    assert.ok(parsed.content.instructions.join('\n').includes('run_stats'))
    assert.ok(parsed.content.instructions.join('\n').includes('run_trace'))
    assert.ok(parsed.content.instructions.join('\n').includes('EFF-12'))
  })

  await test('board-promóció: betöltött futas-elemzes + task hint → promóció', () => {
    assert.equal(
      shouldPromoteSkillRunToTask({
        runtimeHints: { preferredMode: 'task' },
        loadedSkillNames: [RUN_ANALYSIS_SKILL_NAME],
      }),
      true,
    )
    const message = buildSkillTaskPromotionMessage({
      skillNames: [RUN_ANALYSIS_SKILL_NAME],
      ticketTitle: `${RUN_ANALYSIS_SKILL_NAME}: miért állt le a ticket?`,
    })
    assert.ok(message.includes('boardra'))
  })

  await test('modelConfig: task módban ≥150 eszközhívás keret', () => {
    const merged = mergeRunAnalystLoopGuardModelConfig(RUN_ANALYST_ROLE_TEMPLATE.modelConfig)
    assert.equal(merged.maxToolCalls, RUN_ANALYST_LOOP_GUARD_OVERRIDES.maxToolCalls)
    assert.equal(merged.maxToolWallClockMs, RUN_ANALYST_LOOP_GUARD_OVERRIDES.maxToolWallClockMs)
    const limits = resolveLoopGuardLimits(merged, 40, 'task')
    assert.ok(
      limits.maxToolCalls >= 150,
      `maxToolCalls=${limits.maxToolCalls}, kell ≥150`,
    )
    assert.ok(limits.maxToolCalls > 120, 'task alap (120) felett kell emelni')
  })

  await test('mergeRunAnalystLoopGuardModelConfig: magasabb admin érték megmarad', () => {
    const merged = mergeRunAnalystLoopGuardModelConfig({
      provider: 'chatgpt-oauth',
      model: 'x',
      maxToolCalls: 400,
      maxToolWallClockMs: 3_600_000,
    })
    assert.equal(merged.maxToolCalls, 400)
    assert.equal(merged.maxToolWallClockMs, 3_600_000)
  })

  if (failures > 0) {
    console.error(`\n${failures} run-analyst-skill teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden run-analyst-skill teszt zöld.')
}

main()
