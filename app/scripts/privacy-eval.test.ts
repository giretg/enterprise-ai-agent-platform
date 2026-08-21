/**
 * APG-23 — Privacy-eval: hét metrika + piros vonalak.
 *
 * Futtatás: npm run test:privacy-eval
 *
 * DoD: a szett futtatható, a hét metrika riportolt; a válaszminőség-mérésnek van
 * pszeudonimizált és nyers ága.
 */
import assert from 'node:assert/strict'

import {
  formatPrivacyEvalReport,
  PRIVACY_EVAL_TARGETS,
  toEvalRunDetails,
} from '../src/lib/privacy-eval'
import type { PrivacyRedLineCheck, PrivacyEvalTrace } from '../src/lib/privacy-eval-red-lines'
import {
  runPrivacyRedLineChecks,
  RLP1_NO_RAW_IN_MODEL_TEXT,
  RLP2_MACHINE_DATA_RAW,
  RLP3_NO_RESOLVE_IN_URL,
  RLP4_NO_STREAM_FRAGMENT,
  RLP5_UNKNOWN_SURROGATE_AUDIT,
} from '../src/lib/privacy-eval-red-lines'
import {
  buildPrivacyRedLineTraces,
  runPrivacyEval,
} from '../src/lib/privacy-eval-runner'
import { QUALITY_EVAL_CASES } from '../src/lib/privacy-eval-fixtures'

let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function verdictOf(checkDef: PrivacyRedLineCheck, trace: PrivacyEvalTrace) {
  return checkDef.check(trace)
}

async function main() {
  console.log('privacy-eval (APG-23) — metrikák és piros vonalak\n')

  // ── Hét metrika ───────────────────────────────────────────────────────────

  const report = await runPrivacyEval()
  console.log(formatPrivacyEvalReport(report))
  console.log('')

  await check('mind a hét metrika riportálva', () => {
    assert.equal(report.metrics.length, 7)
    const ids = report.metrics.map((m) => m.id)
    for (const id of Object.keys(PRIVACY_EVAL_TARGETS)) {
      assert.ok(ids.includes(id as (typeof ids)[number]), `hiányzik: ${id}`)
    }
  })

  await check('mind a hét metrika eléri a v1 célértéket', () => {
    const failed = report.metrics.filter((m) => !m.passed)
    if (failed.length > 0) {
      throw new Error(
        failed.map((m) => `${m.id}: ${m.value} (cél: ${PRIVACY_EVAL_TARGETS[m.id].threshold})`).join('; '),
      )
    }
  })

  await check('EvalRun.details kompatibilis kimenet', () => {
    const details = toEvalRunDetails(report)
    assert.equal(details.passed, true)
    assert.equal(details.details.privacyMetrics.length, 7)
    assert.equal(details.details.blocking, false)
  })

  await check('válaszminőség-mérés: minden esetnek van nyers és pszeudo ága', () => {
    for (const c of QUALITY_EVAL_CASES) {
      assert.ok(c.rawContext.length > 0, `${c.id}: hiányzik rawContext`)
      assert.ok(c.pseudoContext.length > 0, `${c.id}: hiányzik pseudoContext`)
      assert.ok(c.rawResponse.length > 0, `${c.id}: hiányzik rawResponse`)
      assert.ok(c.pseudoResponse.length > 0, `${c.id}: hiányzik pseudoResponse`)
      assert.notEqual(c.rawContext, c.pseudoContext, `${c.id}: a két ág nem különbözik`)
    }
  })

  // ── Piros vonalak ─────────────────────────────────────────────────────────

  console.log('\n--- privacy piros vonalak ---\n')

  const traces = await buildPrivacyRedLineTraces()
  const rlp12 = traces.find((t) => t.probeId === 'rlp-1-2')!.trace

  await check('RL-P1 POZITÍV: ENFORCE CRM — nincs nyers érték a modelTextben', () => {
    const v = verdictOf(RLP1_NO_RAW_IN_MODEL_TEXT, rlp12)
    assert.equal(v.status, 'pass')
  })

  await check('RL-P1 NEGATÍV: nyers érték a modelTextben → BUKIK', () => {
    const v = verdictOf(RLP1_NO_RAW_IN_MODEL_TEXT, {
      ...rlp12,
      modelText: 'SPAR Magyarország Kereskedelmi Kft.',
    })
    assert.equal(v.status, 'fail')
  })

  await check('RL-P2 POZITÍV: machineData bitre nyers', () => {
    const v = verdictOf(RLP2_MACHINE_DATA_RAW, rlp12)
    assert.equal(v.status, 'pass')
  })

  await check('RL-P2 NEGATÍV: machineData megváltozott → BUKIK', () => {
    const v = verdictOf(RLP2_MACHINE_DATA_RAW, {
      ...rlp12,
      machineData: { mutated: true },
    })
    assert.equal(v.status, 'fail')
  })

  await check('RL-P3 POZITÍV: URL-ben az álnév feloldatlan', () => {
    const trace = traces.find((t) => t.probeId === 'rlp-3')!.trace
    const v = verdictOf(RLP3_NO_RESOLVE_IN_URL, trace)
    assert.equal(v.status, 'pass')
  })

  await check('RL-P3 NEGATÍV: nyers érték URL-ben → BUKIK', () => {
    const trace = traces.find((t) => t.probeId === 'rlp-3')!.trace
    const v = verdictOf(RLP3_NO_RESOLVE_IN_URL, {
      ...trace,
      displayText: 'https://evil.example/?c=SPAR',
      rawValues: ['SPAR'],
    })
    assert.equal(v.status, 'fail')
  })

  await check('RL-P4 POZITÍV: streamelt kimenet töredék nélkül', () => {
    const trace = traces.find((t) => t.probeId === 'rlp-4')!.trace
    const v = verdictOf(RLP4_NO_STREAM_FRAGMENT, trace)
    assert.equal(v.status, 'pass')
  })

  await check('RL-P4 NEGATÍV: töredék álnév a streamben → BUKIK', () => {
    const trace = traces.find((t) => t.probeId === 'rlp-4')!.trace
    const v = verdictOf(RLP4_NO_STREAM_FRAGMENT, {
      ...trace,
      streamedText: 'A [[COMP',
    })
    assert.equal(v.status, 'fail')
  })

  await check('RL-P5 POZITÍV: ismeretlen álnév auditálva', () => {
    const trace = traces.find((t) => t.probeId === 'rlp-5')!.trace
    const v = verdictOf(RLP5_UNKNOWN_SURROGATE_AUDIT, trace)
    assert.equal(v.status, 'pass')
  })

  await check('RL-P5 NEGATÍV: ismeretlen álnév audit nélkül → BUKIK', () => {
    const trace = traces.find((t) => t.probeId === 'rlp-5')!.trace
    const v = verdictOf(RLP5_UNKNOWN_SURROGATE_AUDIT, {
      ...trace,
      auditActions: [],
    })
    assert.equal(v.status, 'fail')
  })

  await check('integrációs trace-ek: mind az öt piros vonal átmegy', () => {
    for (const { probeId, trace } of traces) {
      const verdicts = runPrivacyRedLineChecks(trace)
      const failed = verdicts.filter((v) => v.status === 'fail')
      if (failed.length > 0) {
        throw new Error(`${probeId}: ${failed.map((f) => f.redLine).join(', ')}`)
      }
    }
  })

  if (failures > 0) {
    console.error(`\n${failures} teszt elbukott`)
    process.exit(1)
  }
  console.log('\nOK')
}

void main()
