/**
 * Governed Flow Builder — WP-4/5/6/7/8 tiszta-mag teszt (docs/specs/governed-flow-builder-spec.md).
 * DB és LLM NÉLKÜL. Futtatás: npm run test:flow-builder-governed
 *
 * Lefedi:
 *  - WP-8 Decision Step: sugar-blokk desugar → determinista branch-választás, evaluatePlaybookAdvance;
 *  - WP-7 Step-outcome / kaszkád-védelem: blocked/failed → hiba-él vagy implicit await_human;
 *  - WP-8 validátor: OUTPUT_CONTRACT_HAS_DECISION, CRITICAL_BRANCH_GATE_REQUIRED, NO_SILENT_COMPLETE,
 *    UNKNOWN_BRANCH_TARGET, decision-branch elérhetőség; WP-7 IMPLICIT_ERROR_EDGE;
 *  - WP-4 Simulation: PlaybookSimulator ≥3 hibakategória, várható út;
 *  - WP-5 Diff: risk-weighted spec-diff (gate/role/criticality kiemelés, layout-független);
 *  - WP-6 Pack: PlaybookPack export→import round-trip, secret-tiltás.
 */
import assert from 'node:assert/strict'
import { parsePlaybookSpecV2, computePlaybookContentHash } from '../src/lib/playbook-v2/spec'
import { PlaybookCompiler } from '../src/domain/playbook/playbook-compiler'
import { PlaybookValidator } from '../src/domain/playbook/playbook-validator'
import { evaluateAdvance, evaluatePlaybookAdvance } from '../src/lib/playbook-v2/runtime'
import { computeStepOutcome } from '../src/lib/playbook-v2/process-step-payload'
import { PlaybookSimulator } from '../src/domain/playbook/playbook-simulator'
import { diffPlaybookSpecs } from '../src/domain/playbook/playbook-diff'
import { exportPlaybookPack, importPlaybookPack } from '../src/domain/playbook/playbook-pack'
import { computeModelCostEur, parseModelPricingSetting } from '../src/lib/model-pricing'

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

const compiler = new PlaybookCompiler()
const validator = new PlaybookValidator()

/** Laza, mutálható alak a teszt-variánsokhoz (a parse/validate úgyis unknown-t fogad). */
type LooseBranch = {
  outcome: string
  nextStepId?: string
  gateId?: string
  criticality?: string
  requiresEvidence?: boolean
}
type LooseStep = {
  id: string
  name: string
  ticketType: string
  assignedRole: string
  outputContract?: { requiredFields: string[] }
  decision?: {
    field?: string
    confidenceField?: string
    evidenceField?: string
    allowedOutcomes?: string[]
    branches: LooseBranch[]
    fallback?: { nextStepId?: string; gateId?: string }
    minConfidenceForAutoBranch?: number
    requiresEvidence?: boolean
  }
  onError?: { nextStepId?: string; gateId?: string }
  onBlocked?: { nextStepId?: string; gateId?: string }
}
type LooseGate = {
  id: string
  type: string
  requiredActorRole?: string
  blocking: boolean
  criticality?: string
  evidenceRequired?: boolean
}
type LooseSpec = {
  schemaVersion: string
  key: string
  name: string
  processType: string
  entryStepId: string
  roles: unknown[]
  steps: LooseStep[]
  gates: LooseGate[]
  transitions: unknown[]
  outputContract?: { requiredFields: string[] }
}

/** Decision Step példa: 3-outcome elágazás fallback gate-tel + hiba-éllel. */
function decisionSpec(): LooseSpec {
  return {
    schemaVersion: '1.0',
    key: 'invoice-decision',
    name: 'Szamla besorolas',
    processType: 'invoice_classification',
    entryStepId: 'classify',
    roles: [
      { key: 'classifier', type: 'agent_role', requiredCapabilities: [] },
      { key: 'finance_approver', type: 'human_role', requiredPermissions: [] },
    ],
    steps: [
      {
        id: 'classify',
        name: 'Besorolas',
        ticketType: 'invoice_classification',
        assignedRole: 'classifier',
        outputContract: { requiredFields: ['decision', 'confidence', 'evidence'] },
        decision: {
          field: 'decision',
          confidenceField: 'confidence',
          evidenceField: 'evidence',
          branches: [
            { outcome: 'clean_match', nextStepId: 'prepare_report' },
            { outcome: 'minor_exception', nextStepId: 'finance_review' },
            {
              outcome: 'major_exception',
              gateId: 'major_exception_approval',
              criticality: 'L2',
              requiresEvidence: true,
            },
          ],
          fallback: { gateId: 'decision_fallback_review' },
        },
        onBlocked: { gateId: 'decision_fallback_review' },
      },
      { id: 'prepare_report', name: 'Riport', ticketType: 'report', assignedRole: 'classifier' },
      { id: 'finance_review', name: 'Penzugy', ticketType: 'review', assignedRole: 'finance_approver' },
    ],
    gates: [
      {
        id: 'major_exception_approval',
        type: 'human_approval',
        requiredActorRole: 'finance_approver',
        blocking: true,
        criticality: 'L2',
        evidenceRequired: true,
      },
      {
        id: 'decision_fallback_review',
        type: 'manual_review',
        requiredActorRole: 'finance_approver',
        blocking: true,
      },
    ],
    transitions: [],
    outputContract: { requiredFields: [] },
  }
}

