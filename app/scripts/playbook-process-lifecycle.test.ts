/**
 * Determinisztikus unit-teszt a Playbook→Folyamat→Futás életciklus TISZTA magjaihoz
 * (Folyamat-feature-spec §4.7, §4.8). DB és LLM NÉLKÜL:
 *   - buildEffectivePrompt (WP-8): rétegsorrend, rés-behelyettesítés, perszóna sértetlen,
 *   - isAgentSuitable (WP-6): capability-fedés, inaktív / idegen-tenant agent.
 *
 * Futtatás: npm run test:playbook-lifecycle
 */
import assert from 'node:assert/strict'
import { PlaybookCompiler } from '../src/domain/playbook/playbook-compiler'
import { buildEffectivePrompt } from '../src/lib/playbook-v2/effective-prompt'
import {
  agentAnswerStructuredFromPayload,
  buildStepCompletionPayload,
  extractAgentAnswerDisplayBody,
  normalizeAgentStepResult,
  parseAgentStepOutput,
  readStepOutcome,
  resolveStepInputPayload,
} from '../src/lib/playbook-v2/process-step-payload'
import { inferStepOutputFields } from '../src/lib/playbook-v2/step-output-inference'
import { evaluateTicketTransition } from '../src/lib/playbook-v2/runtime'
import { parsePlaybookSpecV2 } from '../src/lib/playbook-v2/spec'
import { isAgentSuitable } from '../src/domain/playbook/suitability'
import { PlaybookValidator } from '../src/domain/playbook/playbook-validator'
import { collectHandoffCandidatePaths } from '../src/domain/playbook/workspace-handoff'

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

console.log('=== buildEffectivePrompt (§4.7, WP-8) ===')

check('rétegsorrend: perszóna → utasítás → futás-input', () => {
  const { prompt } = buildEffectivePrompt({
    agentPersona: 'PERSONA_TEXT',
    instructionTemplate: 'INSTRUCTION_TEXT',
    runInput: { foo: 'bar' },
  })
  const iPersona = prompt.indexOf('PERSONA_TEXT')
  const iInstr = prompt.indexOf('INSTRUCTION_TEXT')
  const iInput = prompt.indexOf('Futás-bemenet')
  assert.ok(iPersona >= 0 && iInstr > iPersona && iInput > iInstr, prompt)
})

check('rés-behelyettesítés config + trigger forrásból', () => {
  const { prompt, missingSlots } = buildEffectivePrompt({
    agentPersona: 'P',
    instructionTemplate: 'Riport a(z) {{ceg}} cégről a(z) {{sablon}} alapján.',
    slots: { ceg: 'Acme Kft', sablon: 'negyedéves' },
  })
  assert.match(prompt, /Acme Kft/)
  assert.match(prompt, /negyedéves/)
  assert.equal(missingSlots.length, 0)
})

check('perszóna szövege sértetlen marad (nem íródik felül)', () => {
  const persona = 'Én egy pénzügyi elemző agent vagyok, {{ceg}} néven nem cserélhető.'
  const { prompt } = buildEffectivePrompt({
    agentPersona: persona,
    instructionTemplate: 'Feladat: {{ceg}}',
    slots: { ceg: 'Acme' },
  })
  // A perszónában lévő {{ceg}} NEM helyettesítődik (csak a lépés-utasításban).
  assert.ok(prompt.includes(persona), prompt)
})

check('feloldatlan kötelező token → missingSlots jelzi, token marad', () => {
  const { prompt, missingSlots } = buildEffectivePrompt({
    agentPersona: 'P',
    instructionTemplate: 'Cég: {{ceg}}',
    slots: {},
  })
  assert.deepEqual(missingSlots, ['ceg'])
  assert.match(prompt, /\{\{ceg\}\}/)
})

check('objektum-érték kanonikus JSON-ként kerül be', () => {
  const { prompt } = buildEffectivePrompt({
    agentPersona: 'P',
    instructionTemplate: 'Adat: {{adat}}',
    slots: { adat: { a: 1 } },
  })
  assert.match(prompt, /\{"a":1\}/)
})

console.log('=== isAgentSuitable (§4.8, WP-6) ===')

const baseAgent = {
  status: 'active',
  tenantId: 't1',
  capabilities: [
    { toolName: 'tool:file_read', allowed: true },
    { toolName: 'tool:web_fetch', allowed: false },
  ],
}

