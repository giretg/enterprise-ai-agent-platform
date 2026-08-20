/**
 * Privacy-eval futtató (APG-23) — a hét metrika számítása fixture-ökön.
 *
 * DB és élő modell nélkül fut; a meglévő privacy transzformációkat hívja.
 */
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'

import { OSTOROSBOR_CRM_PRIVACY_FIELDS } from '@/domain/privacy/connector-privacy'
import {
  actionForPrivacyCategory,
  DEFAULT_PRIVACY_CATEGORY_POLICY,
  resolvePrivacyCategoryPolicy,
} from '@/domain/privacy/privacy-category-policy'
import { transformPromptMessages } from '@/domain/privacy/prompt-privacy-transform'
import { SurrogateEngine, type PrivacyAuditSink } from '@/domain/privacy/surrogate-engine'
import { resolveDisplayText } from '@/domain/privacy/resolve-display-text'
import { StreamingSurrogateResolver } from '@/domain/privacy/streaming-surrogate-resolver'
import { transformStructuredOutput } from '@/domain/privacy/structured-output-transform'
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
} from '@/domain/privacy/surrogate-vault'
import { parseSurrogate, findEmbeddedSurrogates } from '@/domain/privacy/surrogate-format'
import { buildPrivacyAwareOutcomeChannels } from '@/domain/tool-broker/tool-output-privacy'
import { substituteKnownValuesInText } from '@/domain/privacy/known-value-substitution'

import {
  buildPrivacyEvalReport,
  computeFalsePositiveRate,
  computeQualityDegradation,
  computeRecall,
  computeWorkflowFailureDelta,
  metricPasses,
  percentile,
  runGoldenAssertions,
  type PrivacyEvalReport,
  type PrivacyMetricResult,
} from './privacy-eval'
import {
  FALSE_POSITIVE_EVAL_CASES,
  FREE_TEXT_EVAL_CASES,
  KNOWN_SURROGATES,
  MODEL_OUTPUT_SAMPLES,
  QUALITY_EVAL_CASES,
  STRUCTURED_EVAL_CASES,
  WORKFLOW_EVAL_CASES,
} from './privacy-eval-fixtures'

const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001'
const CONNECTOR = 'dddddddd-0000-4000-8000-000000000004'
const CONVERSATION = 'eeeeeeee-0000-4000-8000-000000000005'
const HMAC_KEY = 'test-tenant-hmac-key'

class SilentAudit implements PrivacyAuditSink {
  async recordUnknownSurrogate(): Promise<void> {}
  async recordResolveDenied(): Promise<void> {}
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
      if (row.tenantId !== tenantId || row.scopeType !== scope.type || row.scopeId !== scope.id) {
        continue
      }
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

  async findValByFingerprint(): Promise<import('@/domain/privacy/surrogate-vault').ValVaultLookup> {
    return { status: 'miss' }
  }

  async findValBySurrogate(): Promise<import('@/domain/privacy/surrogate-vault').ValVaultLookup> {
    return { status: 'miss' }
  }

  async insertVal(): Promise<import('@/domain/privacy/surrogate-vault').ValVaultRecord> {
    throw new Error('val vault stub')
  }
}

function setup() {
  const vault = new InMemorySurrogateVault(() => HMAC_KEY)
  const engine = new SurrogateEngine(vault, new SilentAudit())
  const scope: PrivacyScope = { type: 'conversation', id: CONVERSATION }
  return { vault, engine, scope }
}

function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.')
  let cur: unknown = obj
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    const key = /^\d+$/.test(part) ? Number(part) : part
    cur = (cur as Record<string | number, unknown>)[key]
  }
  return cur
}

function isSurrogateValue(value: unknown): boolean {
  return typeof value === 'string' && parseSurrogate(value) !== null
}

async function measureStructuredRecall(): Promise<PrivacyMetricResult> {
  let covered = 0
  let total = 0
  const evidence: string[] = []

  for (const fixture of STRUCTURED_EVAL_CASES) {
    const { engine, scope } = setup()
    const result = await transformStructuredOutput({
      output: fixture.output,
      fields: fixture.fields,
      engine,
      tenantId: TENANT,
      connectorId: CONNECTOR,
      scope,
      apply: true,
    })
    for (const path of fixture.expectTokenized) {
      total += 1
      const value = getByPath(result.output, path)
      if (isSurrogateValue(value)) {
        covered += 1
      } else {
        evidence.push(`${fixture.id}/${path}: nem kapta az álnevet (${String(value)})`)
      }
    }
    for (const path of fixture.expectRaw) {
      const raw = getByPath(fixture.output, path)
      const actual = getByPath(result.output, path)
      if (JSON.stringify(raw) !== JSON.stringify(actual)) {
        evidence.push(`${fixture.id}/${path}: nyers mező megváltozott`)
      }
    }
  }

  const value = computeRecall(covered, total)
  return {
    id: 'structured_recall',
    value,
    passed: metricPasses('structured_recall', value),
    detail: `${covered}/${total} jelölt mező kapott álnevet`,
    evidence,
  }
}

