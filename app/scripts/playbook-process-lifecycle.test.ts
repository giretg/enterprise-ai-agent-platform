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
  buildStepCompletionPayload,
  normalizeAgentStepResult,
  parseAgentStepOutput,
  resolveStepInputPayload,
} from '../src/lib/playbook-v2/process-step-payload'
import { inferStepOutputFields } from '../src/lib/playbook-v2/step-output-inference'
import { evaluateTicketTransition } from '../src/lib/playbook-v2/runtime'
import { parsePlaybookSpecV2 } from '../src/lib/playbook-v2/spec'
import { isAgentSuitable } from '../src/domain/playbook/suitability'

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

check('parseAgentStepOutput: egy mező → teljes szöveg', () => {
  const out = parseAgentStepOutput('Kutatási összefoglaló szöveg', ['research_results'])
  assert.equal(out.research_results, 'Kutatási összefoglaló szöveg')
})

check('parseAgentStepOutput: JSON blokk', () => {
  const out = parseAgentStepOutput(
    'Kész.\n```json\n{"research_results":{"facts":[]}}\n```',
    ['research_results'],
  )
  assert.deepEqual(out.research_results, { facts: [] })
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

console.log('')
if (failures > 0) {
  console.error(`❌ ${failures} teszt elbukott`)
  process.exit(1)
}
console.log('✅ Minden Folyamat-életciklus tiszta-mag teszt zöld')