check('aktív, azonos tenant, fedő capability → ok', () => {
  const r = isAgentSuitable(baseAgent, { requiredCapabilities: ['tool:file_read'] }, 't1')
  assert.equal(r.ok, true)
})

check('hiányzó capability → nem ok, missing megnevezve', () => {
  const r = isAgentSuitable(baseAgent, { requiredCapabilities: ['tool:web_fetch'] }, 't1')
  assert.equal(r.ok, false)
  assert.ok(!r.ok && r.missing.includes('tool:web_fetch'))
})

check('inaktív (retired) agent → nem ok', () => {
  const r = isAgentSuitable({ ...baseAgent, status: 'retired' }, {}, 't1')
  assert.equal(r.ok, false)
})

check('idegen tenant → nem ok', () => {
  const r = isAgentSuitable(baseAgent, {}, 't2')
  assert.equal(r.ok, false)
})

check('nincs requiredCapability → ok (csak státusz+tenant számít)', () => {
  const r = isAgentSuitable(baseAgent, {}, 't1')
  assert.equal(r.ok, true)
})

console.log('=== process-step-payload (lépés közötti adatátadás) ===')

check('resolveStepInputPayload: trigger fallback előző lépés mezőjéből', () => {
  const resolved = resolveStepInputPayload(
    {
      inputSlots: [
        { name: 'research_results', type: 'freeform', required: true, source: 'trigger' },
      ],
    },
    {
      processInput: {},
      previousStepResult: { research_results: 'kutatás' },
    },
  )
  assert.equal(resolved.research_results, 'kutatás')
})

check('normalizeAgentStepResult: answer → outputContract mező', () => {
  const normalized = normalizeAgentStepResult(
    { outputRequiredFields: ['research_results'] },
    { answer: 'kutatási szöveg', toolCallCount: 1 },
  )
  assert.equal(normalized.research_results, 'kutatási szöveg')
  assert.equal(normalized.answer, 'kutatási szöveg')
})

check('normalizeAgentStepResult: path-slotba NEM megy a próza', () => {
  // Enélkül a szerződés „teljesültnek" látszott, a következő lépés pedig egy
  // egész mondatot kapott fájlnév gyanánt.
  const normalized = normalizeAgentStepResult(
    { outputRequiredFields: ['feldolgozottLapPath', 'osszefoglalo'] },
    { answer: 'A feldolgozás megtörtént, 1/1 hányaddal.', toolCallCount: 2 },
  )
  assert.equal(normalized.feldolgozottLapPath, undefined)
  assert.equal(normalized.osszefoglalo, 'A feldolgozás megtörtént, 1/1 hányaddal.')
})

check('resolveStepInputPayload: workspace-relatív path-slot handoff-jelölt', () => {
  const resolved = resolveStepInputPayload(
    {
      inputSlots: [
        { name: 'feldolgozottLapPath', type: 'string', required: true, source: 'step' },
        { name: 'ingatlan', type: 'string', required: false, source: 'step' },
      ],
    },
    {
      processInput: {},
      previousStepResult: {
        feldolgozottLapPath: 'feldolgozott-tulajdoni-lap-043-15.json',
        ingatlan: 'Külterület, 43/15 helyrajzi szám',
      },
    },
  )
  assert.equal(resolved.feldolgozottLapPath, 'feldolgozott-tulajdoni-lap-043-15.json')
  assert.deepEqual(collectHandoffCandidatePaths({
    feldolgozottLapPath: resolved.feldolgozottLapPath,
  }), ['feldolgozott-tulajdoni-lap-043-15.json'])
  assert.deepEqual(
    collectHandoffCandidatePaths({ tmp: '/tmp/tl_extracted.json', abs: '/Users/out.json' }),
    [],
  )
})

check('resolveStepInputPayload: step forrás az előző lépésből jön', () => {
  const resolved = resolveStepInputPayload(
    {
      inputSlots: [
        { name: 'research_results', type: 'freeform', required: true, source: 'step' },
        { name: 'topic', type: 'string', required: true, source: 'trigger' },
      ],
    },
    {
      processInput: { topic: 'GDPR incidens' },
      previousStepResult: { research_results: { facts: [] } },
    },
  )
  assert.deepEqual(resolved.research_results, { facts: [] })
  assert.equal(resolved.topic, 'GDPR incidens')
})

