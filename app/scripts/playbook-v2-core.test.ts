/**
 * Determinisztikus unit-teszt a Fázis 2 Playbook MAGJÁHOZ (Feature-spec — Playbook
 * §5, §6, §7). Futtatás: npm run test:playbook-v2
 *
 * DB és LLM NÉLKÜL igazolja:
 *   - a V2 spec Zod-sémát (alak),
 *   - a PlaybookValidator szemantikai rétegét (§6.1 — UNKNOWN_ROLE, criticality,
 *     reachability, cycle-without-exit, human-gate),
 *   - a PlaybookCompiler determinisztikus állapotgép-kimenetét (§7.1),
 *   - a content-hash stabilitását (kulcssorrend-független).
 *
 * Lefedi a P1 (valid spec compile-olható) és P2 (UNKNOWN_ROLE → invalid) magját.
 */
import assert from 'node:assert/strict'
import {
  parsePlaybookSpecV2,
  computePlaybookContentHash,
  formatPlaybookRefV2,
  type PlaybookSpecV2,
} from '../src/lib/playbook-v2/spec'
import { PlaybookValidator } from '../src/domain/playbook/playbook-validator'
import { PlaybookCompiler } from '../src/domain/playbook/playbook-compiler'
import { syncInputSlotsWithTemplate } from '../src/lib/playbook-v2/input-slots-sync'
import { getRoleType, upsertRoleType } from '../src/lib/playbook-v2/role-sync'

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

type Json = Record<string, unknown>
/** A `steps`/`gates` tömböt mutálható objektum-tömbként éri el (cast `any` nélkül). */
function arr(spec: Json, key: 'steps' | 'gates'): Json[] {
  return spec[key] as Json[]
}

/** A §5.1 minimális, valid példa. */
function validSpec(): Json {
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
        allowedStates: ['ready', 'in_progress', 'awaiting_human', 'done', 'failed'],
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
        allowedStates: ['ready', 'awaiting_human', 'approved', 'rejected', 'done'],
        timeoutMinutes: 1440,
      },
    ],
    gates: [
      { id: 'low_confidence_review', type: 'manual_review', requiredActorRole: 'accounting_approver', blocking: true },
      {
        id: 'approve_accounting_posting',
        type: 'human_approval',
        requiredActorRole: 'accounting_approver',
        blocking: true,
        criticality: 'L2',
      },
    ],
    transitions: [{ fromStepId: 'extract_invoice', toStepId: 'approval', trigger: 'step.completed' }],
    outputContract: { requiredFields: ['invoiceNumber', 'amount', 'decision'] },
  }
}

const validator = new PlaybookValidator()
const compiler = new PlaybookCompiler()

console.log('=== Playbook v2 — séma + content-hash ===')

check('valid spec Zod-parse átmegy', () => {
  const spec = parsePlaybookSpecV2(validSpec())
  assert.equal(spec.key, 'invoice-processing')
  assert.equal(spec.steps.length, 2)
})

check('hiányzó entryStepId → Zod dob', () => {
  const bad = validSpec()
  delete bad.entryStepId
  assert.throws(() => parsePlaybookSpecV2(bad))
})

check('content-hash kulcssorrend-független és sha256: prefixű', () => {
  const a = validSpec()
  const b: Record<string, unknown> = {}
  // ugyanaz az objektum, fordított kulcsbeszúrási sorrendben
  for (const k of Object.keys(a).reverse()) b[k] = a[k]
  const ha = computePlaybookContentHash(a)
  const hb = computePlaybookContentHash(b)
  assert.equal(ha, hb)
  assert.match(ha, /^sha256:[0-9a-f]{64}$/)
})

check('playbook-ref formázás', () => {
  assert.equal(formatPlaybookRefV2('invoice-processing', 3), 'playbook:invoice-processing@v3')
})

console.log('=== PlaybookValidator (§6.1) ===')

