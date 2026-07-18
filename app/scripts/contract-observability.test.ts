/**
 * Contract megfigyelhetőség (#46 / #33) — tiszta aggregátor tesztek.
 *
 * Futtatás: npm run test:contract-observability
 *
 * Varrat: summarizeContractObservability — audit-szerű rekordok → arányok / költség / okok.
 * Nem teszteljük: DB-lekérdezést, UI-renderelést.
 */
import assert from 'node:assert/strict'
import {
  classifyContractOutcome,
  summarizeContractObservability,
  evaluationFromAuditMetadata,
  humanGateFromBlockedMetadata,
  buildContractEvaluateAuditMetadata,
  type ContractEvaluationRecord,
  type ContractHumanGateRecord,
} from '../src/domain/contract-runtime'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  OK  ${name}`)
  } catch (e: unknown) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

function main() {
  console.log('=== Contract Observability (#46) ===\n')

  check('CO-1a: üres bemenet → nullás arányok, nincs ok-eloszlás', () => {
    const summary = summarizeContractObservability({ evaluations: [], humanGates: [] })
    assert.equal(summary.totalEvaluations, 0)
    assert.equal(summary.firstPassRate, null)
    assert.equal(summary.repairRate, null)
    assert.equal(summary.repairCostEstimate, 0)
    assert.deepEqual(summary.humanGateReasons, [])
    assert.deepEqual(summary.failingSteps, [])
    assert.deepEqual(summary.stepReasonBreakdown, [])
  })

  check('CO-1b: elsőre sikeres / javított / bukott arányok', () => {
    const evaluations: ContractEvaluationRecord[] = [
      { outcome: 'first_pass', repairAttempts: 0, repairCostEstimate: 0 },
      { outcome: 'first_pass', repairAttempts: 0, repairCostEstimate: 0 },
      { outcome: 'repaired', repairAttempts: 1, repairCostEstimate: 0.012 },
      { outcome: 'failed', repairAttempts: 1, repairCostEstimate: 0.008 },
    ]
    const summary = summarizeContractObservability({ evaluations, humanGates: [] })
    assert.equal(summary.totalEvaluations, 4)
    assert.equal(summary.firstPassCount, 2)
    assert.equal(summary.repairedCount, 1)
    assert.equal(summary.failedCount, 1)
    assert.equal(summary.firstPassRate, 0.5)
    assert.equal(summary.repairRate, 0.25)
    assert.equal(summary.repairCostEstimate, 0.02)
  })

  check('CO-1c: emberi kapu ok-eloszlás lépésenként + lépés×ok', () => {
    const humanGates: ContractHumanGateRecord[] = [
      {
        stepId: 'extract-quote',
        reasonCode: 'output_contract_unmet',
        reasonLabel: 'Hiányzó vagy hibás kimeneti mező',
      },
      {
        stepId: 'extract-quote',
        reasonCode: 'output_contract_unmet',
        reasonLabel: 'Hiányzó vagy hibás kimeneti mező',
      },
      {
        stepId: 'decide',
        reasonCode: 'output_contract_unmet',
        reasonLabel: 'Hiányzó vagy hibás kimeneti mező',
      },
    ]
    const summary = summarizeContractObservability({ evaluations: [], humanGates })
    assert.equal(summary.humanGateReasons.length, 1)
    assert.equal(summary.humanGateReasons[0]?.count, 3)
    assert.equal(summary.failingSteps[0]?.stepId, 'extract-quote')
    assert.equal(summary.failingSteps[0]?.count, 2)
    assert.equal(summary.stepReasonBreakdown.length, 2)
    assert.ok(
      summary.stepReasonBreakdown.some(
        (r) => r.stepId === 'extract-quote' && r.reasonCode === 'output_contract_unmet' && r.count === 2,
      ),
    )
  })

  check('CO-1d: classifyContractOutcome — first_pass / repaired / failed', () => {
    assert.equal(classifyContractOutcome({ ok: true, repairAttempts: 0 }), 'first_pass')
    assert.equal(classifyContractOutcome({ ok: true, repairAttempts: 1 }), 'repaired')
    assert.equal(classifyContractOutcome({ ok: false, repairAttempts: 2 }), 'failed')
  })

  check('CO-1e: audit metadata round-trip; nem-contract blocked kiszűrve', () => {
    const meta = buildContractEvaluateAuditMetadata({
      outcome: 'repaired',
      repairAttempts: 1,
      repairCostEstimate: 0.0123456,
      stepId: 'extract',
      errorCodes: [],
    })
    const ev = evaluationFromAuditMetadata(meta)
    assert.ok(ev)
    assert.equal(ev!.outcome, 'repaired')
    assert.equal(ev!.repairAttempts, 1)
    assert.equal(ev!.repairCostEstimate, 0.012346)
    assert.equal(ev!.stepId, 'extract')

    const gate = humanGateFromBlockedMetadata({
      completed_step_id: 'decide',
      outcome_reason: 'output_contract_unmet',
    })
    assert.ok(gate)
    assert.equal(gate!.stepId, 'decide')
    assert.equal(gate!.reasonCode, 'output_contract_unmet')

    const ignored = humanGateFromBlockedMetadata({
      completed_step_id: 'notify',
      outcome_reason: 'tool_denied',
    })
    assert.equal(ignored, null)
  })

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failure(s)`)
  process.exit(failures > 0 ? 1 : 0)
}

main()