check('parseAgentStepOutput: JSON nélküli válasz → a mező hiányzik (nem a nyers szöveg)', () => {
  const out = parseAgentStepOutput('Kutatási összefoglaló szöveg', ['research_results'])
  assert.equal(out.research_results, undefined)
  assert.equal(out.answer, 'Kutatási összefoglaló szöveg')
})

check('parseAgentStepOutput: JSON blokk', () => {
  const out = parseAgentStepOutput(
    'Kész.\n```json\n{"research_results":{"facts":[]}}\n```',
    ['research_results'],
  )
  assert.deepEqual(out.research_results, { facts: [] })
})

check('parseAgentStepOutput: nyers sortörés a KULCSBAN → normalizált illesztéssel kinyerhető', () => {
  // Valós modell-kimenet: `{"provider\nName": "Barion"}` — a nyers sortörés miatt a JSON
  // önmagában érvénytelen, a kulcs sem egyezne. A robusztus parse+normalizálás helyreteszi.
  const out = parseAgentStepOutput('{"provider\nName": "Barion"}', ['providerName'])
  assert.equal(out.providerName, 'Barion')
})

check('parseAgentStepOutput: nyers sortörés/tab az ÉRTÉKBEN → tartalom megmarad', () => {
  const out = parseAgentStepOutput(
    '{"providerName":"Barion","announcementSummary":"1. sor\n2. sor\ttab"}',
    ['providerName', 'announcementSummary'],
  )
  assert.equal(out.providerName, 'Barion')
  assert.equal(out.announcementSummary, '1. sor\n2. sor\ttab')
})

check('buildStepCompletionPayload: outputContract mezők a ticket payloadban', () => {
  const payload = buildStepCompletionPayload({
    agentContent: '{"research_results":"adat"}',
    outputRequiredFields: ['research_results'],
    meta: { toolCallCount: 1 },
  })
  assert.equal(payload.research_results, 'adat')
  assert.equal(payload.toolCallCount, 1)
})

check('extractAgentAnswerDisplayBody: drafted_proposal a playbook output mezőből', () => {
  const body = extractAgentAnswerDisplayBody(
    {
      research_results: 'kutatás összefoglaló',
      drafted_proposal: 'Ez a javasolt szöveg a banknak.',
      toolCallCount: 3,
      model: 'qwen/test',
    },
    ['drafted_proposal'],
  )
  assert.equal(body, 'Ez a javasolt szöveg a banknak.')
})

check('extractAgentAnswerDisplayBody: answer elsőbbséget élvez', () => {
  const body = extractAgentAnswerDisplayBody({
    answer: 'Közvetlen válasz',
    drafted_proposal: 'Más mező',
  })
  assert.equal(body, 'Közvetlen válasz')
})

check('agentAnswerStructuredFromPayload: model és toolCallCount', () => {
  const structured = agentAnswerStructuredFromPayload({
    model: 'qwen/test',
    toolCallCount: 7,
    memoryVersion: 5,
  })
  assert.equal(structured.model, 'qwen/test')
  assert.equal(structured.toolCallCount, 7)
  assert.equal(structured.memoryVersion, 5)
})

check('readStepOutcome: status+reason kiolvasva auditra (pl. tool_denied)', () => {
  const out = readStepOutcome({ outcome: { status: 'failed', reason: 'tool_denied' } })
  assert.equal(out.status, 'failed')
  assert.equal(out.reason, 'tool_denied')
})

check('readStepOutcome: hiányzó outcome → üres (nincs audit-zaj)', () => {
  assert.deepEqual(readStepOutcome({}), {})
  assert.deepEqual(readStepOutcome(undefined), {})
})

check('readStepOutcome: ismeretlen státusz-érték figyelmen kívül marad', () => {
  const out = readStepOutcome({ outcome: { status: 'weird', reason: 'x' } })
  assert.equal(out.status, undefined)
  assert.equal(out.reason, 'x')
})

console.log('=== step-output-inference + compiler ===')