check('P1-mag: valid spec → valid=true, nincs error', () => {
  const result = validator.validateSpec(validSpec())
  assert.equal(result.valid, true, JSON.stringify(result.errors))
  assert.equal(result.errors.length, 0)
})

check('P2-mag: nem létező role → UNKNOWN_ROLE, valid=false', () => {
  const bad = validSpec()
  arr(bad, 'steps')[1].assignedRole = 'nincs_ilyen_role'
  const result = validator.validateSpec(bad)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((e) => e.code === 'UNKNOWN_ROLE'))
})

check('L2 gate nem blocking → invalid (séma vagy szemantika fogja)', () => {
  const bad = validSpec()
  arr(bad, 'gates')[1].blocking = false
  const result = validator.validateSpec(bad)
  assert.equal(result.valid, false)
})

check('elérhetetlen step → UNREACHABLE_STEP', () => {
  const bad = validSpec()
  arr(bad, 'steps').push({
    id: 'orphan',
    name: 'Arva',
    ticketType: 'human_approval',
    assignedRole: 'accounting_approver',
  })
  const result = validator.validateSpec(bad)
  assert.ok(result.errors.some((e) => e.code === 'UNREACHABLE_STEP'))
})

check('kijárat nélküli ciklus → CYCLE_WITHOUT_EXIT', () => {
  const bad = validSpec()
  // approval visszamutat extract_invoice-ra, gate/timeout nélkül
  arr(bad, 'steps')[1] = {
    id: 'approval',
    name: 'Loop',
    ticketType: 'human_approval',
    assignedRole: 'accounting_approver',
    onComplete: [{ condition: 'default', nextStepId: 'extract_invoice' }],
  }
  delete arr(bad, 'steps')[0].timeoutMinutes
  arr(bad, 'steps')[0].requiredGateIds = []
  arr(bad, 'steps')[0].onComplete = [{ condition: 'default', nextStepId: 'approval' }]
  const result = validator.validateSpec(bad)
  assert.ok(
    result.errors.some((e) => e.code === 'CYCLE_WITHOUT_EXIT'),
    JSON.stringify(result.errors),
  )
})

check('tenant-kontextus: nincs aktív agent → NO_ACTIVE_AGENT', () => {
  const result = validator.validateSpec(validSpec(), {
    agentRoleActiveCounts: new Map([['invoice_extractor', 0]]),
  })
  assert.ok(result.errors.some((e) => e.code === 'NO_ACTIVE_AGENT'))
})

check('tenant-kontextus: ismeretlen ticket-típus → UNKNOWN_TICKET_TYPE', () => {
  const result = validator.validateSpec(validSpec(), {
    knownTicketTypes: new Set(['invoice_extract']), // human_approval hiányzik
  })
  assert.ok(result.errors.some((e) => e.code === 'UNKNOWN_TICKET_TYPE'))
})

console.log('=== PlaybookCompiler (§7.1) ===')

check('compile: ticketRules minden stephez, allowedTransitions agent/human actorral', () => {
  const spec = parsePlaybookSpecV2(validSpec()) as PlaybookSpecV2
  const compiled = compiler.compile(spec, { playbookVersionId: 'v-uuid' })
  assert.equal(compiled.playbookVersionId, 'v-uuid')
  assert.equal(compiled.entryStepId, 'extract_invoice')
  assert.equal(compiled.ticketRules.length, 2)

  const extract = compiled.ticketRules.find((r) => r.stepId === 'extract_invoice')!
  assert.equal(extract.stepName, 'Szamlaadatok kinyerese')
  // agent role → agent+system actor
  assert.deepEqual(extract.allowedTransitions[0].allowedActorTypes, ['agent', 'system'])
  // done felé output contract kötelező
  const toDone = extract.allowedTransitions.find((t) => t.toState === 'done')!
  assert.equal(toDone.requiresOutputContract, true)

  const approval = compiled.ticketRules.find((r) => r.stepId === 'approval')!
  assert.equal(approval.stepName, 'Konyvelesi jovahagyas')
  // human role → user actor
  assert.deepEqual(approval.allowedTransitions[0].allowedActorTypes, ['user'])
})