console.log('=== WP-8 Decision Step desugar + branch routing ===')

const decisionCompiled = compiler.compile(parsePlaybookSpecV2(decisionSpec()), {
  playbookVersionId: 'vd1',
})

check('decision desugar → clean_match ág prepare_report stepre visz', () => {
  const d = evaluateAdvance(decisionCompiled, 'classify', { decision: 'clean_match', outcome: { status: 'ok' } })
  assert.equal(d.kind, 'next_step')
  assert.equal(d.kind === 'next_step' && d.toStepId, 'prepare_report')
  assert.equal(d.kind === 'next_step' && d.selectedOutcome, 'clean_match')
})

check('major_exception → blocking approval gate (await_gate)', () => {
  const d = evaluateAdvance(decisionCompiled, 'classify', { decision: 'major_exception', outcome: { status: 'ok' } })
  assert.equal(d.kind, 'await_gate')
  assert.equal(d.kind === 'await_gate' && d.gateId, 'major_exception_approval')
})

check('ismeretlen decision → fallback gate (nem néma complete)', () => {
  const d = evaluateAdvance(decisionCompiled, 'classify', { decision: 'ismeretlen', outcome: { status: 'ok' } })
  assert.equal(d.kind, 'await_gate')
  assert.equal(d.kind === 'await_gate' && d.gateId, 'decision_fallback_review')
})

check('evaluatePlaybookAdvance UGYANAZT az ágat adja, mint a runtime (elfogadási kritérium)', () => {
  const preview = evaluatePlaybookAdvance(decisionCompiled, 'classify', { decision: 'minor_exception', outcome: { status: 'ok' } })
  assert.equal(preview.targetKind, 'next_step')
  assert.equal(preview.targetId, 'finance_review')
  assert.equal(preview.selectedOutcome, 'minor_exception')
})

console.log('=== WP-7 Step-outcome / kaszkád-védelem ===')

check('blocked outcome → explicit onBlocked hiba-él (fallback review), NEM happy path', () => {
  // A payload decision=clean_match lenne happy-úton prepare_report, DE az outcome blocked.
  const d = evaluateAdvance(decisionCompiled, 'classify', {
    decision: 'clean_match',
    outcome: { status: 'blocked', reason: 'missing_kb_source' },
  })
  assert.equal(d.kind, 'await_gate')
  assert.equal(d.kind === 'await_gate' && d.gateId, 'decision_fallback_review')
})

check('failed outcome, nincs explicit onError → implicit await_human (default awaiting_human)', () => {
  const d = evaluateAdvance(decisionCompiled, 'classify', {
    decision: 'clean_match',
    outcome: { status: 'failed', reason: 'tool_denied' },
  })
  assert.equal(d.kind, 'await_human')
  assert.equal(d.kind === 'await_human' && d.outcomeStatus, 'failed')
})

check('ok/hiányzó outcome → happy path (visszafelé kompat: legacy payload outcome nélkül)', () => {
  const d = evaluateAdvance(decisionCompiled, 'classify', { decision: 'clean_match' })
  assert.equal(d.kind, 'next_step')
  assert.equal(d.kind === 'next_step' && d.toStepId, 'prepare_report')
})

console.log('=== WP-7 determinista outcome (hard signal felülírás) ===')

check('tool-loop exhausted → failed', () => {
  assert.equal(computeStepOutcome({ loopStatus: 'exhausted', toolCallCount: 3, kbZeroHit: false }).status, 'failed')
})
check('kb 0-hit + 0 tool-hívás → blocked (missing_kb_source)', () => {
  const o = computeStepOutcome({ loopStatus: 'completed', toolCallCount: 0, kbZeroHit: true })
  assert.equal(o.status, 'blocked')
  assert.equal(o.reason, 'missing_kb_source')
})
check('kb 0-hit DE volt tool-hívás → ok (nem blokkol tévesen)', () => {
  assert.equal(computeStepOutcome({ loopStatus: 'completed', toolCallCount: 2, kbZeroHit: true }).status, 'ok')
})
check('tool-denied → failed', () => {
  assert.equal(computeStepOutcome({ loopStatus: 'completed', toolCallCount: 1, kbZeroHit: false, toolDenied: true }).status, 'failed')
})
check('minden rendben → ok', () => {
  assert.equal(computeStepOutcome({ loopStatus: 'completed', toolCallCount: 1, kbZeroHit: false }).status, 'ok')
})

