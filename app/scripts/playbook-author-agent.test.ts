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
