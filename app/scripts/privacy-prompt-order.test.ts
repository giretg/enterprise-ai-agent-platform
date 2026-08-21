/**
 * APG-12 — végrehajtási sorrend: privacy transform előbb, osztályozó a maradékon.
 *
 * DoD: a meglévő sensitivity-viselkedés (blokk, helyi-kényszer, override) megmarad;
 * pszeudonimizált e-mail után a beszélgetés `clean` marad és külső modellen fut.
 *
 * Futtatás: npm run test:prompt-privacy-transform
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GatewaySensitivityError,
  ModelGateway,
  GatewayBudgetError,
  type AgentSensitivityPolicyReader,
  type ModelProvider,
} from '../src/domain/gateway/model-gateway'
import { classifyPrompt } from '../src/domain/gateway/sensitivity-router'
import {
  actionForPrivacyCategory,
  resolvePrivacyCategoryPolicy,
  type PrivacyCategoryAction,
} from '../src/domain/privacy/privacy-category-policy'
import { assembleGatewayMessages } from '../src/domain/agent/prompt-assembler'
import { transformPromptMessages } from '../src/domain/privacy/prompt-privacy-transform'
import { SurrogateEngine, type PrivacyAuditSink } from '../src/domain/privacy/surrogate-engine'
import {
  computeSurrogateHmac,
  insertRefsSequentially,
  SurrogateTakenError,
  verifySurrogateHmac,
  type InsertRefInput,
  type PrivacyScope,
  type RefEntityRef,
  type RefVaultRecord,
  type SurrogateHmacFields,
  type SurrogateVault,
  type VaultLookup,
} from '../src/domain/privacy/surrogate-vault'
import { valVaultMethodStubs } from './test-surrogate-vault-val-stubs'
import { formatSurrogate, parseSurrogate } from '../src/domain/privacy/surrogate-format'
import type { AuditRepository, ModelCallRepository } from '../src/repositories/interfaces'
import type { AuditLog, ModelCall } from '@prisma/client'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001'
const AGENT = 'aaaaaaaa-bbbb-4000-8000-000000000002'
const CONVERSATION = 'eeeeeeee-0000-4000-8000-000000000005'
const HMAC_KEY = 'test-tenant-hmac-key'
const EMAIL = 'ada.lovelace@spar.hu'
const PAN = '4111111111111111'
const TAJ = '123-456-789'

type AuditEvent =
  | Parameters<PrivacyAuditSink['recordUnknownSurrogate']>[0]
  | Parameters<PrivacyAuditSink['recordResolveDenied']>[0]

class RecordingAudit implements PrivacyAuditSink {
  readonly events: AuditEvent[] = []
  async recordUnknownSurrogate(event: Parameters<PrivacyAuditSink['recordUnknownSurrogate']>[0]): Promise<void> {
    this.events.push(event)
  }
  async recordResolveDenied(event: Parameters<PrivacyAuditSink['recordResolveDenied']>[0]): Promise<void> {
    this.events.push(event)
  }
}

class InMemorySurrogateVault implements SurrogateVault {
  readonly rows: RefVaultRecord[] = []

  constructor(private readonly resolveTenantKey: (tenantId: string) => string) {}

  private lookup(row: RefVaultRecord | undefined): VaultLookup {
    if (!row) return { status: 'miss' }
    const fields: SurrogateHmacFields = {
      tenantId: row.tenantId,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      entityType: row.entityType,
      surrogate: row.surrogate,
      class: row.class,
      connectorId: row.connectorId,
      sourceId: row.sourceId,
    }
    if (!verifySurrogateHmac(this.resolveTenantKey(row.tenantId), fields, row.hmac)) {
      return { status: 'tampered' }
    }
    return { status: 'hit', record: row }
  }

  async findByEntity(
    tenantId: string,
    scope: PrivacyScope,
    entity: RefEntityRef,
  ): Promise<VaultLookup> {
    return this.lookup(
      this.rows.find(
        (row) =>
          row.tenantId === tenantId &&
          row.scopeType === scope.type &&
          row.scopeId === scope.id &&
          row.entityType === entity.entityType &&
          row.connectorId === entity.connectorId &&
          row.sourceId === entity.sourceId,
      ),
    )
  }

  async findBySurrogate(
    tenantId: string,
    scope: PrivacyScope,
    surrogate: string,
  ): Promise<VaultLookup> {
    return this.lookup(
      this.rows.find(
        (row) =>
          row.tenantId === tenantId &&
          row.scopeType === scope.type &&
          row.scopeId === scope.id &&
          row.surrogate === surrogate,
      ),
    )
  }

  async findHitsBySurrogateInTenant(tenantId: string, surrogate: string): Promise<RefVaultRecord[]> {
    const hits: RefVaultRecord[] = []
    for (const row of this.rows) {
      if (row.tenantId !== tenantId || row.surrogate !== surrogate) continue
      const result = this.lookup(row)
      if (result.status === 'hit') hits.push(result.record)
    }
    return hits
  }

  async maxOrdinal(tenantId: string, scope: PrivacyScope, entityType: string): Promise<number> {
    let max = 0
    for (const row of this.rows) {
      if (row.tenantId !== tenantId || row.scopeType !== scope.type || row.scopeId !== scope.id) continue
      const parsed = parseSurrogate(row.surrogate)
      if (parsed && parsed.entityType === entityType && parsed.ordinal > max) max = parsed.ordinal
    }
    return max
  }

  async insertRef(input: InsertRefInput): Promise<RefVaultRecord> {
    const entityHit = this.rows.find(
      (row) =>
        row.tenantId === input.tenantId &&
        row.scopeType === input.scope.type &&
        row.scopeId === input.scope.id &&
        row.entityType === input.entityType &&
        row.connectorId === input.connectorId &&
        row.sourceId === input.sourceId,
    )
    if (entityHit) return entityHit
    const surrogateHit = this.rows.find(
      (row) =>
        row.tenantId === input.tenantId &&
        row.scopeType === input.scope.type &&
        row.scopeId === input.scope.id &&
        row.surrogate === input.surrogate,
    )
    if (surrogateHit) throw new SurrogateTakenError(input.surrogate)
    const fields: SurrogateHmacFields = {
      tenantId: input.tenantId,
      scopeType: input.scope.type,
      scopeId: input.scope.id,
      entityType: input.entityType,
      surrogate: input.surrogate,
      class: 'ref',
      connectorId: input.connectorId,
      sourceId: input.sourceId,
    }
    const record: RefVaultRecord = {
      ...fields,
      id: randomUUID(),
      hmac: computeSurrogateHmac(this.resolveTenantKey(input.tenantId), fields),
    }
    this.rows.push(record)
    return record
  }

  async listByScope(tenantId: string, scope: PrivacyScope): Promise<RefVaultRecord[]> {
    const hits: RefVaultRecord[] = []
    for (const row of this.rows) {
      if (row.tenantId !== tenantId || row.scopeType !== scope.type || row.scopeId !== scope.id) continue
      const result = this.lookup(row)
      if (result.status === 'hit') hits.push(result.record)
    }
    return hits
  }

  async insertRefs(inputs: InsertRefInput[]): Promise<RefVaultRecord[]> {
    return insertRefsSequentially((input) => this.insertRef(input), inputs)
  }

  findValByFingerprint = valVaultMethodStubs.findValByFingerprint
  findValBySurrogate = valVaultMethodStubs.findValBySurrogate
  insertVal = valVaultMethodStubs.insertVal
}

function makeEngine() {
  const vault = new InMemorySurrogateVault(() => HMAC_KEY)
  const engine = new SurrogateEngine(vault, new RecordingAudit())
  engine.allocateVals = async (inputs) => {
    const ordinals = new Map<string, number>()
    return inputs.map((input) => {
      const next = (ordinals.get(input.entityType) ?? 0) + 1
      ordinals.set(input.entityType, next)
      return formatSurrogate(input.entityType, next)
    })
  }
  return engine
}

function tokenizeEmailPolicy() {
  return resolvePrivacyCategoryPolicy({
    agent: {
      categories: { email: 'tokenize' },
      custom: {},
      updatedById: null,
      updatedAt: null,
    },
  })
}

function makeAuditRepo(): { repo: AuditRepository; events: AuditLog[] } {
  const events: AuditLog[] = []
  const repo: AuditRepository = {
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
  return { repo, events }
}

function makeModelCallRepo(): ModelCallRepository {
  return {
    async create(data) {
      return { id: crypto.randomUUID(), createdAt: new Date(), ...data } as ModelCall
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

function categoryPolicy(actionFor: (category: string) => PrivacyCategoryAction): AgentSensitivityPolicyReader {
  return {
    async allowsSensitiveExternalModel() { return false },
    async actionForCategory(_agentId, category) { return actionFor(category) },
  }
}

function wiredGateway(input: {
  mode: 'off' | 'observe' | 'enforce'
  actionFor: (category: string) => PrivacyCategoryAction
  capture: { messages: unknown; provider: string; n: number }
  localAvailable?: boolean
  sensitivityMode?: 'off' | 'observe' | 'enforce'
}) {
  const { repo: auditRepo } = makeAuditRepo()
  const providers = new Map<string, ModelProvider>([
    [
      'chatgpt-oauth',
      {
        name: 'chatgpt-oauth',
        async chat(req) {
          input.capture.messages = req.messages
          input.capture.provider = 'chatgpt-oauth'
          input.capture.n += 1
          return { content: 'külső', latencyMs: 1 }
        },
      },
    ],
    [
      'ollama',
      {
        name: 'ollama',
        async chat(req) {
          input.capture.messages = req.messages
          input.capture.provider = 'ollama'
          input.capture.n += 1
          return { content: 'lokális', latencyMs: 1 }
        },
      },
    ],
  ])
  const gw = new ModelGateway(
    auditRepo,
    makeModelCallRepo(),
    providers,
    { maxCallsPerTicket: 30 },
    undefined,
    undefined,
    {
      enforceLocalForSensitive: true,
      localProvider: 'ollama',
      localModel: 'gemma-local',
      localModelAvailable: input.localAvailable ?? false,
    },
    undefined,
    categoryPolicy(input.actionFor),
  )
  gw.setPrivacyEngine(makeEngine())
  gw.setPrivacyModeResolver(async () => input.mode)
  gw.setSensitivityModeResolver(async () => input.sensitivityMode ?? 'enforce')
  return gw
}

async function main() {
  console.log('APG-12 privacy transform előbb, osztályozó a maradékon\n')

  const scope: PrivacyScope = { type: 'conversation', id: CONVERSATION }

  await test('D6: szabad szöveges e-mail nem kap automatikus álnevet (forrás felel)', async () => {
    const original = [{ role: 'user' as const, content: `Írj a ${EMAIL} címre` }]
    const result = await transformPromptMessages({
      messages: original,
      mode: 'enforce',
      policy: tokenizeEmailPolicy(),
      engine: makeEngine(),
      tenantId: TENANT,
      scope,
    })
    assert.equal(result.applied, false)
    assert.equal(result.messages[0]?.content?.includes(EMAIL), true)
    assert.equal(original[0]?.content?.includes(EMAIL), true, 'a nyers üzenetet nem szabad mutálni')
    const decision = classifyPrompt(result.messages)
    assert.equal(decision.level, 'sensitive')
  })

  await test('produkciós prompt-út known-value cserét végez a strukturált mező értékén', async () => {
    const engine = makeEngine()
    const company = 'SPAR Magyarország Kereskedelmi Kft.'
    await engine.allocateRef({
      tenantId: TENANT,
      scope,
      entityType: 'company',
      connectorId: randomUUID(),
      sourceId: 'crm/company/4821',
      displayValue: company,
      displayValueSource: 'structured_field',
    })
    const result = await transformPromptMessages({
      messages: [{ role: 'user', content: `Készíts riportot erről: ${company}` }],
      mode: 'enforce',
      policy: tokenizeEmailPolicy(),
      engine,
      tenantId: TENANT,
      scope,
    })
    assert.equal(result.applied, true)
    assert.equal(result.messages[0]?.content?.includes(company), false)
    assert.equal(result.messages[0]?.content?.includes('[[COMPANY_1]]'), true)
  })

  await test('known-value nem cserél e-mail címet, ha nincs strukturált jelölés', async () => {
    const engine = makeEngine()
    await engine.allocateRef({
      tenantId: TENANT,
      scope,
      entityType: 'company',
      connectorId: randomUUID(),
      sourceId: 'crm/company/spar',
      displayValue: 'SPAR',
      displayValueSource: 'structured_field',
    })
    const result = await transformPromptMessages({
      messages: [{ role: 'user', content: `Kapcsolat: ${EMAIL}` }],
      mode: 'enforce',
      policy: tokenizeEmailPolicy(),
      engine,
      tenantId: TENANT,
      scope,
    })
    assert.equal(result.messages[0]?.content, `Kapcsolat: ${EMAIL}`)
  })

  await test('produkciós prompt-út: ragozott known-value (SPAR-nak)', async () => {
    const engine = makeEngine()
    const company = 'SPAR Magyarország Kft.'
    await engine.allocateRef({
      tenantId: TENANT,
      scope,
      entityType: 'company',
      connectorId: randomUUID(),
      sourceId: 'crm/company/4821',
      displayValue: company,
      displayValueSource: 'structured_field',
    })
    const result = await transformPromptMessages({
      messages: [{ role: 'user', content: 'Küldjük a SPAR-nak a havi riportot.' }],
      mode: 'enforce',
      policy: tokenizeEmailPolicy(),
      engine,
      tenantId: TENANT,
      scope,
    })
    assert.equal(result.applied, true)
    assert.equal(result.messages[0]?.content?.includes('SPAR-nak'), false)
    assert.equal(result.messages[0]?.content?.includes('[[COMPANY_1]]'), true)
  })

  await test('OBSERVE: nem cserél, classify továbbra is sensitive', async () => {
    const result = await transformPromptMessages({
      messages: [{ role: 'user', content: `Írj a ${EMAIL} címre` }],
      mode: 'observe',
      policy: tokenizeEmailPolicy(),
      engine: makeEngine(),
      tenantId: TENANT,
      scope,
    })
    assert.equal(result.applied, false)
    assert.equal(result.spans.length, 0)
    assert.equal(result.messages[0]?.content?.includes(EMAIL), true)
    assert.equal(classifyPrompt(result.messages).level, 'sensitive')
  })

  await test('szabad szöveges e-mail + PAN: mindkettő nyers marad, classify forbidden', async () => {
    const result = await transformPromptMessages({
      messages: [{ role: 'user', content: `Írj a ${EMAIL} címre, kártya: ${PAN}` }],
      mode: 'enforce',
      policy: tokenizeEmailPolicy(),
      engine: makeEngine(),
      tenantId: TENANT,
      scope,
    })
    assert.equal(result.messages[0]?.content?.includes(EMAIL), true)
    assert.equal(result.messages[0]?.content?.includes(PAN), true)
    assert.equal(classifyPrompt(result.messages).level, 'forbidden')
  })

  await test('gateway: nyers e-mail → sensitivity local_only / fail-closed', async () => {
    const capture = { messages: [] as unknown, provider: '', n: 0 }
    const policy = tokenizeEmailPolicy()
    const gw = wiredGateway({
      mode: 'enforce',
      actionFor: (category) => actionForPrivacyCategory(policy, category),
      capture,
    })
    const original = [
      { role: 'user' as const, content: `Írj a ${EMAIL} címre` },
      { role: 'assistant' as const, content: 'Rendben.' },
      { role: 'user' as const, content: 'Küldd el, köszi.' },
    ]
    await assert.rejects(
      () =>
        gw.call({
          agentId: AGENT,
          tenantId: TENANT,
          conversationId: CONVERSATION,
          messages: original,
          modelConfig: { provider: 'chatgpt-oauth', model: 'chatgpt-oauth-default' },
        }),
      (err: unknown) => err instanceof Error && /helyi modell|sensitivity/i.test(err.message),
    )
    assert.equal(capture.n, 0)
    assert.equal(original[0]?.content.includes(EMAIL), true, 'a hívó nyers előzménye megmarad')
  })

  await test('privacy OBSERVE + sensitivity ENFORCE: e-mail / adószám továbbra is fail-closed', async () => {
    const capture = { messages: [] as unknown, provider: '', n: 0 }
    const gw = wiredGateway({
      mode: 'observe',
      sensitivityMode: 'enforce',
      actionFor: (category) => actionForPrivacyCategory(resolvePrivacyCategoryPolicy({}), category),
      capture,
    })
    await assert.rejects(
      () =>
        gw.call({
          agentId: AGENT,
          tenantId: TENANT,
          conversationId: CONVERSATION,
          messages: [{ role: 'user', content: `Írj a ${EMAIL} címre, adószám: 12345678-1-42` }],
          modelConfig: { provider: 'chatgpt-oauth', model: 'chatgpt-oauth-default' },
        }),
      (err: unknown) => err instanceof Error && /helyi modell|sensitivity/i.test(err.message),
    )
    assert.equal(capture.n, 0)
  })

  await test('sensitivity OBSERVE: a mintaszűrő nem állítja meg a hívást', async () => {
    const capture = { messages: [] as unknown, provider: '', n: 0 }
    const gw = wiredGateway({
      mode: 'enforce',
      sensitivityMode: 'observe',
      actionFor: (category) => actionForPrivacyCategory(resolvePrivacyCategoryPolicy({}), category),
      capture,
    })
    const result = await gw.call({
      agentId: AGENT,
      tenantId: TENANT,
      conversationId: CONVERSATION,
      messages: [{ role: 'user', content: `Írj a ${EMAIL} címre, adószám: 12345678-1-42` }],
      modelConfig: { provider: 'chatgpt-oauth', model: 'chatgpt-oauth-default' },
    })
    assert.equal(result.provider, 'chatgpt-oauth')
    assert.equal(capture.n, 1)
    const sent = JSON.stringify(capture.messages)
    assert.equal(sent.includes(EMAIL), true, 'tokenize nincs e-mailre default local_only mellett')
    assert.equal(sent.includes('12345678-1-42'), true)
  })

  await test('sensitivity OBSERVE: forbidden (PAN) sem állítja meg a hívást', async () => {
    const capture = { messages: [] as unknown, provider: '', n: 0 }
    const gw = wiredGateway({
      mode: 'observe',
      sensitivityMode: 'observe',
      actionFor: (category) => actionForPrivacyCategory(resolvePrivacyCategoryPolicy({}), category),
      capture,
    })
    const result = await gw.call({
      agentId: AGENT,
      tenantId: TENANT,
      conversationId: CONVERSATION,
      messages: [{ role: 'user', content: `A kártyám: ${PAN}` }],
      modelConfig: { provider: 'chatgpt-oauth', model: 'chatgpt-oauth-default' },
    })
    assert.equal(result.provider, 'chatgpt-oauth')
    assert.equal(capture.n, 1)
  })

  await test('privacy OBSERVE + sensitivity ENFORCE: PAN továbbra is tilt', async () => {
    const capture = { messages: [] as unknown, provider: '', n: 0 }
    const gw = wiredGateway({
      mode: 'observe',
      sensitivityMode: 'enforce',
      actionFor: (category) => actionForPrivacyCategory(resolvePrivacyCategoryPolicy({}), category),
      capture,
    })
    await assert.rejects(
      () =>
        gw.call({
          agentId: AGENT,
          tenantId: TENANT,
          conversationId: CONVERSATION,
          messages: [{ role: 'user', content: `A kártyám: ${PAN}` }],
          modelConfig: { provider: 'chatgpt-oauth', model: 'chatgpt-oauth-default' },
        }),
      (err: unknown) => err instanceof Error,
    )
    assert.equal(capture.n, 0)
  })

  await test('gateway regresszió: default email local_only továbbra is helyi-kényszer / fail-closed', async () => {
    const capture = { messages: [] as unknown, provider: '', n: 0 }
    const gw = wiredGateway({
      mode: 'enforce',
      actionFor: (category) => actionForPrivacyCategory(resolvePrivacyCategoryPolicy({}), category),
      capture,
    })
    await assert.rejects(
      () => gw.call({
        agentId: AGENT,
        tenantId: TENANT,
        conversationId: CONVERSATION,
        messages: [{ role: 'user', content: `Írj a ${EMAIL} címre` }],
        modelConfig: { provider: 'chatgpt-oauth', model: 'chatgpt-oauth-default' },
      }),
      (e: unknown) => e instanceof GatewaySensitivityError && e.reason === 'local_model_unavailable',
    )
    assert.equal(capture.n, 0)
  })

  await test('gateway regresszió: PAN továbbra is blokk', async () => {
    const capture = { messages: [] as unknown, provider: '', n: 0 }
    const policy = tokenizeEmailPolicy()
    const gw = wiredGateway({
      mode: 'enforce',
      actionFor: (category) => actionForPrivacyCategory(policy, category),
      capture,
    })
    await assert.rejects(
      () => gw.call({
        agentId: AGENT,
        tenantId: TENANT,
        conversationId: CONVERSATION,
        messages: [{ role: 'user', content: `A kártyám: ${PAN}` }],
        modelConfig: { provider: 'chatgpt-oauth', model: 'chatgpt-oauth-default' },
      }),
      (e: unknown) => e instanceof GatewayBudgetError,
    )
    assert.equal(capture.n, 0)
  })

  await test('gateway regresszió: sensitive TAJ helyi modellre kényszerül (e-mail nyers marad)', async () => {
    const capture = { messages: [] as unknown, provider: '', n: 0 }
    const policy = tokenizeEmailPolicy()
    const gw = wiredGateway({
      mode: 'enforce',
      actionFor: (category) => actionForPrivacyCategory(policy, category),
      capture,
      localAvailable: true,
    })
    const result = await gw.call({
      agentId: AGENT,
      tenantId: TENANT,
      conversationId: CONVERSATION,
      messages: [{ role: 'user', content: `Írj a ${EMAIL} címre, TAJ: ${TAJ}` }],
      modelConfig: { provider: 'chatgpt-oauth', model: 'chatgpt-oauth-default' },
    })
    assert.equal(result.provider, 'ollama')
    assert.equal(capture.provider, 'ollama')
    const sent = JSON.stringify(capture.messages)
    assert.equal(sent.includes(EMAIL), true)
    assert.equal(sent.includes(TAJ), true)
  })

  await test('APG-20: memória-chunk email nyers marad known-value nélkül (D6)', async () => {
    const messages = assembleGatewayMessages({
      stablePreamble: [{ role: 'system', content: 'agent system prompt' }],
      stablePostamble: [{ role: 'system', content: 'memória capture-policy' }],
      variableContext: [
        { role: 'system', content: `Project memory context (projekt: demo):\n- contact: ${EMAIL}` },
      ],
      history: [{ role: 'user', content: 'Mi van a memóriában?' }],
    })
    const result = await transformPromptMessages({
      messages,
      mode: 'enforce',
      policy: tokenizeEmailPolicy(),
      engine: makeEngine(),
      tenantId: TENANT,
      scope,
    })
    const memoryMsg = result.messages.find((m) => m.content?.includes('Project memory context'))
    assert.ok(memoryMsg, 'memória-blokk megmarad')
    assert.equal(memoryMsg.content?.includes(EMAIL), true)
    assert.equal(result.applied, false)
  })

  await test('APG-20: stabil system prefix (cache-határig) email → változatlan', async () => {
    const messages = assembleGatewayMessages({
      stablePreamble: [{ role: 'system', content: `agent prompt with ${EMAIL}` }],
      stablePostamble: [{ role: 'system', content: 'memória capture-policy' }],
      variableContext: [{ role: 'system', content: 'Project memory context: nincs PII' }],
      history: [{ role: 'user', content: 'kérdés' }],
    })
    const result = await transformPromptMessages({
      messages,
      mode: 'enforce',
      policy: tokenizeEmailPolicy(),
      engine: makeEngine(),
      tenantId: TENANT,
      scope,
    })
    const stable = result.messages.find((m) => m.content?.includes('agent prompt'))
    assert.ok(stable)
    assert.equal(stable.content?.includes(EMAIL), true, 'cache-elt prefix érintetlen')
    assert.equal(result.applied, false)
  })

  await test('gateway APG-20: memória-chunk system email nem tokenizálódik (D6)', async () => {
    const capture = { messages: [] as unknown, provider: '', n: 0 }
    const policy = tokenizeEmailPolicy()
    const gw = wiredGateway({
      mode: 'enforce',
      actionFor: (category) => actionForPrivacyCategory(policy, category),
      capture,
    })
    const messages = assembleGatewayMessages({
      stablePreamble: [{ role: 'system', content: 'agent system prompt' }],
      stablePostamble: [{ role: 'system', content: 'memória capture-policy' }],
      variableContext: [
        { role: 'system', content: `Project memory context (projekt: demo):\n- contact: ${EMAIL}` },
      ],
      history: [{ role: 'user', content: 'Mi van a memóriában?' }],
    })
    await gw.call({
      agentId: AGENT,
      tenantId: TENANT,
      conversationId: CONVERSATION,
      messages,
      modelConfig: { provider: 'chatgpt-oauth', model: 'chatgpt-oauth-default' },
    })
    const sent = JSON.stringify(capture.messages)
    assert.equal(sent.includes(EMAIL), true, 'system memória-chunk known-value nélkül nyers marad')
    assert.equal(sent.includes('[[EMAIL_1]]'), false)
  })

  await test('gateway regresszió: forbidden human override továbbra is kimehet', async () => {
    const capture = { messages: [] as unknown, provider: '', n: 0 }
    const gw = wiredGateway({
      mode: 'enforce',
      actionFor: (category) => actionForPrivacyCategory(resolvePrivacyCategoryPolicy({}), category),
      capture,
    })
    const result = await gw.call({
      agentId: AGENT,
      tenantId: TENANT,
      conversationId: CONVERSATION,
      messages: [{ role: 'user', content: `X-Api-Key: pn_live_A7f9K2mQ8zR4tY6uP0sD3vN1wX5cB8` }],
      modelConfig: { provider: 'chatgpt-oauth', model: 'chatgpt-oauth-default' },
      sensitivityOverride: {
        reviewedByUserId: 'admin-1',
        allowedForbiddenCategories: ['secret_key'],
        reason: 'admin confirmed documentation sample',
      },
    })
    assert.equal(result.provider, 'chatgpt-oauth')
    assert.equal(capture.n, 1)
  })

  await test('APG-20: bookkeeper beszélgetés-scope-ot visz a gateway.call-ba', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const src = readFileSync(join(root, 'src/domain/agent/bookkeeper-runtime.ts'), 'utf8')
    assert.match(src, /createConversation\(/)
    assert.match(src, /conversationId:\s*conversation\.id/)
    assert.match(src, /assembleGatewayMessages\(/)
    assert.match(src, /memoryContextSystemMessages/)
  })

  await test('APG-20: wiki forrásrészlet a cache-határ utáni variableContextben van', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const src = readFileSync(join(root, 'src/domain/agent/wiki-runtime.ts'), 'utf8')
    assert.match(src, /assembleGatewayMessages\(/)
    assert.match(src, /Forrásrészletek/)
    assert.match(src, /variableContext:/)
  })

  console.log(`\n${failures === 0 ? 'Minden teszt zöld' : `${failures} teszt elbukott`}`)
  if (failures > 0) process.exit(1)
}

void main()
