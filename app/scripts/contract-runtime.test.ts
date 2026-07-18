/**
 * Contract Runtime (#33) — determinisztikus + gateway-varratos tesztek.
 *
 * Futtatás: npm run test:contract-runtime
 *
 * Varratok (issue Testing Decisions):
 *   - tiszta fn: contract-fordítás, validáció, emberi hibaszöveg, laza mód
 *   - modell-szolgáltató injektálás: szigorú mód javítási korlátai / kritikusság
 *
 * Nem teszteljük: javító prompt szövegét, beolvasó belső lépéseit, lépés-futtató
 * teljes integrációját.
 */
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  compileContract,
  compileFromZod,
  formatContractErrors,
  extractLoose,
  validateAgainstContract,
  runStrictContract,
  type ContractField,
  type CompiledContract,
} from '../src/domain/contract-runtime'
import { PlaybookCompiler } from '../src/domain/playbook/playbook-compiler'
import type {
  ModelConfig,
  ModelProvider,
} from '../src/domain/gateway/model-gateway'
import { ModelGateway } from '../src/domain/gateway/model-gateway'
import type { AuditRepository, ModelCallRepository } from '../src/repositories/interfaces'
import type { AuditLog, ModelCall } from '@prisma/client'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => console.log(`  OK  ${name}`))
    .catch((e: unknown) => {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

async function main() {
  console.log('=== Contract Runtime (#33) ===\n')

  // --- CR-1: contract fordítás + validáció (tiszta fn) -----------------------

  await check('CR-1a: régi mezőnév-lista → kötelező, nem üres szöveg', () => {
    const contract = compileContract({ requiredFields: ['price', 'vendor'] })
    const ok = validateAgainstContract(contract, { price: '1200', vendor: 'Acme' })
    assert.equal(ok.ok, true)
    if (ok.ok) {
      assert.deepEqual(ok.value, { price: '1200', vendor: 'Acme' })
    }

    const empty = validateAgainstContract(contract, { price: '', vendor: 'Acme' })
    assert.equal(empty.ok, false)
    if (!empty.ok) {
      assert.ok(empty.errors.some((e) => e.field === 'price'))
    }

    const missing = validateAgainstContract(contract, { vendor: 'Acme' })
    assert.equal(missing.ok, false)
    if (!missing.ok) {
      assert.ok(missing.errors.some((e) => e.field === 'price'))
    }
  })

  await check('CR-1b: üres string nem számít kitöltöttnek (regresszió a mai résre)', () => {
    const contract = compileContract({
      fields: [{ name: 'decision', type: 'string', required: true }],
    })
    const result = validateAgainstContract(contract, { decision: '' })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.errors[0]?.field, 'decision')
    }
  })

  await check('CR-1c: tipizált mezők — szám, választás, logikai', () => {
    const fields: ContractField[] = [
      { name: 'price', type: 'number', required: true, description: 'Bruttó ár' },
      { name: 'decision', type: 'enum', required: true, enumValues: ['approve', 'reject'] },
      { name: 'urgent', type: 'boolean', required: false },
    ]
    const contract = compileContract({ fields })

    const ok = validateAgainstContract(contract, {
      price: 1500,
      decision: 'approve',
      urgent: true,
    })
    assert.equal(ok.ok, true)

    const badType = validateAgainstContract(contract, {
      price: 'nem-szám',
      decision: 'approve',
    })
    assert.equal(badType.ok, false)
    if (!badType.ok) {
      assert.ok(badType.errors.some((e) => e.field === 'price'))
    }

    const badEnum = validateAgainstContract(contract, {
      price: 10,
      decision: 'maybe',
    })
    assert.equal(badEnum.ok, false)
    if (!badEnum.ok) {
      assert.ok(badEnum.errors.some((e) => e.field === 'decision'))
    }
  })

  await check('CR-1d: hibalista emberi magyar szöveggé formázódik', () => {
    const contract = compileContract({
      fields: [
        { name: 'price', type: 'number', required: true, description: 'Bruttó ár' },
        { name: 'decision', type: 'enum', required: true, enumValues: ['approve', 'reject'] },
      ],
    })
    const result = validateAgainstContract(contract, { price: '', decision: 'maybe' })
    assert.equal(result.ok, false)
    if (!result.ok) {
      const text = formatContractErrors(result.errors)
      assert.ok(typeof text === 'string' && text.length > 0)
      // Közérthető: mezőnév + magyarázat, ne nyers Zod útvonal
      assert.ok(!text.includes('ZodError'))
      assert.ok(text.includes('price') || text.includes('ár') || text.includes('Ár'))
    }
  })

  await check('CR-1e: laza mód — best-effort kinyerés validáció nélkül', () => {
    const extracted = extractLoose('Előtte szöveg.\n```json\n{"a":1,"b":"x"}\n```\nUtána.')
    assert.deepEqual(extracted, { a: 1, b: 'x' })

    const none = extractLoose('nincs itt objektum')
    assert.equal(none, null)
  })

  await check('CR-1f: compileFromZod — meglévő Zod-séma contracttá fordítható', () => {
    const schema = z.object({
      answer: z.string().min(1),
      confidence: z.enum(['high', 'medium', 'low']),
    })
    const contract = compileFromZod(schema)
    assert.deepEqual(contract.fieldNames.sort(), ['answer', 'confidence'])

    const ok = validateAgainstContract(contract, { answer: 'igen', confidence: 'high' })
    assert.equal(ok.ok, true)

    const bad = validateAgainstContract(contract, { answer: '', confidence: 'high' })
    assert.equal(bad.ok, false)
  })

  // --- CR-2: szigorú mód + javítási korlátok (gateway varrat) ----------------

  function makeAuditRepo(): AuditRepository {
    const events: AuditLog[] = []
    return {
      async append(data) {
        const row = {
          id: crypto.randomUUID(),
          seq: BigInt(events.length + 1),
          prevHash: 'prev',
          hash: 'hash',
          createdAt: new Date(),
          ...data,
        } as AuditLog
        events.push(row)
        return row
      },
      async findMany() { return events },
      async findAll() { return events },
      async getActionCounts() { return {} },
    }
  }

  function makeModelCallRepo(): ModelCallRepository {
    const created: ModelCall[] = []
    return {
      async create(data) {
        const row = { id: crypto.randomUUID(), createdAt: new Date(), ...data } as ModelCall
        created.push(row)
        return row
      },
      async getCostSummary() { return { tokens: 0, cost: 0 } },
      async getUsageForAgentSince() { return { calls: 0, tokens: 0 } },
      async getUsageForTicket() { return { calls: 0, tokens: 0 } },
      async getUsageForAgent() { return { calls: 0, tokens: 0 } },
      async getUsageForTenant() { return { calls: 0, tokens: 0 } },
      async getUsageForTicketType() { return { calls: 0, tokens: 0 } },
      async getUsageByAgent() { return [] },
      async getGovernanceSummary() {
        return { calls: 0, tokens: 0, cost: 0, avgLatencyMs: 0, okCalls: 0, errorCalls: 0, rateLimitedCalls: 0 }
      },
      async getPerTicketBreakdown() { return [] },
    }
  }

  function makeGateway(provider: ModelProvider): ModelGateway {
    // 4. arg: guardrail — routingEngine nélkül a hívás a modelConfig providert használja.
    return new ModelGateway(
      makeAuditRepo(),
      makeModelCallRepo(),
      new Map([['stub', provider]]),
      { maxCallsPerTicket: 100 },
    )
  }

  const TEST_AGENT_ID = 'aaaaaaaa-bbbb-4000-8000-000000000033'

  const baseModel: ModelConfig = {
    provider: 'stub',
    model: 'stub-main',
  }

  const priceContract: CompiledContract = compileContract({
    fields: [
      { name: 'price', type: 'number', required: true },
      { name: 'vendor', type: 'string', required: true },
    ],
  })

  await check('CR-2a: érvényes első válasz → nincs javító hívás', async () => {
    let chatCalls = 0
    const provider: ModelProvider = {
      name: 'stub',
      async chat() {
        chatCalls++
        return {
          content: '{"price":100,"vendor":"Acme"}',
          usage: { promptTokens: 1, completionTokens: 1 },
          latencyMs: 1,
        }
      },
    }
    const gateway = makeGateway(provider)
    const result = await runStrictContract({
      gateway,
      contract: priceContract,
      rawContent: '{"price":100,"vendor":"Acme"}',
      modelConfig: baseModel,
      structuringModel: { provider: 'stub', model: 'stub-cheap' },
      agentId: TEST_AGENT_ID,
      criticality: 'L1',
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.value, { price: 100, vendor: 'Acme' })
      assert.equal(result.repairAttempts, 0)
    }
    assert.equal(chatCalls, 0, 'érvényes első válaszra nem szabad modellhívás')
  })

  await check('CR-2b: hibás első válasz → egy javító hívás a hibákkal, siker', async () => {
    let chatCalls = 0
    let lastUserContent = ''
    const provider: ModelProvider = {
      name: 'stub',
      async chat(input) {
        chatCalls++
        const user = [...input.messages].reverse().find((m) => m.role === 'user')
        lastUserContent = typeof user?.content === 'string' ? user.content : ''
        return {
          content: '{"price":1500,"vendor":"Acme Kft"}',
          usage: { promptTokens: 1, completionTokens: 1 },
          latencyMs: 1,
        }
      },
    }
    const gateway = makeGateway(provider)
    const result = await runStrictContract({
      gateway,
      contract: priceContract,
      rawContent: '{"price":"","vendor":""}',
      modelConfig: baseModel,
      structuringModel: { provider: 'stub', model: 'stub-cheap' },
      agentId: TEST_AGENT_ID,
      criticality: 'L1',
    })
    assert.equal(result.ok, true)
    assert.equal(chatCalls, 1)
    // Regresszió: a javító hívás megkapja a konkrét hibát (nem csak „hiányzik")
    assert.ok(
      lastUserContent.includes('price') || lastUserContent.includes('ár'),
      'javító hívásnak tartalmaznia kell a hibás mezőt',
    )
  })

  await check('CR-2c: tartósan hibás → korlát kimerül, hibás eredmény', async () => {
    let chatCalls = 0
    const provider: ModelProvider = {
      name: 'stub',
      async chat() {
        chatCalls++
        return {
          content: '{"price":"","vendor":""}',
          usage: { promptTokens: 1, completionTokens: 1 },
          latencyMs: 1,
        }
      },
    }
    const gateway = makeGateway(provider)
    const result = await runStrictContract({
      gateway,
      contract: priceContract,
      rawContent: 'nincs JSON',
      modelConfig: baseModel,
      structuringModel: { provider: 'stub', model: 'stub-cheap' },
      agentId: TEST_AGENT_ID,
      criticality: 'L1',
    })
    assert.equal(result.ok, false)
    assert.equal(chatCalls, 1, 'alapértelmezés: egy javító próba')
    if (!result.ok) {
      assert.ok(result.errors.length > 0)
      assert.equal(result.repairAttempts, 1)
    }
  })

  await check('CR-2d: L3 kritikusság → nulla javítás, azonnal hiba', async () => {
    let chatCalls = 0
    const provider: ModelProvider = {
      name: 'stub',
      async chat() {
        chatCalls++
        return {
          content: '{"price":1,"vendor":"x"}',
          usage: { promptTokens: 1, completionTokens: 1 },
          latencyMs: 1,
        }
      },
    }
    const gateway = makeGateway(provider)
    const result = await runStrictContract({
      gateway,
      contract: priceContract,
      rawContent: '{"price":"","vendor":""}',
      modelConfig: baseModel,
      structuringModel: { provider: 'stub', model: 'stub-cheap' },
      agentId: TEST_AGENT_ID,
      criticality: 'L3',
    })
    assert.equal(result.ok, false)
    assert.equal(chatCalls, 0, 'L3-nál nincs automatikus javítás')
    if (!result.ok) assert.equal(result.repairAttempts, 0)
  })

  await check('CR-2e: lépésszintű maxRepairAttempts=2 a kemény felső korláton belül', async () => {
    let chatCalls = 0
    const provider: ModelProvider = {
      name: 'stub',
      async chat() {
        chatCalls++
        return {
          content: '{"price":"","vendor":""}',
          usage: { promptTokens: 1, completionTokens: 1 },
          latencyMs: 1,
        }
      },
    }
    const gateway = makeGateway(provider)
    const result = await runStrictContract({
      gateway,
      contract: priceContract,
      rawContent: '{"price":""}',
      modelConfig: baseModel,
      structuringModel: { provider: 'stub', model: 'stub-cheap' },
      agentId: TEST_AGENT_ID,
      criticality: 'L1',
      maxRepairAttempts: 2,
    })
    assert.equal(result.ok, false)
    assert.equal(chatCalls, 2)
    if (!result.ok) assert.equal(result.repairAttempts, 2)
  })

  await check('CR-2f: maxRepairAttempts nem lépheti túl a kemény 2-es korlátot', async () => {
    let chatCalls = 0
    const provider: ModelProvider = {
      name: 'stub',
      async chat() {
        chatCalls++
        return { content: '{}', usage: { promptTokens: 1, completionTokens: 1 }, latencyMs: 1 }
      },
    }
    const gateway = makeGateway(provider)
    const result = await runStrictContract({
      gateway,
      contract: priceContract,
      rawContent: '{}',
      modelConfig: baseModel,
      structuringModel: { provider: 'stub', model: 'stub-cheap' },
      agentId: TEST_AGENT_ID,
      criticality: 'L0',
      maxRepairAttempts: 99,
    })
    assert.equal(result.ok, false)
    assert.equal(chatCalls, 2, 'kemény felső korlát: 2')
  })

  // --- CR-3: playbook compiler tipizált contract ---------------------------

  await check('CR-3a: tipizált outputContract → compiled mezők + maxRepairAttempts', () => {
    const spec = {
      schemaVersion: '1.0' as const,
      key: 'contract-demo',
      name: 'Contract demo',
      processType: 'demo',
      entryStepId: 'extract',
      criticality: 'L2' as const,
      roles: [{ key: 'worker', type: 'agent_role' as const, requiredCapabilities: [] as string[] }],
      steps: [
        {
          id: 'extract',
          name: 'Kinyeres',
          ticketType: 'extract',
          assignedRole: 'worker',
          allowedStates: ['ready', 'in_progress', 'done'],
          outputContract: {
            fields: [
              { name: 'price', type: 'number', required: true, description: 'Ar' },
              {
                name: 'decision',
                type: 'enum',
                required: true,
                enumValues: ['approve', 'reject'],
              },
            ],
            maxRepairAttempts: 2,
          },
        },
      ],
      gates: [],
      transitions: [],
    }
    const compiled = new PlaybookCompiler().compile(spec as never)
    assert.equal(compiled.criticality, 'L2')
    const rule = compiled.ticketRules.find((r) => r.stepId === 'extract')
    assert.ok(rule)
    assert.deepEqual([...(rule!.outputRequiredFields)].sort(), ['decision', 'price'])
    assert.equal(rule!.maxRepairAttempts, 2)
    assert.ok(rule!.outputContractFields?.some((f) => f.name === 'price' && f.type === 'number'))
    assert.ok(rule!.outputContractFields?.some((f) => f.name === 'decision' && f.type === 'enum'))
  })

  await check('CR-3b: legacy requiredFields szigorúan fordítható (üres fennakad)', () => {
    const spec = {
      schemaVersion: '1.0' as const,
      key: 'legacy',
      name: 'Legacy',
      processType: 'demo',
      entryStepId: 's1',
      roles: [{ key: 'worker', type: 'agent_role' as const, requiredCapabilities: [] as string[] }],
      steps: [
        {
          id: 's1',
          name: 'S1',
          ticketType: 't',
          assignedRole: 'worker',
          outputContract: { requiredFields: ['vendor', 'price'] },
        },
      ],
      gates: [],
      transitions: [],
    }
    const compiled = new PlaybookCompiler().compile(spec as never)
    const rule = compiled.ticketRules[0]!
    assert.deepEqual([...(rule.outputRequiredFields)].sort(), ['price', 'vendor'])
    const contract = compileContract({ requiredFields: rule.outputRequiredFields })
    const empty = validateAgainstContract(contract, { vendor: '', price: '1' })
    assert.equal(empty.ok, false)
  })

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failure(s)`)
  process.exit(failures > 0 ? 1 : 0)
}

main()
