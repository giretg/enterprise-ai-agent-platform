/**
 * Determinisztikus unit-teszt a Fázis 2 Playbook RUNTIME-MAGJÁHOZ (Feature-spec —
 * Playbook §7.2, §7.3). Futtatás: npm run test:playbook-v2-runtime
 *
 * DB és LLM NÉLKÜL, a pin-elt `compiled_spec` ellen igazolja:
 *   - §7.2 ticket transition enforcement (engedélyezett/tiltott átmenet, actor-típus,
 *     output contract) — P5 mag;
 *   - §2.5 / §13.1 gate-bypass: agent NEM léphet át blocking emberi kaput — P6 mag
 *     (`GATE_BYPASS_DENIED`, gateBypassDenied flag);
 *   - jogosult emberi approver átmehet (P7), rossz role / hiányzó bizonyíték DENY (P8);
 *   - §7.3 process-advance routing: feltételes ág, default fallback, gate-await, terminál.
 */
import assert from 'node:assert/strict'
import { parsePlaybookSpecV2 } from '../src/lib/playbook-v2/spec'
import { PlaybookCompiler } from '../src/domain/playbook/playbook-compiler'
import {
  evaluateTicketTransition,
  evaluateAdvance,
  evaluateCondition,
} from '../src/lib/playbook-v2/runtime'

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

/** A §5.1 minimális, valid példa — agent extract → human approval, L2 blocking gate. */
function validSpec() {
  return {
    schemaVersion: '1.0',
    key: 'invoice-processing',
    name: 'Bejovo szamla feldolgozas',
    processType: 'invoice_processing',
    entryStepId: 'extract_invoice',
    roles: [
      { key: 'invoice_extractor', type: 'agent_role', requiredCapabilities: ['tool:file_read'] },
      { key: 'accounting_approver', type: 'human_role', requiredPermissions: ['ticket:approve'] },
    ],
    steps: [
      {
        id: 'extract_invoice',
        name: 'Szamlaadatok kinyerese',
        ticketType: 'invoice_extract',
        assignedRole: 'invoice_extractor',
        allowedStates: ['ready', 'in_progress', 'done', 'failed'],
        timeoutMinutes: 60,
        onComplete: [
          { condition: { field: 'confidence', op: '>=', value: 0.85 }, nextStepId: 'approval' },
          { condition: 'default', gateId: 'low_confidence_review' },
        ],
      },
      {
        id: 'approval',
        name: 'Konyvelesi jovahagyas',
        ticketType: 'human_approval',
        assignedRole: 'accounting_approver',
        requiredGateIds: ['approve_accounting_posting'],
        allowedStates: ['ready', 'awaiting_human', 'approved', 'done'],
        timeoutMinutes: 1440,
      },
    ],
    gates: [
      {
        id: 'low_confidence_review',
        type: 'manual_review',
        requiredActorRole: 'accounting_approver',
        blocking: true,
      },
      {
        id: 'approve_accounting_posting',
        type: 'human_approval',
        requiredActorRole: 'accounting_approver',
        blocking: true,
        criticality: 'L2',
        evidenceRequired: true,
      },
    ],
    transitions: [{ fromStepId: 'extract_invoice', toStepId: 'approval', trigger: 'step.completed' }],
    outputContract: { requiredFields: ['invoiceNumber', 'amount', 'decision'] },
  }
}

const compiler = new PlaybookCompiler()
const compiled = compiler.compile(parsePlaybookSpecV2(validSpec()), { playbookVersionId: 'v3' })

console.log('=== §7.2 ticket transition enforcement ===')

check('P5-mag: agent ready→in_progress engedélyezett', () => {
  const d = evaluateTicketTransition(compiled, {
    stepId: 'extract_invoice',
    fromState: 'ready',
    toState: 'in_progress',
    actor: { type: 'agent' },
  })
  assert.equal(d.allowed, true)
})

check('nem létező átmenet → TRANSITION_NOT_ALLOWED', () => {
  const d = evaluateTicketTransition(compiled, {
    stepId: 'extract_invoice',
    fromState: 'ready',
    toState: 'done', // nem szomszédos a láncban
    actor: { type: 'agent' },
  })
  assert.equal(d.allowed, false)
  assert.equal(d.allowed === false && d.denyCode, 'TRANSITION_NOT_ALLOWED')
})

check('ismeretlen step → STEP_NOT_FOUND', () => {
  const d = evaluateTicketTransition(compiled, {
    stepId: 'nincs_ilyen',
    fromState: 'ready',
    toState: 'in_progress',
    actor: { type: 'agent' },
  })
  assert.equal(d.allowed === false && d.denyCode, 'STEP_NOT_FOUND')
})

check('human stepre user actor kell — agent ready→awaiting_human DENY', () => {
  const d = evaluateTicketTransition(compiled, {
    stepId: 'approval',
    fromState: 'ready',
    toState: 'awaiting_human',
    actor: { type: 'agent' },
  })
  assert.equal(d.allowed === false && d.denyCode, 'ACTOR_NOT_ALLOWED')
})

check('output contract: hiányzó mező a done-átmenetnél → OUTPUT_CONTRACT_VIOLATION', () => {
  const d = evaluateTicketTransition(compiled, {
    stepId: 'extract_invoice',
    fromState: 'in_progress',
    toState: 'done',
    actor: { type: 'agent' },
    outputPayload: { invoiceNumber: 'INV-1' }, // amount, decision hiányzik
  })
  assert.equal(d.allowed === false && d.denyCode, 'OUTPUT_CONTRACT_VIOLATION')
  assert.deepEqual(d.allowed === false && d.missingFields, ['amount', 'decision'])
})