/** Eval-policy: a mintavételezéshez e-mail és adószám is tokenize (a router felismeri). */
const PRIVACY_EVAL_POLICY = resolvePrivacyCategoryPolicy({
  platform: {
    categories: {
      email: 'tokenize',
      adoszam: 'tokenize',
    },
    custom: {},
    patternSetVersion: 1,
    updatedById: null,
    updatedAt: null,
  },
})

async function measureFreeTextRecall(): Promise<PrivacyMetricResult> {
  let covered = 0
  let total = 0
  const evidence: string[] = []

  for (const fixture of FREE_TEXT_EVAL_CASES) {
    if (fixture.source === 'known_value') {
      const result = await substituteKnownValuesInText({
        text: fixture.text,
        replacements: fixture.replacements ?? [],
        mode: 'enforce',
      })
      for (const span of fixture.spans) {
        total += 1
        const tokenized = !result.text.includes(span.value) && result.text.includes('[[')
        if (tokenized) {
          covered += 1
        } else {
          evidence.push(`${fixture.id}: "${span.value}" nem lett lecserélve`)
        }
      }
      continue
    }

    const { engine, scope } = setup()
    const result = await transformPromptMessages({
      messages: [{ role: 'user', content: fixture.text }],
      mode: 'enforce',
      policy: PRIVACY_EVAL_POLICY,
      engine,
      tenantId: TENANT,
      scope,
    })
    const transformed = result.messages[0]?.content ?? ''
    for (const span of fixture.spans) {
      const action = actionForPrivacyCategory(PRIVACY_EVAL_POLICY, span.entityType)
      if (action !== 'tokenize') continue
      total += 1
      const tokenized =
        !transformed.includes(span.value) &&
        (transformed.includes('[[') || result.spans.some((s) => s.entityType === span.entityType))
      if (tokenized) {
        covered += 1
      } else {
        evidence.push(`${fixture.id}: "${span.value}" nem lett tokenizálva`)
      }
    }
  }

  const value = computeRecall(covered, total)
  return {
    id: 'free_text_recall',
    value,
    passed: metricPasses('free_text_recall', value),
    detail: `${covered}/${total} címkézett span lett lefedve ENFORCE-ban`,
    evidence,
  }
}

async function measureFalsePositiveRate(): Promise<PrivacyMetricResult> {
  const policy = resolvePrivacyCategoryPolicy({})
  let falsePositives = 0
  const evidence: string[] = []

  for (const fixture of FALSE_POSITIVE_EVAL_CASES) {
    const { engine, scope } = setup()
    const before = fixture.text
    const result = await transformPromptMessages({
      messages: [{ role: 'user', content: before }],
      mode: 'enforce',
      policy,
      engine,
      tenantId: TENANT,
      scope,
    })
    const after = result.messages[0]?.content ?? before
    if (result.applied && after !== before) {
      falsePositives += 1
      evidence.push(`${fixture.id}: téves tokenizálás`)
    }
  }

  const value = computeFalsePositiveRate(falsePositives, FALSE_POSITIVE_EVAL_CASES.length)
  return {
    id: 'false_positive_rate',
    value,
    passed: metricPasses('false_positive_rate', value),
    detail: `${falsePositives}/${FALSE_POSITIVE_EVAL_CASES.length} nem-védendő szöveg lett tévesen tokenizálva`,
    evidence,
  }
}

