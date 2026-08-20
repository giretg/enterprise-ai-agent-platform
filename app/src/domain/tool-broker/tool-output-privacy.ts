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
import { readConnectorPrivacyFields } from '@/domain/privacy/connector-privacy'
import { recordPrivacyGatewayAudit } from '@/domain/privacy/privacy-audit'
import type { PrivacyGatewayMode } from '@/domain/privacy/privacy-mode'
import { summarizePrivacySpans } from '@/domain/privacy/privacy-mode'
import { privacyScopeForCall } from '@/domain/privacy/privacy-scope'
import { transformStructuredOutput } from '@/domain/privacy/structured-output-transform'
import { privacyTransformDurationMs } from '@/lib/observability/metrics'
import type { TrustClass } from './tool-broker-types'
import {
  buildToolOutcomeChannels,
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
  connector?: { id: string; tenantId: string | null; config: unknown } | null
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
  const modelOutput = await resolveModelOutput(params)
  return buildToolOutcomeChannels({
    tool: params.tool,
    trust: params.trust,
    output: params.output,
    modelOutput,
    contract: params.contract,
    sideEffecting: params.sideEffecting,
    fullDataRef: params.fullDataRef,
  })
}

async function resolveModelOutput(params: PrivacyAwareOutcomeInput): Promise<unknown> {
  const mode = params.mode ?? 'enforce'
  if (mode === 'off') return params.output
  if (!params.engine) return params.output
  const connector = params.connector
  if (!connector) return params.output
  const fields = readConnectorPrivacyFields(connector.config)
  if (!fields) return params.output
  const tenantId = params.actingTenantId ?? connector.tenantId
  if (!tenantId) return params.output
  const scope = privacyScopeForCall(params.conversationId, params.ticketId)
  if (!scope) return params.output

  const apply = mode === 'enforce'
  const started = Date.now()
  let output: unknown = params.output
  let spans: Awaited<ReturnType<typeof transformStructuredOutput>>['spans'] = []
  try {
    const transformed = await transformStructuredOutput({
      output: params.output,
      fields,
      engine: params.engine,
      tenantId,
      connectorId: connector.id,
      scope,
      apply,
    })
    output = transformed.output
    spans = transformed.spans
  } finally {
    privacyTransformDurationMs.observe(Date.now() - started)
  }

  if (spans.length > 0 && params.audit) {
    await recordPrivacyGatewayAudit(params.audit, {
      action: apply ? 'privacy.transform.applied' : 'privacy.transform.observed',
      tenantId,
      scope,
      summary: summarizePrivacySpans(spans),
      mode,
      ticketId: params.ticketId ?? null,
    })
  }

  return apply ? output : params.output
}