check('compile: blocking gate awaiting_human→approved átmenetet zár', () => {
  const spec = parsePlaybookSpecV2(validSpec()) as PlaybookSpecV2
  const compiled = compiler.compile(spec)
  const gate = compiled.gates.find((g) => g.gateId === 'approve_accounting_posting')!
  assert.equal(gate.blocking, true)
  assert.deepEqual(gate.blocksTransition, { fromState: 'awaiting_human', toState: 'approved' })
  assert.equal(gate.stepId, 'approval')
})

check('compile: routingRules tartalmazza az onComplete feltételes ágat', () => {
  const spec = parsePlaybookSpecV2(validSpec()) as PlaybookSpecV2
  const compiled = compiler.compile(spec)
  const conditional = compiled.routingRules.find(
    (r) => r.fromStepId === 'extract_invoice' && r.toStepId === 'approval',
  )!
  assert.ok(conditional)
  assert.deepEqual(conditional.condition, { field: 'confidence', op: '>=', value: 0.85 })
  const gateRoute = compiled.routingRules.find((r) => r.gateId === 'low_confidence_review')!
  assert.ok(gateRoute)
})

console.log('=== Tipizált input-rések + sablonos utasítás (Folyamat-spec §4.7, WP-3/4/5) ===')

/** A validSpec extract_invoice lépésére sablonos utasítást + réseket húz (valid). */
function specWithSlots(): Json {
  const spec = validSpec()
  const extract = arr(spec, 'steps')[0]
  extract.instructionTemplate =
    'Keresd ki a(z) {{ceg}} adatait és készíts riportot a(z) {{sablon}} alapján.'
  extract.inputSlots = [
    { name: 'ceg', type: 'string', required: true, source: 'trigger' },
    { name: 'sablon', type: 'string', required: true, source: 'config' },
  ]
  return spec
}

check('WP-3: instructionTemplate + inputSlots parse-olható', () => {
  const spec = parsePlaybookSpecV2(specWithSlots())
  const step = spec.steps[0]
  assert.equal(step.inputSlots?.length, 2)
  assert.equal(step.inputSlots?.[0].source, 'trigger')
  assert.match(step.instructionTemplate ?? '', /\{\{ceg\}\}/)
})

check('WP-3: rés nélküli régi spec továbbra is érvényes', () => {
  const spec = parsePlaybookSpecV2(validSpec())
  assert.equal(spec.steps[0].inputSlots, undefined)
})

check('WP-5: compiler átvezeti az inputSlots-ot + instructionTemplate-et', () => {
  const spec = parsePlaybookSpecV2(specWithSlots()) as PlaybookSpecV2
  const compiled = compiler.compile(spec)
  const extract = compiled.ticketRules.find((r) => r.stepId === 'extract_invoice')!
  assert.equal(extract.inputSlots.length, 2)
  assert.equal(extract.inputSlots.find((s) => s.name === 'sablon')!.source, 'config')
  assert.match(extract.instructionTemplate ?? '', /\{\{sablon\}\}/)
  // régi (rés nélküli) lépés → üres tömb, nem undefined
  const approval = compiled.ticketRules.find((r) => r.stepId === 'approval')!
  assert.deepEqual(approval.inputSlots, [])
})

check('WP-4: valid template↔rés → nincs input-rés hiba', () => {
  const result = validator.validateSpec(specWithSlots())
  assert.equal(result.valid, true, JSON.stringify(result.errors))
})

