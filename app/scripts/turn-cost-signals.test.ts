/**
 * issue #180 WP-4 — a forduló-költség jelek és riasztási küszöbök tesztje.
 * Futtatás: npm run test:turn-cost
 *
 * A mérce a MÉRT eset (2026-07-29, `/tulajdoni-lap-egyeztetes`, conversation
 * `3aae080f`): 149 eszközhívásból 132 volt újraolvasás (89%), és a futás 40 körön
 * át egy helyben járt. Az elfogadási feltétel kétirányú: ez az eset riasztást vált
 * ki, egy normál, 3–5 eszközhívásos forduló viszont NEM.
 */
import assert from 'node:assert/strict'
import {
  TURN_COST_THRESHOLDS,
  describeTurnCostAlert,
  evaluateTurnCostSignals,
  resolveTurnCostThresholds,
} from '../src/domain/agent/turn-cost-signals'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✅ ${name}`))
    .catch((e) => {
      failures++
      console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

async function main() {
  console.log('=== forduló-költség jelek (issue #180 WP-4) ===')

  await check('a mért eset (132/149 újraolvasás) riasztást vált ki', () => {
    const signals = evaluateTurnCostSignals({
      toolCallsIssued: 149,
      sourceRereadCalls: 132,
      sourceRereadChars: 2_000_000,
      compactionSteps: 3,
      missingToolResults: false,
    })
    assert.equal(signals.alert, true)
    assert.ok(signals.reasons.includes('source_reread_ratio'))
    assert.equal(Number(signals.rereadRatio.toFixed(2)), 0.89)
    assert.equal(signals.estimatedRereadTokens, 500_000)
  })

  await check('normál, 3–5 eszközhívásos forduló nem riaszt', () => {
    for (const issued of [3, 4, 5]) {
      const signals = evaluateTurnCostSignals({
        toolCallsIssued: issued,
        sourceRereadCalls: 1,
        sourceRereadChars: 4_000,
        compactionSteps: 1,
        missingToolResults: false,
      })
      assert.equal(signals.alert, false, `${issued} hívásos kör nem riaszthat`)
    }
  })

  await check('kis mintán az arány nem riaszt (egy jogos ismétlés is 50% fölé vinné)', () => {
    const signals = evaluateTurnCostSignals({
      toolCallsIssued: 2,
      sourceRereadCalls: 2,
      sourceRereadChars: 10_000,
      compactionSteps: 0,
      missingToolResults: false,
    })
    assert.equal(signals.rereadRatio, 1)
    assert.equal(signals.alert, false)
  })

  await check('a küszöb fölötti arány elég mintán riaszt, a küszöbön állva nem', () => {
    const base = {
      toolCallsIssued: TURN_COST_THRESHOLDS.minToolCallsForRatio,
      sourceRereadChars: 100_000,
      compactionSteps: 0,
      missingToolResults: false,
    }
    const half = evaluateTurnCostSignals({
      ...base,
      sourceRereadCalls: TURN_COST_THRESHOLDS.minToolCallsForRatio / 2,
    })
    assert.equal(half.rereadRatio, 0.5)
    assert.equal(half.alert, false, 'pontosan a küszöbön még nem riasztunk')

    const over = evaluateTurnCostSignals({
      ...base,
      sourceRereadCalls: TURN_COST_THRESHOLDS.minToolCallsForRatio / 2 + 1,
    })
    assert.equal(over.alert, true)
  })

  await check('sok tömörítési lépés önmagában is riaszt (körforgás-gyanú)', () => {
    const signals = evaluateTurnCostSignals({
      toolCallsIssued: 2,
      sourceRereadCalls: 0,
      sourceRereadChars: 0,
      compactionSteps: TURN_COST_THRESHOLDS.compactionSteps + 1,
      missingToolResults: false,
    })
    assert.deepEqual(signals.reasons, ['compaction_steps'])
  })

  await check('üres kör-mérleg (kiadott hívás, nulla eredmény) riaszt', () => {
    const signals = evaluateTurnCostSignals({
      toolCallsIssued: 3,
      sourceRereadCalls: 0,
      sourceRereadChars: 0,
      compactionSteps: 0,
      missingToolResults: true,
    })
    assert.deepEqual(signals.reasons, ['missing_tool_results'])
    // Tool-hívás nélküli kör nem hibáztatható: ott nincs mit mérlegelni.
    const idle = evaluateTurnCostSignals({
      toolCallsIssued: 0,
      sourceRereadCalls: 0,
      sourceRereadChars: 0,
      compactionSteps: 0,
      missingToolResults: true,
    })
    assert.equal(idle.alert, false)
  })

  await check('minden riasztási ok kap hétköznapi nyelvű indoklást', () => {
    const signals = evaluateTurnCostSignals({
      toolCallsIssued: 20,
      sourceRereadCalls: 19,
      sourceRereadChars: 400_000,
      compactionSteps: 50,
      missingToolResults: true,
    })
    assert.deepEqual(signals.reasons, [
      'source_reread_ratio',
      'compaction_steps',
      'missing_tool_results',
    ])
    for (const reason of signals.reasons) {
      assert.ok(describeTurnCostAlert(reason).length > 20, `hiányzó indoklás: ${reason}`)
    }
  })

  await check('env-felülbírálás hangolhat, de nem tudja kikapcsolni a riasztást', () => {
    const tuned = resolveTurnCostThresholds({
      AGENT_TURN_REREAD_RATIO_ALERT: '0.3',
      AGENT_TURN_COMPACTION_STEPS_ALERT: '5',
      AGENT_TURN_MIN_TOOL_CALLS_FOR_RATIO: '4',
    } as unknown as NodeJS.ProcessEnv)
    assert.equal(tuned.rereadRatio, 0.3)
    assert.equal(tuned.compactionSteps, 5)
    assert.equal(tuned.minToolCallsForRatio, 4)

    // Tartományon kívüli / szemét érték → alapérték marad (a védelem nem némítható).
    const junk = resolveTurnCostThresholds({
      AGENT_TURN_REREAD_RATIO_ALERT: '5',
      AGENT_TURN_COMPACTION_STEPS_ALERT: 'nem-szam',
      AGENT_TURN_MIN_TOOL_CALLS_FOR_RATIO: '0',
    } as unknown as NodeJS.ProcessEnv)
    assert.deepEqual(junk, TURN_COST_THRESHOLDS)
  })

  if (failures > 0) {
    console.log(`\n${failures} teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld.')
}

void main()