async function measureLatencyP95(): Promise<PrivacyMetricResult> {
  const CRM_FIELDS = {
    ...OSTOROSBOR_CRM_PRIVACY_FIELDS,
    email: {
      type: 'string' as const,
      privacy: 'tokenize' as const,
      entity_type: 'email' as const,
      source_id: 'crm/email/{id}',
    },
  }
  const body: Array<{ id: number; company_name: string; email: string }> = []
  for (let i = 1; i <= 200; i += 1) {
    body.push({
      id: i,
      company_name: `Cég ${String(i).padStart(4, '0')} Kft.`,
      email: `u${i}@example.hu`,
    })
  }
  const payload = { ok: true as const, status: 200, body }

  const roundMs: number[] = []
  for (let i = 0; i < 12; i += 1) {
    const { engine } = setup()
    const scope: PrivacyScope = { type: 'conversation', id: `${CONVERSATION}-${i}` }
    const started = performance.now()
    await buildPrivacyAwareOutcomeChannels({
      tool: 'http_api_get',
      trust: 'external_untrusted',
      output: payload,
      contract: undefined,
      sideEffecting: false,
      connector: { id: CONNECTOR, tenantId: TENANT, config: { fields: CRM_FIELDS } },
      conversationId: scope.id,
      actingTenantId: TENANT,
      engine,
      mode: 'enforce',
    })
    roundMs.push(performance.now() - started)
  }

  const value = percentile(roundMs, 95)
  return {
    id: 'latency_p95_ms',
    value,
    passed: metricPasses('latency_p95_ms', value),
    detail: `p95 forduló-overhead: ${value.toFixed(1)} ms (${roundMs.length} mérés)`,
  }
}

async function measureWorkflowFailureDelta(): Promise<PrivacyMetricResult> {
  const CRM_FIELDS = {
    ...OSTOROSBOR_CRM_PRIVACY_FIELDS,
    email: {
      type: 'string' as const,
      privacy: 'tokenize' as const,
      entity_type: 'email' as const,
      source_id: 'crm/email/{id}',
    },
  }
  const rawOutput = {
    ok: true,
    body: [
      { id: 1, company_name: 'Alfa Kft.', email: 'a@x.hu', revenue: 10 },
      { id: 2, company_name: 'Béta Zrt.', email: 'b@x.hu', revenue: 20 },
    ],
  }

  let observeFailures = 0
  let enforceFailures = 0

  for (const _case of WORKFLOW_EVAL_CASES) {
    for (const mode of ['observe', 'enforce'] as const) {
      const { engine } = setup()
      try {
        const channels = await buildPrivacyAwareOutcomeChannels({
          tool: 'http_api_get',
          trust: 'external_untrusted',
          output: rawOutput,
          contract: undefined,
          sideEffecting: false,
          connector: { id: CONNECTOR, tenantId: TENANT, config: { fields: CRM_FIELDS } },
          conversationId: CONVERSATION,
          actingTenantId: TENANT,
          engine,
          mode,
        })
        const failed = channels.outcome !== 'ok'
        if (mode === 'observe' && failed) observeFailures += 1
        if (mode === 'enforce' && failed) enforceFailures += 1
      } catch {
        if (mode === 'observe') observeFailures += 1
        if (mode === 'enforce') enforceFailures += 1
      }
    }
  }

  const observeRate = observeFailures / WORKFLOW_EVAL_CASES.length
  const enforceRate = enforceFailures / WORKFLOW_EVAL_CASES.length
  const value = computeWorkflowFailureDelta(observeRate, enforceRate)
  return {
    id: 'workflow_failure_delta',
    value,
    passed: metricPasses('workflow_failure_delta', value),
    detail: `OBSERVE failure: ${(observeRate * 100).toFixed(1)}%, ENFORCE: ${(enforceRate * 100).toFixed(1)}%, delta: ${(value * 100).toFixed(1)}%`,
  }
}

function measureQualityDegradation(): PrivacyMetricResult {
  let rawPassed = 0
  let pseudoPassed = 0
  const evidence: string[] = []

  for (const fixture of QUALITY_EVAL_CASES) {
    const raw = runGoldenAssertions(fixture.assertions, fixture.rawResponse)
    const pseudo = runGoldenAssertions(fixture.assertions, fixture.pseudoResponse)
    if (raw.passRate === 1) rawPassed += 1
    if (pseudo.passRate === 1) pseudoPassed += 1
    if (raw.passRate === 1 && pseudo.passRate < 1) {
      evidence.push(`${fixture.id}: nyers ág átment (${(raw.passRate * 100).toFixed(0)}%), pszeudo nem (${(pseudo.passRate * 100).toFixed(0)}%)`)
    }
  }

  const rawRate = rawPassed / QUALITY_EVAL_CASES.length
  const pseudoRate = pseudoPassed / QUALITY_EVAL_CASES.length
  const value = computeQualityDegradation(rawRate, pseudoRate)
  return {
    id: 'quality_degradation',
    value,
    passed: metricPasses('quality_degradation', value),
    detail: `Nyers ág: ${(rawRate * 100).toFixed(0)}% átment, pszeudo: ${(pseudoRate * 100).toFixed(0)}%, romlás: ${(value * 100).toFixed(1)}%`,
    evidence,
  }
}