check('output contract teljesül → done engedélyezett', () => {
  const d = evaluateTicketTransition(compiled, {
    stepId: 'extract_invoice',
    fromState: 'in_progress',
    toState: 'done',
    actor: { type: 'agent' },
    outputPayload: { invoiceNumber: 'INV-1', amount: 100, decision: 'ok' },
  })
  assert.equal(d.allowed, true)
})

check('hibapolicy §7 — failed outcome a done-átmenetnél NEM OUTPUT_CONTRACT_VIOLATION (a hiba-útnak el kell érnie az evaluateAdvance-ot)', () => {
  const d = evaluateTicketTransition(compiled, {
    stepId: 'extract_invoice',
    fromState: 'in_progress',
    toState: 'done',
    actor: { type: 'agent' },
    outputPayload: { outcome: { status: 'failed', reason: 'tool_loop_exhausted' } },
  })
  assert.equal(d.allowed, true)
})

check('hibapolicy §7 — blocked outcome a done-átmenetnél szintén átmegy az output-contracton', () => {
  const d = evaluateTicketTransition(compiled, {
    stepId: 'extract_invoice',
    fromState: 'in_progress',
    toState: 'done',
    actor: { type: 'agent' },
    outputPayload: { outcome: { status: 'blocked', reason: 'missing_kb_source' } },
  })
  assert.equal(d.allowed, true)
})

console.log('=== §13.1 / P6 gate-bypass enforcement ===')

check('P6: agent awaiting_human→approved megkerülés → GATE_BYPASS_DENIED', () => {
  const d = evaluateTicketTransition(compiled, {
    stepId: 'approval',
    fromState: 'awaiting_human',
    toState: 'approved',
    actor: { type: 'agent' },
    outputPayload: { approval_not_needed: true },
  })
  assert.equal(d.allowed, false)
  assert.equal(d.allowed === false && d.denyCode, 'GATE_BYPASS_DENIED')
  assert.equal(d.allowed === false && d.gateBypassDenied, true)
})

check('P6: system actor sem kerülheti meg a kaput', () => {
  const d = evaluateTicketTransition(compiled, {
    stepId: 'approval',
    fromState: 'awaiting_human',
    toState: 'approved',
    actor: { type: 'system' },
  })
  assert.equal(d.allowed === false && d.denyCode, 'GATE_BYPASS_DENIED')
})

check('P8: rossz role-ú human approver → GATE_ACTOR_ROLE', () => {
  const d = evaluateTicketTransition(compiled, {
    stepId: 'approval',
    fromState: 'awaiting_human',
    toState: 'approved',
    actor: { type: 'user', roles: ['viewer'] },
    approvalEvidence: { signoff: 'x' },
  })
  assert.equal(d.allowed === false && d.denyCode, 'GATE_ACTOR_ROLE')
})

check('evidenceRequired: hiányzó bizonyíték → GATE_EVIDENCE_REQUIRED', () => {
  const d = evaluateTicketTransition(compiled, {
    stepId: 'approval',
    fromState: 'awaiting_human',
    toState: 'approved',
    actor: { type: 'user', roles: ['accounting_approver'] },
  })
  assert.equal(d.allowed === false && d.denyCode, 'GATE_EVIDENCE_REQUIRED')
})

check('P7: jogosult approver + bizonyíték → engedélyezett', () => {
  const d = evaluateTicketTransition(compiled, {
    stepId: 'approval',
    fromState: 'awaiting_human',
    toState: 'approved',
    actor: { type: 'user', roles: ['accounting_approver'] },
    approvalEvidence: { signoff: 'hash:abc' },
  })
  assert.equal(d.allowed, true)
})

console.log('=== §7.3 process advance routing ===')

check('magas confidence → következő step (approval)', () => {
  const d = evaluateAdvance(compiled, 'extract_invoice', { confidence: 0.92 })
  assert.equal(d.kind, 'next_step')
  assert.equal(d.kind === 'next_step' && d.toStepId, 'approval')
})

check('alacsony confidence → default ág gate-await (low_confidence_review)', () => {
  const d = evaluateAdvance(compiled, 'extract_invoice', { confidence: 0.4 })
  assert.equal(d.kind, 'await_gate')
  assert.equal(d.kind === 'await_gate' && d.gateId, 'low_confidence_review')
})

check('terminál step (approval) → process complete', () => {
  const d = evaluateAdvance(compiled, 'approval', {})
  assert.equal(d.kind, 'complete')
})

console.log('=== feltétel-kiértékelés ===')

check('default mindig igaz', () => {
  assert.equal(evaluateCondition('default', {}), true)
})

check('numerikus >= és típuseltérés', () => {
  assert.equal(evaluateCondition({ field: 'x', op: '>=', value: 5 }, { x: 5 }), true)
  assert.equal(evaluateCondition({ field: 'x', op: '>=', value: 5 }, { x: 4 }), false)
  // string vs number → nem teljesül (nem dob)
  assert.equal(evaluateCondition({ field: 'x', op: '>=', value: 5 }, { x: 'sok' }), false)
})

check('== és != összehasonlítás, pont-elérési útvonal', () => {
  assert.equal(evaluateCondition({ field: 'a.b', op: '==', value: 'ok' }, { a: { b: 'ok' } }), true)
  assert.equal(evaluateCondition({ field: 'status', op: '!=', value: 'done' }, { status: 'open' }), true)
})

console.log('')
if (failures > 0) {
  console.error(`❌ ${failures} teszt elbukott`)
  process.exit(1)
}
console.log('✅ Minden Playbook v2 runtime teszt zöld')