const twoStepSpec = parsePlaybookSpecV2({
  schemaVersion: '1.0',
  key: 'privacy-flow',
  name: 'Privacy flow',
  processType: 'data_protection_tipp',
  entryStepId: 'research_incidents',
  roles: [
    { key: 'research_agent', type: 'agent_role' },
    { key: 'key_agent', type: 'agent_role' },
  ],
  steps: [
    {
      id: 'research_incidents',
      name: 'Research',
      ticketType: 'research',
      assignedRole: 'research_agent',
      onComplete: [{ condition: 'default', nextStepId: 'analyze_and_draft_recommendations' }],
    },
    {
      id: 'analyze_and_draft_recommendations',
      name: 'Analyze',
      ticketType: 'analysis',
      assignedRole: 'key_agent',
      instructionTemplate: 'Elemezd: {{research_results}}',
      inputSlots: [
        {
          name: 'research_results',
          type: 'freeform',
          required: true,
          source: 'step',
        },
      ],
    },
  ],
  gates: [],
  transitions: [],
})

check('inferStepOutputFields: research lépés kimenete research_results', () => {
  const inferred = inferStepOutputFields(twoStepSpec)
  assert.deepEqual(inferred.get('research_incidents'), ['research_results'])
})

// WP-8 regresszió: a Decision Step ágai (branches + fallback) is valós routing-élek,
// ezért a döntési lépés kimenet-következtetésének látnia kell az ágak mögötti,
// `step`-forrású kötelező input-réseket — különben a döntési lépés némán `ok`-ként
// zárul, és a folyamat csak a KÖVETKEZŐ lépésnél akad el (output_contract_unmet).
const decisionBranchSpec = parsePlaybookSpecV2({
  schemaVersion: '1.0',
  key: 'decision-infer-flow',
  name: 'Decision infer flow',
  processType: 'decision_test',
  entryStepId: 'triage',
  roles: [{ key: 'triage_agent', type: 'agent_role' }],
  steps: [
    {
      id: 'triage',
      name: 'Triage',
      ticketType: 'triage',
      assignedRole: 'triage_agent',
      instructionTemplate: 'Döntsd el: {{ticket}}',
      outputContract: { requiredFields: ['decision'] },
      decision: {
        field: 'decision',
        branches: [{ outcome: 'approve', nextStepId: 'execute' }],
        fallback: { nextStepId: 'reject' },
      },
    },
    {
      id: 'execute',
      name: 'Execute',
      ticketType: 'execution',
      assignedRole: 'triage_agent',
      instructionTemplate: 'Hajtsd végre: {{approved_amount}}',
      inputSlots: [
        { name: 'approved_amount', type: 'string', required: true, source: 'step' },
      ],
    },
    {
      id: 'reject',
      name: 'Reject',
      ticketType: 'rejection',
      assignedRole: 'triage_agent',
      instructionTemplate: 'Indokold: {{reject_reason}}',
      inputSlots: [
        { name: 'reject_reason', type: 'string', required: true, source: 'step' },
      ],
    },
  ],
  gates: [],
  transitions: [],
})

check('inferStepOutputFields: decision branch + fallback mögötti step-input mezők', () => {
  const inferred = inferStepOutputFields(decisionBranchSpec)
  // A branch (execute → approved_amount) ÉS a fallback (reject → reject_reason)
  // downstream step-input rései is a döntési lépés kimeneti szerződésébe kerülnek.
  assert.deepEqual(
    [...(inferred.get('triage') ?? [])].sort(),
    ['approved_amount', 'reject_reason'],
  )
})

check('compiler: decision-lépés outputRequiredFields tartalmazza az ág-mezőket', () => {
  const compiler = new PlaybookCompiler()
  const compiled = compiler.compile(decisionBranchSpec)
  const triageRule = compiled.ticketRules.find((r) => r.stepId === 'triage')!
  assert.ok(triageRule.outputRequiredFields.includes('approved_amount'))
  assert.ok(triageRule.outputRequiredFields.includes('reject_reason'))
})

check('compiler: outputRequiredFields átvezetés + step input feloldás', () => {
  const compiler = new PlaybookCompiler()
  const compiled = compiler.compile(twoStepSpec)
  const researchRule = compiled.ticketRules.find((r) => r.stepId === 'research_incidents')!
  const analyzeRule = compiled.ticketRules.find((r) => r.stepId === 'analyze_and_draft_recommendations')!
  assert.deepEqual(researchRule.outputRequiredFields, ['research_results'])
  assert.equal(analyzeRule.inputSlots[0]?.source, 'step')

  const resolved = resolveStepInputPayload(analyzeRule, {
    processInput: { topic: 'x' },
    previousStepResult: { research_results: 'kutatás' },
  })
  assert.equal(resolved.research_results, 'kutatás')
})