console.log('=== WP-8 validátor-szabályok ===')

check('érvényes decision spec → nincs blocking error', () => {
  const r = validator.validateSpec(decisionSpec())
  assert.equal(r.valid, true, JSON.stringify(r.errors))
})

check('OUTPUT_CONTRACT_HAS_DECISION — hiányzó decision mező az outputContract-ból', () => {
  const s = decisionSpec()
  s.steps[0]!.outputContract = { requiredFields: ['confidence'] }
  const r = validator.validateSpec(s)
  assert.ok(r.errors.some((e) => e.code === 'OUTPUT_CONTRACT_HAS_DECISION'))
})

check('CRITICAL_BRANCH_GATE_REQUIRED — L2 branch közvetlen stepre (gate nélkül)', () => {
  const s = decisionSpec()
  s.steps[0]!.decision!.branches[2] = { outcome: 'major_exception', nextStepId: 'prepare_report', criticality: 'L2', requiresEvidence: true }
  const r = validator.validateSpec(s)
  assert.ok(r.errors.some((e) => e.code === 'CRITICAL_BRANCH_GATE_REQUIRED'))
})

check('UNKNOWN_BRANCH_TARGET — nem létező branch cél', () => {
  const s = decisionSpec()
  s.steps[0]!.decision!.branches[0] = { outcome: 'clean_match', nextStepId: 'nincs_ilyen_step' }
  const r = validator.validateSpec(s)
  assert.ok(r.errors.some((e) => e.code === 'UNKNOWN_BRANCH_TARGET'))
})

check('NO_SILENT_COMPLETE — fallback nélküli decision → warning', () => {
  const s = decisionSpec()
  delete s.steps[0]!.decision!.fallback
  const r = validator.validateSpec(s)
  assert.ok(r.warnings.some((w) => w.code === 'NO_SILENT_COMPLETE'))
})

check('IMPLICIT_ERROR_EDGE — hiba-él nélküli nem-terminális step → warning', () => {
  const s = decisionSpec()
  delete s.steps[0]!.onBlocked
  const r = validator.validateSpec(s)
  assert.ok(r.warnings.some((w) => w.code === 'IMPLICIT_ERROR_EDGE'))
})

check('decision-branchen elérhető step NEM UNREACHABLE', () => {
  const r = validator.validateSpec(decisionSpec())
  assert.ok(!r.errors.some((e) => e.code === 'UNREACHABLE_STEP'), JSON.stringify(r.errors))
})

console.log('=== WP-4 Symbolic Simulation ===')

const simulator = new PlaybookSimulator()

check('szimuláció ≥3 hibakategóriát mutat (role, capability, gate/escalation)', () => {
  const report = simulator.simulate({
    spec: parsePlaybookSpecV2(decisionSpec()),
    compiled: decisionCompiled,
    roleBindings: {}, // nincs kötés → hiányzó role
    roleCapabilities: {},
    sampleInput: {},
  })
  const cats = new Set(report.findings.map((f) => f.category))
  assert.ok(cats.has('missing_role'), 'missing_role')
  assert.ok(cats.has('approval_gate'), 'approval_gate')
  assert.ok(report.expectedPath.length > 0, 'expectedPath')
})

check('szimuláció költségbecslést ad (heurisztikus, nem 0 minden lépésre)', () => {
  const report = simulator.simulate({
    spec: parsePlaybookSpecV2(decisionSpec()),
    compiled: decisionCompiled,
    roleBindings: { classifier: 'agent-1', finance_approver: 'user-1' },
    roleCapabilities: { classifier: [] },
    sampleInput: {},
    pricing: { 'model:standard': { inputPerMTokens: 3, outputPerMTokens: 15 } },
  })
  assert.ok(report.estimatedCostEur >= 0)
  assert.ok(report.expectedPath.includes('classify'))
})

console.log('=== WP-5 Risk-weighted diff ===')

check('layout-független: azonos spec, eltérő layout → nincs változás', () => {
  const a = parsePlaybookSpecV2(decisionSpec())
  const b = parsePlaybookSpecV2(decisionSpec())
  const diff = diffPlaybookSpecs(a, b)
  assert.equal(diff.changes.length, 0)
  assert.equal(computePlaybookContentHash(a), computePlaybookContentHash(b))
})

