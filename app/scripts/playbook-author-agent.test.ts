/**
 * Determinisztikus teszt a Playbook-szerző agenthez (Feature-spec —
 * Playbook-Role-Agent-Binding §5.A, §6, WP-10). Futtatás: npm run test:playbook-author
 *
 * DB és élő hálózat NÉLKÜL igazolja a propose-not-apply munkafolyamatot: NL leírás →
 * JSON-draft kinyerés → PlaybookValidator-on átfuttatás, és hogy a hibás draftra a
 * validáció visszacsatol (nem dob, nem publikál, sosem ír DB-be).
 */
import assert from 'node:assert/strict'
import {
  PlaybookAuthorAgent,
  PLAYBOOK_AUTHOR_ROLE_INSTRUCTION,
  PLAYBOOK_AUTHOR_TEMPLATE,
  resolvePlaybookAuthorModelConfig,
  type PlaybookDraftingModel,
} from '../src/domain/playbook/playbook-author-agent'
import { PLAYBOOK_SCHEMA_VERSION } from '../src/lib/playbook-v2/spec'
import {
  detectReferencedSkills,
  resolveReferencedSkills,
  type SkillReferenceEntry,
} from '../src/lib/skill/skill-reference'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function fixedModel(content: string): PlaybookDraftingModel & { lastMessages?: unknown; lastModelConfig?: unknown } {
  const m: PlaybookDraftingModel & { lastMessages?: unknown; lastModelConfig?: unknown } = {
    async call(params) {
      m.lastMessages = params.messages
      m.lastModelConfig = params.modelConfig
      return { content }
    },
  }
  return m
}

function tulajdoniLapSkill(): SkillReferenceEntry {
  return {
    skillId: 'skill-1',
    skillVersionId: 'skill-1-v3',
    name: 'tulajdoni-lap',
    displayName: 'Tulajdoni lap feldolgozás',
    description: 'E-hiteles tulajdoni lap feldolgozása, tulajdonosok és terhek kinyerése.',
    version: 3,
    requiredTools: ['file_read', 'xlsx_create'],
    triggerKeywords: ['tulajdoni lap', 'földhivatali kivonat', 'hrsz'],
    parameters: [{ name: 'hrsz', description: 'Helyrajzi szám' }],
    instructions: ['Olvasd ki a hatályos tulajdonosokat és a tulajdoni hányadokat.'],
  }
}

function unrelatedSkill(): SkillReferenceEntry {
  return {
    skillId: 'skill-2',
    skillVersionId: 'skill-2-v1',
    name: 'email-triage',
    displayName: null,
    description: 'Beérkező levelek osztályozása.',
    version: 1,
    requiredTools: ['gmail_search'],
    triggerKeywords: ['levelezés'],
    parameters: [],
    instructions: ['Rendezd a beérkező leveleket kategóriákba.'],
  }
}

function validRawSpec() {
  return {
    schemaVersion: PLAYBOOK_SCHEMA_VERSION,
    key: 'lead-qualification',
    name: 'Lead minősítés',
    processType: 'sales.lead_qualification',
    entryStepId: 'gather',
    roles: [
      { key: 'researcher', type: 'agent_role', requiredCapabilities: ['web_search'] },
      { key: 'reviewer', type: 'human_role', requiredPermissions: ['sales.lead.review'] },
    ],
    steps: [
      {
        id: 'gather',
        name: 'Céginfó gyűjtés',
        ticketType: 'lead_gather',
        assignedRole: 'researcher',
        instructionTemplate: 'Gyűjts céginfót a következő cégről: {{company}}',
        inputSlots: [{ name: 'company', type: 'string', required: true, source: 'trigger' }],
        onComplete: [{ condition: 'default', gateId: 'approve' }],
      },
    ],
    gates: [
      {
        id: 'approve',
        type: 'human_approval',
        requiredActorRole: 'reviewer',
        blocking: true,
      },
    ],
    transitions: [],
  }
}