function measureInvalidSurrogateRate(): PrivacyMetricResult {
  const known = new Set(KNOWN_SURROGATES)
  let invalid = 0
  const evidence: string[] = []

  for (const output of MODEL_OUTPUT_SAMPLES) {
    const embedded = findEmbeddedSurrogates(output)
    const hasUnknown = embedded.some((m) => !known.has(m.text))
    if (hasUnknown) {
      invalid += 1
      evidence.push(`ismeretlen álnév: ${embedded.filter((m) => !known.has(m.text)).map((m) => m.text).join(', ')}`)
    }
  }

  const value = invalid / MODEL_OUTPUT_SAMPLES.length
  return {
    id: 'invalid_surrogate_rate',
    value,
    passed: metricPasses('invalid_surrogate_rate', value),
    detail: `${invalid}/${MODEL_OUTPUT_SAMPLES.length} modell-output tartalmaz ismeretlen/érvénytelen álnevet`,
    evidence,
  }
}

/** A hét metrika teljes futtatása. */
export async function runPrivacyEval(): Promise<PrivacyEvalReport> {
  const metrics = await Promise.all([
    measureStructuredRecall(),
    measureFreeTextRecall(),
    measureFalsePositiveRate(),
    measureLatencyP95(),
    measureWorkflowFailureDelta(),
    Promise.resolve(measureQualityDegradation()),
    Promise.resolve(measureInvalidSurrogateRate()),
  ])
  return buildPrivacyEvalReport(metrics)
}

/** Red-line trace-ek előállítása a privacy piros vonalakhoz (APG-07 integráció). */
export async function buildPrivacyRedLineTraces(): Promise<
  Array<{ probeId: string; trace: import('./privacy-eval-red-lines').PrivacyEvalTrace }>
> {
  const CRM_FIELDS = {
    ...OSTOROSBOR_CRM_PRIVACY_FIELDS,
    email: {
      type: 'string' as const,
      privacy: 'tokenize' as const,
      entity_type: 'email' as const,
      source_id: 'crm/email/{id}',
    },
  }
  const COMPANY = 'SPAR Magyarország Kereskedelmi Kft.'
  const EMAIL = 'ada.lovelace@spar.hu'
  const rawOutput = {
    ok: true,
    body: { id: 4821, company_name: COMPANY, email: EMAIL, revenue: 1_200_000_000 },
  }
  const rawValues = [COMPANY, EMAIL]

  const { engine } = setup()
  const channels = await buildPrivacyAwareOutcomeChannels({
    tool: 'http_api_get',
    trust: 'external_untrusted',
    output: rawOutput,
    contract: undefined,
    sideEffecting: false,
    connector: { id: CONNECTOR, tenantId: TENANT, config: { fields: CRM_FIELDS } },
    conversationId: CONVERSATION,
    actingTenantId: TENANT,
    engine,
    mode: 'enforce',
  })

  const lookup = async (surrogate: string) => (surrogate === '[[COMPANY_1]]' ? COMPANY : null)
  const urlSrc = `https://evil.example/?c=[[COMPANY_1]]`
  const displayText = await resolveDisplayText(urlSrc, lookup)

  const streamed: string[] = []
  const resolver = new StreamingSurrogateResolver(lookup, (text) => {
    streamed.push(text)
  })
  for (const ch of 'A [[COMPANY_1]] forgalma.') await resolver.push(ch)
  await resolver.finish()

  return [
    {
      probeId: 'rlp-1-2',
      trace: {
        probeId: 'rlp-1-2',
        modelText: channels.modelText,
        machineData: channels.machineData,
        rawOutput,
        rawValues,
        auditActions: [],
      },
    },
    {
      probeId: 'rlp-3',
      trace: {
        probeId: 'rlp-3',
        modelText: '',
        machineData: rawOutput,
        rawOutput,
        rawValues: [COMPANY],
        displayText,
        auditActions: [],
      },
    },
    {
      probeId: 'rlp-4',
      trace: {
        probeId: 'rlp-4',
        modelText: '',
        machineData: rawOutput,
        rawOutput,
        rawValues: [],
        streamedText: streamed.join(''),
        auditActions: [],
      },
    },
    {
      probeId: 'rlp-5',
      trace: {
        probeId: 'rlp-5',
        modelText: '',
        machineData: rawOutput,
        rawOutput,
        rawValues: [],
        modelOutput: 'Hívja a [[COMPANY_99]] ügyfélszolgálatát.',
        knownSurrogates: ['[[COMPANY_1]]'],
        auditActions: ['privacy.surrogate.unknown'],
      },
    },
  ]
}

export { setup, TENANT, CONNECTOR, CONVERSATION, DEFAULT_PRIVACY_CATEGORY_POLICY, PRIVACY_EVAL_POLICY }