check('evaluateTicketTransition: lépés outputContract kikényszerítése', () => {
  const compiler = new PlaybookCompiler()
  const compiled = compiler.compile(twoStepSpec)
  const denied = evaluateTicketTransition(compiled, {
    stepId: 'research_incidents',
    fromState: 'in_progress',
    toState: 'done',
    actor: { type: 'agent' },
    outputPayload: { answer: 'csak szöveg' },
  })
  assert.equal(denied.allowed, false)
  if (!denied.allowed) assert.equal(denied.denyCode, 'OUTPUT_CONTRACT_VIOLATION')

  const allowed = evaluateTicketTransition(compiled, {
    stepId: 'research_incidents',
    fromState: 'in_progress',
    toState: 'done',
    actor: { type: 'agent' },
    outputPayload: { research_results: 'kutatás' },
  })
  assert.equal(allowed.allowed, true)
})

console.log('=== checkOutputContractCoverage (output ↔ downstream input kontraktus) ===')

function specWithFetchStep(instructionTemplate: string, outputContract?: Record<string, unknown>) {
  return {
    schemaVersion: '1.0',
    key: 'coverage-flow',
    name: 'Coverage flow',
    processType: 'coverage_test',
    entryStepId: 'fetch_status',
    roles: [{ key: 'crm_agent', type: 'agent_role' as const }],
    steps: [
      {
        id: 'fetch_status',
        name: 'Fetch',
        ticketType: 'data-retrieval',
        assignedRole: 'crm_agent',
        instructionTemplate,
        ...(outputContract ? { outputContract } : {}),
        onComplete: [{ condition: 'default' as const, nextStepId: 'check_activity' }],
      },
      {
        id: 'check_activity',
        name: 'Check activity',
        ticketType: 'data-check',
        assignedRole: 'crm_agent',
        instructionTemplate: 'Nézd meg: {{providerName}} {{lastActivityDate}}',
        inputSlots: [
          { name: 'providerName', type: 'string' as const, required: true, source: 'step' as const },
          { name: 'lastActivityDate', type: 'string' as const, required: true, source: 'step' as const },
        ],
      },
    ],
    gates: [],
    transitions: [],
  }
}

check('prompt nem nevesíti a downstream mezőket → OUTPUT_CONTRACT_NOT_PROMPTED warning', () => {
  const validator = new PlaybookValidator()
  const result = validator.validateSpec(
    specWithFetchStep('Fetch the current CRM status for {{providerName}}.', undefined),
  )
  const warning = result.warnings.find((w) => w.code === 'OUTPUT_CONTRACT_NOT_PROMPTED')
  assert.ok(warning, JSON.stringify(result.warnings))
  assert.match(warning!.message, /lastActivityDate/)
})

check('prompt nevesíti mindkét mezőt → nincs OUTPUT_CONTRACT_NOT_PROMPTED warning', () => {
  const validator = new PlaybookValidator()
  const result = validator.validateSpec(
    specWithFetchStep(
      'Fetch the status for {{providerName}}. Adj vissza JSON-t: {"providerName": "...", "lastActivityDate": "..."}.',
      undefined,
    ),
  )
  assert.equal(
    result.warnings.some((w) => w.code === 'OUTPUT_CONTRACT_NOT_PROMPTED'),
    false,
    JSON.stringify(result.warnings),
  )
})

check('explicit outputContract hiányos a downstream igényhez képest → OUTPUT_CONTRACT_INCOMPLETE warning', () => {
  const validator = new PlaybookValidator()
  const result = validator.validateSpec(
    specWithFetchStep('Fetch the status for {{providerName}}.', { requiredFields: ['providerName'] }),
  )
  const warning = result.warnings.find((w) => w.code === 'OUTPUT_CONTRACT_INCOMPLETE')
  assert.ok(warning, JSON.stringify(result.warnings))
  assert.match(warning!.message, /lastActivityDate/)
})

console.log('')
if (failures > 0) {
  console.error(`❌ ${failures} teszt elbukott`)
  process.exit(1)
}
console.log('✅ Minden Folyamat-életciklus tiszta-mag teszt zöld')