async function main() {
  await test('draftSpec: valid JSON-t ad vissza, a validáció valid=true', async () => {
    const model = fixedModel(JSON.stringify(validRawSpec()))
    const agent = new PlaybookAuthorAgent({ model })
    const result = await agent.draftSpec({
      agentId: 'agent-author',
      description: 'Készíts egy lead-minősítő folyamatot: kutató agent gyűjt céginfót, ember jóváhagyja.',
      knownCapabilities: ['web_search'],
      knownPermissions: ['sales.lead.review'],
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.validation.valid, true, JSON.stringify(result.validation.errors))
  })

  await test('draftSpec: ismeretlen human permission → UNKNOWN_PERMISSION, ha van IAM szótár', async () => {
    const spec = validRawSpec()
    ;(spec.roles[1] as { requiredPermissions: string[] }).requiredPermissions = ['marketing-content-approve']
    const model = fixedModel(JSON.stringify(spec))
    const agent = new PlaybookAuthorAgent({ model })
    const result = await agent.draftSpec({
      agentId: 'agent-author',
      description: 'Készíts egy marketing jóváhagyási folyamatot.',
      knownCapabilities: ['web_search'],
      knownPermissions: ['sales.lead.review'],
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.validation.valid, false)
    assert.ok(result.validation.errors.some((e) => e.code === 'UNKNOWN_PERMISSION'), JSON.stringify(result.validation.errors))
  })

  await test('draftSpec: ismeretlen capability → UNKNOWN_CAPABILITY, de spec visszajön (visszacsatolás)', async () => {
    const spec = validRawSpec()
    ;(spec.roles[0] as { requiredCapabilities: string[] }).requiredCapabilities = ['tool_that_does_not_exist']
    const model = fixedModel(JSON.stringify(spec))
    const agent = new PlaybookAuthorAgent({ model })
    const result = await agent.draftSpec({
      agentId: 'agent-author',
      description: 'Készíts egy lead-minősítő folyamatot.',
      knownCapabilities: ['web_search'],
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.validation.valid, false)
    assert.ok(result.validation.errors.some((e) => e.code === 'UNKNOWN_CAPABILITY'), JSON.stringify(result.validation.errors))
    assert.deepEqual(result.spec, spec, 'a spec-nek sértetlenül vissza kell jönnie a visszacsatoláshoz')
  })

  await test('draftSpec: modell-prózára (nincs JSON) PARSE_FAILED, nem dob', async () => {
    const model = fixedModel('Sajnálom, nem tudok segíteni ebben.')
    const agent = new PlaybookAuthorAgent({ model })
    const result = await agent.draftSpec({ agentId: 'agent-author', description: 'valami' })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error, 'PARSE_FAILED')
  })

  await test('draftSpec/#33: hiányos alak (nincs steps) → PARSE_FAILED, nem ok:true', async () => {
    const model = fixedModel(
      JSON.stringify({
        schemaVersion: PLAYBOOK_SCHEMA_VERSION,
        key: 'broken',
        name: 'Broken',
        processType: 'x',
        entryStepId: 's1',
        roles: [{ key: 'r', type: 'agent_role' }],
        // steps hiányzik — alak-sértés
        gates: [],
        transitions: [],
      }),
    )
    const agent = new PlaybookAuthorAgent({ model })
    const result = await agent.draftSpec({ agentId: 'agent-author', description: 'valami' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error, 'PARSE_FAILED')
  })

  await test('draftSpec: üres leírásra PARSE_FAILED, a modellt meg sem hívja', async () => {
    let called = false
    const model: PlaybookDraftingModel = {
      async call() {
        called = true
        return { content: '{}' }
      },
    }
    const agent = new PlaybookAuthorAgent({ model })
    const result = await agent.draftSpec({ agentId: 'agent-author', description: '   ' })
    assert.equal(result.ok, false)
    assert.equal(called, false)
  })

  await test('draftSpec: üres leírás + existingSpec (auto-fix) → modell hívódik', async () => {
    let called = false
    const model: PlaybookDraftingModel = {
      async call(params) {
        called = true
        ;(model as { lastMessages?: unknown }).lastMessages = params.messages
        return { content: JSON.stringify(validRawSpec()) }
      },
    }
    const agent = new PlaybookAuthorAgent({ model })
    const result = await agent.draftSpec({
      agentId: 'agent-author',
      description: '',
      existingSpec: validRawSpec(),
      priorValidation: { valid: false, errors: [{ code: 'X', path: '', message: 'x' }], warnings: [] },
    })
    assert.equal(called, true)
    assert.equal(result.ok, true)
  })

  await test('draftSpec: outputLanguage bekerül a system promptba', async () => {
    const model = fixedModel(JSON.stringify(validRawSpec()))
    const agent = new PlaybookAuthorAgent({ model })
    await agent.draftSpec({
      agentId: 'agent-author',
      description: 'Készíts folyamatot.',
      outputLanguage: 'en',
    })
    const messages = (model as { lastMessages?: unknown }).lastMessages as Array<{ role: string; content: string }>
    const system = messages.find((m) => m.role === 'system')!
    assert.ok(system.content.includes('OUTPUT LANGUAGE'))
    assert.ok(system.content.includes('English'))
  })

  await test('draftSpec: meglévő spec + előző validációs hiba bekerül a promptba', async () => {
    const model = fixedModel(JSON.stringify(validRawSpec()))
    const agent = new PlaybookAuthorAgent({ model })
    const existingSpec = validRawSpec()
    await agent.draftSpec({
      agentId: 'agent-author',
      description: 'Javítsd a hibát.',
      knownPermissions: ['sales.lead.review'],
      existingSpec,
      priorValidation: { valid: false, errors: [{ code: 'UNKNOWN_CAPABILITY', path: 'roles[0]', message: 'x' }], warnings: [] },
    })
    const messages = (model as { lastMessages?: unknown }).lastMessages as Array<{ role: string; content: string }>
    const userMsg = messages.find((m) => m.role === 'user')!
    assert.ok(userMsg.content.includes('EXISTING spec to edit'))
    assert.ok(userMsg.content.includes('UNKNOWN_CAPABILITY'))
    assert.ok(userMsg.content.includes('IAM permission vocabulary'))
    assert.ok(userMsg.content.includes('sales.lead.review'))
  })

  await test('draftSpec: előző validációs WARNING (pl. OUTPUT_CONTRACT_NOT_PROMPTED) is bekerül a promptba, nem csak az error', async () => {
    const model = fixedModel(JSON.stringify(validRawSpec()))
    const agent = new PlaybookAuthorAgent({ model })
    await agent.draftSpec({
      agentId: 'agent-author',
      description: 'Javítsd a figyelmeztetést.',
      existingSpec: validRawSpec(),
      priorValidation: {
        valid: true,
        errors: [],
        warnings: [
          {
            code: 'OUTPUT_CONTRACT_NOT_PROMPTED',
            path: 'steps[0].instructionTemplate',
            message: 'lastActivityDate hiányzik a promptból',
          },
        ],
      },
    })
    const messages = (model as { lastMessages?: unknown }).lastMessages as Array<{ role: string; content: string }>
    const userMsg = messages.find((m) => m.role === 'user')!
    assert.ok(userMsg.content.includes('OUTPUT_CONTRACT_NOT_PROMPTED'))
    assert.ok(userMsg.content.includes('lastActivityDate'))
  })

  await test('draftSpec: rendszerprompt előírja a downstream step-mezők explicit nevesítését', async () => {
    assert.ok(PLAYBOOK_AUTHOR_ROLE_INSTRUCTION.includes('output_contract_unmet'))
  })

  await test('rendszerprompt: a lépés-szerződések összehangolása külön, kötelező blokk', () => {
    assert.ok(PLAYBOOK_AUTHOR_ROLE_INSTRUCTION.includes('STEP CONTRACT CHAINING'))
    // A három lépés (deklarálás / promptba írás / típus) mindegyike szerepel.
    assert.ok(PLAYBOOK_AUTHOR_ROLE_INSTRUCTION.includes('DECLARE it on A'))
    assert.ok(PLAYBOOK_AUTHOR_ROLE_INSTRUCTION.includes("PROMPT it in A's instructionTemplate"))
    assert.ok(PLAYBOOK_AUTHOR_ROLE_INSTRUCTION.includes('TYPE it'))
    // A név-egyezés szó szerinti: se fordítás, se kis/nagybetű-tolerancia.
    assert.ok(PLAYBOOK_AUTHOR_ROLE_INSTRUCTION.includes('EXACT field name'))
  })

  await test('rendszerprompt: a skill-használat szabályai benne vannak', () => {
    assert.ok(PLAYBOOK_AUTHOR_ROLE_INSTRUCTION.includes('SKILLS ('))
    assert.ok(PLAYBOOK_AUTHOR_ROLE_INSTRUCTION.includes('requiredCapabilities'))
    assert.ok(PLAYBOOK_AUTHOR_ROLE_INSTRUCTION.includes('never invent one that is missing'))
  })

  await test('skill-katalógus és a hivatkozott skill törzse bekerül a promptba', async () => {
    const model = fixedModel(JSON.stringify(validRawSpec()))
    const agent = new PlaybookAuthorAgent({ model })
    await agent.draftSpec({
      agentId: 'agent-author',
      description: 'A második lépésben használd a tulajdoni-lap skillt.',
      skillCatalog: [tulajdoniLapSkill(), unrelatedSkill()],
      referencedSkills: [tulajdoniLapSkill()],
    })
    const messages = (model as { lastMessages?: unknown }).lastMessages as Array<{ role: string; content: string }>
    const userMsg = messages.find((m) => m.role === 'user')!
    // Level-0: mindkét skill neve+leírása
    assert.ok(userMsg.content.includes('SKILL CATALOG'))
    assert.ok(userMsg.content.includes('email-triage'))
    // Level-1: CSAK a hivatkozott skill törzse
    assert.ok(userMsg.content.includes('SKILL IN USE'))
    assert.ok(userMsg.content.includes('Olvasd ki a hatályos tulajdonosokat'))
    assert.ok(!userMsg.content.includes('Rendezd a beérkező leveleket'))
    // A skill kötelező eszközei nevesítve, hogy a szerep requiredCapabilities-ébe kerüljenek
    assert.ok(userMsg.content.includes('file_read'))
    // A skill deklarált paraméterei is ott vannak (inputSlot-jelöltek)
    assert.ok(userMsg.content.includes('hrsz'))
  })

  await test('skill-kontextus nélkül a prompt nem tartalmaz skill-blokkot (üres katalógus)', async () => {
    const model = fixedModel(JSON.stringify(validRawSpec()))
    const agent = new PlaybookAuthorAgent({ model })
    await agent.draftSpec({ agentId: 'agent-author', description: 'Készíts folyamatot.' })
    const messages = (model as { lastMessages?: unknown }).lastMessages as Array<{ role: string; content: string }>
    const userMsg = messages.find((m) => m.role === 'user')!
    assert.ok(!userMsg.content.includes('SKILL CATALOG'))
    assert.ok(!userMsg.content.includes('SKILL IN USE'))
  })

  await test('detectReferencedSkills: névre, ékezet- és írásjel-függetlenül illeszt', () => {
    const catalog = [tulajdoniLapSkill(), unrelatedSkill()]
    assert.deepEqual(
      detectReferencedSkills('Használd a Tulajdoni Lap skillt a második lépésben.', catalog).map((s) => s.name),
      ['tulajdoni-lap'],
    )
    assert.deepEqual(
      detectReferencedSkills('futtasd a /tulajdoni-lap skillt', catalog).map((s) => s.name),
      ['tulajdoni-lap'],
    )
  })

  await test('detectReferencedSkills: trigger-kulcsszó is hivatkozás, de a nem érintett skill nem jön be', () => {
    const catalog = [tulajdoniLapSkill(), unrelatedSkill()]
    const hits = detectReferencedSkills('Kérj be egy földhivatali kivonatot az ügyféltől.', catalog)
    assert.deepEqual(hits.map((s) => s.name), ['tulajdoni-lap'])
    assert.deepEqual(detectReferencedSkills('Írj egy egyszerű riportot.', catalog), [])
  })

  await test('resolveReferencedSkills: az explicit /token választás mindig érvényesül', () => {
    const catalog = [tulajdoniLapSkill(), unrelatedSkill()]
    // A `/` menüből választott token akkor is betölt, ha a szöveg másról szól.
    assert.deepEqual(
      resolveReferencedSkills('Az utolsó lépésben /email-triage kell.', catalog).map((s) => s.name),
      ['email-triage'],
    )
    // Explicit + felismert együtt, az explicit elöl.
    assert.deepEqual(
      resolveReferencedSkills('/email-triage után nézd meg a tulajdoni lapot is.', catalog).map(
        (s) => s.name,
      ),
      ['email-triage', 'tulajdoni-lap'],
    )
  })

  await test('detectReferencedSkills: szóhatáron illeszt (nincs részszó-találat)', () => {
    const catalog = [
      { ...unrelatedSkill(), name: 'lead', triggerKeywords: [] },
    ]
    // A 'lead' önmagában 4 karakter, de a 'leadership' szóban nem találat.
    assert.deepEqual(detectReferencedSkills('Fejleszd a leadership programot.', catalog), [])
    assert.equal(detectReferencedSkills('Indítsd a lead folyamatot.', catalog).length, 1)
  })

  await test('draftSpec: sosem tartalmaz konkrét agent-kötést kérő instrukciót — a role kulcs marad', async () => {
    assert.ok(PLAYBOOK_AUTHOR_ROLE_INSTRUCTION.includes('never bind a concrete agent'))
  })

  await test('resolvePlaybookAuthorModelConfig: nem-támogatott providerre a sablonra esik vissza', () => {
    const cfg = resolvePlaybookAuthorModelConfig({ provider: 'unsupported-provider', model: 'x' })
    assert.deepEqual(cfg, PLAYBOOK_AUTHOR_TEMPLATE.modelConfig)
  })

  await test('resolvePlaybookAuthorModelConfig: támogatott provider átmegy', () => {
    const cfg = resolvePlaybookAuthorModelConfig({ provider: 'gemini', model: 'gemini-pro', temperature: 0.1 })
    assert.deepEqual(cfg, { provider: 'gemini', model: 'gemini-pro', temperature: 0.1 })
  })

  await test('PLAYBOOK_AUTHOR_TEMPLATE: nincs Tool Broker capability-je (v1 nem drótoz agentet/eszközt)', () => {
    assert.equal(PLAYBOOK_AUTHOR_TEMPLATE.capabilities.length, 0)
  })

  console.log('')
  if (failures > 0) {
    console.error(`❌ ${failures} teszt elbukott`)
    process.exit(1)
  }
  console.log('✅ Minden Playbook-szerző agent teszt zöld')
}

main()
