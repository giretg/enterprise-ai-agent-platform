/**
 * APG-04 — a kimeneti szerződés kapuja UTÁN a modell-csatorna pszeudonimizációja.
 * APG-09 — OFF / OBSERVE / ENFORCE: OBSERVE logol, de a modelText nyers marad.
 *
 * A nyers handler-kimenet a `machineData` (munkaterület, downstream tool, export).
 * A `modelText` a már pszeudonimizált másolat JSON-ja. A sorrend R6: előbb a
 * nyers válasz validációja, utána a surrogate-csere — így egy `email` formátumú
 * mezőbe tett `[[EMAIL_3]]` nem bukik el a séma-validáción.
 *
 * Ha a hívó nem ad módot, ENFORCE (APG-04 tesztek / hiányzó resolver).
 * Élesben a broker a PlatformSetting-hierarchiából oldja fel a módot.
 */
import type { AuditRepository } from '@/repositories/interfaces'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import {
  inspectConnectorPrivacyFields,
  readConnectorUnlistedDefault,
} from '@/domain/privacy/connector-privacy'
import { formatPrivacySourceSlot } from '@/domain/privacy/surrogate-format'
import { effectiveConnectorRuntimeConfig } from '@/domain/connector-template/ostorosbor-config-enrichment'
import { recordPrivacyGatewayAudit } from '@/domain/privacy/privacy-audit'
import type { PrivacyGatewayMode } from '@/domain/privacy/privacy-mode'
import { summarizePrivacySpans } from '@/domain/privacy/privacy-mode'
import { privacyScopeForCall } from '@/domain/privacy/privacy-scope'
import { transformStructuredOutput } from '@/domain/privacy/structured-output-transform'
import {
  PrivacyTransformBlockedError,
  describePrivacyTransformFailure,
} from '@/domain/privacy/privacy-transform-failure'
import { privacyTransformDurationMs } from '@/lib/observability/metrics'
import type { TrustClass } from './tool-broker-types'
import {
  buildToolOutcomeChannels,
  validateToolOutput,
  type ToolOutcomeChannels,
  type ToolOutputContract,
} from './tool-output-contract'

export type PrivacyAwareOutcomeInput = {
  tool: string
  trust: TrustClass
  output: unknown
  contract: ToolOutputContract | undefined
  sideEffecting: boolean
  fullDataRef?: string | null
  connector?: { id: string; tenantId: string | null; config: unknown; privacySlot?: number } | null
  conversationId?: string | null
  ticketId?: string | null
  actingTenantId?: string | null
  engine?: SurrogateEngine | null
  /** Hiányában ENFORCE — a meglévő APG-04 hívók viselkedése nem változik. */
  mode?: PrivacyGatewayMode
  audit?: AuditRepository | null
}

export async function buildPrivacyAwareOutcomeChannels(
  params: PrivacyAwareOutcomeInput,
): Promise<ToolOutcomeChannels> {
  const verdict = validateToolOutput({
    tool: params.tool,
    output: params.output,
    contract: params.contract,
    sideEffecting: params.sideEffecting,
  })
  let modelOutput: unknown
  try {
    modelOutput = await resolveModelOutput(params)
  } catch (error) {
    await auditStructuredPrivacyFailure(params, error)
    throw error
  }
  return buildToolOutcomeChannels({
    tool: params.tool,
    trust: params.trust,
    output: params.output,
    modelOutput,
    contract: params.contract,
    sideEffecting: params.sideEffecting,
    fullDataRef: params.fullDataRef,
    validatedVerdict: verdict,
  })
}

async function resolveModelOutput(params: PrivacyAwareOutcomeInput): Promise<unknown> {
  const mode = params.mode ?? 'enforce'
  const connector = params.connector
  if (!connector) return params.output
  // A tool-hívás a kiegészített configot használja; a privacy-rétegnek ugyanazt
  // kell látnia, különben egy korábban létrehozott CRM-kapcsolat mezői némán
  // tokenizálatlanul mennének ki a modellhez.
  const runtimeConfig = effectiveConnectorRuntimeConfig(connector.config)
  const inspected = inspectConnectorPrivacyFields(runtimeConfig)
  if (inspected.status === 'absent') return params.output
  if (inspected.status === 'invalid') {
    throw new PrivacyTransformBlockedError(
      'structured_field',
      new Error(`Hibás connector privacy deklaráció: ${inspected.reason}`),
    )
  }
  const fields = inspected.fields
  const tenantId = params.actingTenantId ?? connector.tenantId
  const scope = privacyScopeForCall(params.conversationId, params.ticketId)

  const apply = mode === 'enforce'
  const registerObserved = mode === 'observe'
  const started = Date.now()
  let output: unknown = params.output
  let spans: Awaited<ReturnType<typeof transformStructuredOutput>>['spans'] = []
  try {
    const transformed = await transformStructuredOutput({
      output: params.output,
      fields,
      unlistedDefault: readConnectorUnlistedDefault(runtimeConfig),
      engine: params.engine,
      tenantId,
      connectorId: connector.id,
      sourceSlot:
        typeof connector.privacySlot === 'number'
          ? formatPrivacySourceSlot(connector.privacySlot)
          : null,
      scope,
      apply,
      registerObserved,
    })
    output = transformed.output
    spans = transformed.spans
  } finally {
    privacyTransformDurationMs.observe(Date.now() - started)
  }

  if (registerObserved && params.engine && tenantId && scope) {
    await params.engine.flushObservePreviews(tenantId, scope)
  }

  if (mode !== 'off' && spans.length > 0 && params.audit && tenantId && scope) {
    await recordPrivacyGatewayAudit(params.audit, {
      action: apply ? 'privacy.transform.applied' : 'privacy.transform.observed',
      tenantId,
      scope,
      summary: summarizePrivacySpans(spans),
      mode,
      ticketId: params.ticketId ?? null,
    })
  }

  // OBSERVE/OFF alatt a tokenize mezők nyersek maradnak, de a hard `block`
  // szerződés (és a forrás `unlisted_default: block` deklarációja) akkor is
  // eltávolítja a mezőt a modellcsatornából.
  return output
}

async function auditStructuredPrivacyFailure(
  params: PrivacyAwareOutcomeInput,
  error: unknown,
): Promise<void> {
  if (!params.audit || params.mode === 'off') return
  const connector = params.connector
  const tenantId = params.actingTenantId ?? connector?.tenantId
  const scope = privacyScopeForCall(params.conversationId, params.ticketId)
  if (!tenantId || !scope) return
  try {
    await recordPrivacyGatewayAudit(params.audit, {
      action: 'privacy.transform.failed',
      tenantId,
      scope,
      summary: { spanCount: 0, categories: [], byCategory: {} },
      mode: params.mode ?? 'enforce',
      reason: describePrivacyTransformFailure(error),
      ticketId: params.ticketId ?? null,
    })
  } catch {
    // A felhasználónak szánt fail-closed hiba ne vesszen el egy másodlagos audit-hiba miatt.
  }
}