check('WP-4: ismeretlen sablon-token → UNKNOWN_TEMPLATE_SLOT', () => {
  const bad = specWithSlots()
  arr(bad, 'steps')[0].instructionTemplate = 'Riport a(z) {{nincs_ilyen}} alapján.'
  const result = validator.validateSpec(bad)
  assert.ok(result.errors.some((e) => e.code === 'UNKNOWN_TEMPLATE_SLOT'), JSON.stringify(result.errors))
})

check('WP-4: kötelező rés nem szerepel a template-ben → REQUIRED_SLOT_UNUSED', () => {
  const bad = specWithSlots()
  arr(bad, 'steps')[0].instructionTemplate = 'Csak a(z) {{ceg}} kell.'
  const result = validator.validateSpec(bad)
  assert.ok(result.errors.some((e) => e.code === 'REQUIRED_SLOT_UNUSED'), JSON.stringify(result.errors))
})

check('WP-4: duplikált rés-név lépésen belül → DUPLICATE_INPUT_SLOT', () => {
  const bad = specWithSlots()
  const slots = arr(bad, 'steps')[0].inputSlots as Json[]
  slots.push({ name: 'ceg', type: 'string', required: false, source: 'config' })
  const result = validator.validateSpec(bad)
  assert.ok(result.errors.some((e) => e.code === 'DUPLICATE_INPUT_SLOT'))
})

check('WP-4: ismeretlen capability a szótár ellen → UNKNOWN_CAPABILITY', () => {
  const result = validator.validateSpec(validSpec(), {
    knownCapabilities: new Set(['tool:web_fetch']), // tool:file_read hiányzik
  })
  assert.ok(result.errors.some((e) => e.code === 'UNKNOWN_CAPABILITY'), JSON.stringify(result.errors))
})

console.log('=== instructionTemplate ↔ inputSlots szinkron ===')

check('sync: új token → új slot trigger forrással', () => {
  const synced = syncInputSlotsWithTemplate('Hello {{bank_name}}!', [])
  assert.deepEqual(synced, [
    { name: 'bank_name', type: 'string', required: true, source: 'trigger' },
  ])
})

check('sync: eltávolított token → slot törlése, megmaradt metaadat', () => {
  const existing = [
    { name: 'ceg', type: 'string' as const, required: true, source: 'trigger' as const },
    { name: 'sablon', type: 'string' as const, required: true, source: 'config' as const },
  ]
  const synced = syncInputSlotsWithTemplate('Csak {{ceg}} kell.', existing)
  assert.deepEqual(synced, [existing[0]])
})

check('sync: ismerős token megtartja a meglévő slot metaadatot', () => {
  const existing = [
    { name: 'tone', type: 'freeform' as const, required: false, source: 'config' as const, description: 'Stílus' },
  ]
  const synced = syncInputSlotsWithTemplate('Stílus: {{tone}}', existing)
  assert.deepEqual(synced, existing)
})

check('sync: nincs token → undefined', () => {
  assert.equal(syncInputSlotsWithTemplate('Nincs placeholder', [{ name: 'x', type: 'string', required: true, source: 'trigger' }]), undefined)
})

console.log('=== roles[].type szinkron ===')

check('role sync: getRoleType ismeretlen kulcs → agent_role', () => {
  assert.equal(getRoleType([], 'unknown'), 'agent_role')
})

check('role sync: upsertRoleType frissít meglévőt', () => {
  const roles = [{ key: 'approver', type: 'agent_role' as const }]
  const next = upsertRoleType(roles, 'approver', 'human_role')
  assert.equal(next.length, 1)
  assert.equal(next[0].type, 'human_role')
})

check('role sync: upsertRoleType létrehoz újat', () => {
  const next = upsertRoleType([], 'researcher', 'agent_role')
  assert.deepEqual(next, [{ key: 'researcher', type: 'agent_role' }])
})

console.log('')
if (failures > 0) {
  console.error(`❌ ${failures} teszt elbukott`)
  process.exit(1)
}
console.log('✅ Minden Playbook v2 core teszt zöld')
