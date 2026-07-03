/**
 * Determinisztikus unit-teszt a Playbook→Folyamat→Futás életciklus TISZTA magjaihoz
 * (Folyamat-feature-spec §4.7, §4.8). DB és LLM NÉLKÜL:
 *   - buildEffectivePrompt (WP-8): rétegsorrend, rés-behelyettesítés, perszóna sértetlen,
 *   - isAgentSuitable (WP-6): capability-fedés, inaktív / idegen-tenant agent.
 *
 * Futtatás: npm run test:playbook-lifecycle
 */
import assert from 'node:assert/strict'
import { buildEffectivePrompt } from '../src/lib/playbook-v2/effective-prompt'
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

console.log('')
if (failures > 0) {
  console.error(`❌ ${failures} teszt elbukott`)
  process.exit(1)
}
console.log('✅ Minden Folyamat-életciklus tiszta-mag teszt zöld')