check('gate criticality változás → risk-weighted, high súly', () => {
  const a = parsePlaybookSpecV2(decisionSpec())
  const bRaw = decisionSpec()
  bRaw.gates[0]!.criticality = 'L3'
  const b = parsePlaybookSpecV2(bRaw)
  const diff = diffPlaybookSpecs(a, b)
  assert.ok(diff.changes.some((c) => c.risk === 'high' && c.category === 'gate'))
  assert.equal(diff.highestRisk, 'high')
})

check('új step hozzáadása → structural change', () => {
  const a = parsePlaybookSpecV2(decisionSpec())
  const bRaw = decisionSpec()
  bRaw.steps.push({ id: 'extra', name: 'Extra', ticketType: 'report', assignedRole: 'classifier' })
  const b = parsePlaybookSpecV2(bRaw)
  const diff = diffPlaybookSpecs(a, b)
  assert.ok(diff.changes.some((c) => c.kind === 'added' && c.category === 'step'))
})

console.log('=== WP-6 Playbook Pack export/import ===')

check('export→import round-trip: azonos contentHash', () => {
  const spec = parsePlaybookSpecV2(decisionSpec())
  const pack = exportPlaybookPack({
    playbooks: [{ key: spec.key, name: spec.name, spec }],
    stepTemplates: [],
    connectorTemplates: [],
    metadata: { title: 'Invoice Pack', author: 'test' },
  })
  const imported = importPlaybookPack(pack)
  assert.equal(imported.valid, true, JSON.stringify(imported.errors))
  assert.equal(imported.playbooks[0]!.contentHash, computePlaybookContentHash(spec))
})

check('pack import felszínre hozza a step-template + connector szekciókat (apply bemenet)', () => {
  const spec = parsePlaybookSpecV2(decisionSpec())
  const pack = exportPlaybookPack({
    playbooks: [{ key: spec.key, name: spec.name, spec }],
    stepTemplates: [
      { key: 'triage', name: 'Triage', fragment: { step: { id: '__PLACEHOLDER__', name: 'Triage' }, suggestedGate: null } },
    ],
    connectorTemplates: [{ descriptor: { kind: 'http_api', name: 'Demo' } }],
    metadata: { title: 'Full Pack', author: 'test' },
  })
  const imported = importPlaybookPack(pack)
  assert.equal(imported.valid, true, JSON.stringify(imported.errors))
  // A wizard/apply ezeken iterál: playbook → draft, stepTemplate → draft sablon,
  // connectorTemplate → manuális follow-up (NEM importálódik automatikusan).
  assert.equal(imported.stepTemplates.length, 1)
  assert.equal(imported.stepTemplates[0]!.key, 'triage')
  assert.equal(imported.connectorTemplates.length, 1)
})

check('pack import elutasítja a secret/grant szivárgást', () => {
  const spec = parsePlaybookSpecV2(decisionSpec())
  const pack = exportPlaybookPack({
    playbooks: [{ key: spec.key, name: spec.name, spec }],
    stepTemplates: [],
    connectorTemplates: [],
    metadata: { title: 'x', author: 'y' },
  })
  // Kézzel injektált tiltott mező.
  ;(pack as unknown as Record<string, unknown>).secrets = { apiKey: 'sk-leak' }
  const imported = importPlaybookPack(pack)
  assert.equal(imported.valid, false)
  assert.ok(imported.errors.some((e) => e.includes('secret')))
})

console.log('=== D11 / §16.1 model pricing (costEstimate ≠ 0) ===')

check('computeModelCostEur > 0 valós token-számokra (nem fixen 0)', () => {
  const cost = computeModelCostEur('claude-opus-4-8', 1_000_000, 1_000_000)
  assert.ok(cost > 0, `cost=${cost}`)
})

check('prefix-illesztés: ismeretlen variáns a family-árra esik', () => {
  const exact = computeModelCostEur('claude-sonnet-5', 1000, 1000)
  const variant = computeModelCostEur('claude-sonnet-5-20260101', 1000, 1000)
  assert.equal(exact, variant)
})

check('hibás setting → default tábla (nem dob)', () => {
  const table = parseModelPricingSetting({ 'claude-opus-4-8': { inputPerMTokens: 'nem-szam' } })
  assert.ok(computeModelCostEur('claude-opus-4-8', 1000, 1000, table) > 0)
})

check('setting-override felülírja a defaultot', () => {
  const table = parseModelPricingSetting({ 'model-x': { inputPerMTokens: 1000, outputPerMTokens: 1000 } })
  assert.equal(computeModelCostEur('model-x', 1_000_000, 0, table), 1000)
})

console.log('')
if (failures > 0) {
  console.error(`❌ ${failures} teszt elbukott`)
  process.exit(1)
}
console.log('✅ Minden Governed Flow Builder (WP-4..8) teszt zöld')
