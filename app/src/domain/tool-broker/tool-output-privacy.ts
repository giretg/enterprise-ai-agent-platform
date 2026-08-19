/**
 * APG-04 — a kimeneti szerződés kapuja UTÁN a modell-csatorna pszeudonimizációja.
 *
 * A nyers handler-kimenet a `machineData` (munkaterület, downstream tool, export).
 * A `modelText` a már pszeudonimizált másolat JSON-ja. A sorrend R6: előbb a
 * nyers válasz validációja, utána a surrogate-csere — így egy `email` formátumú
 * mezőbe tett `[[EMAIL_3]]` nem bukik el a séma-validáción.
 */
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import { readConnectorPrivacyFields } from '@/domain/privacy/connector-privacy'
import { pseudonymizeStructuredOutput } from '@/domain/privacy/structured-output-transform'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'
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
  if (!params.engine) return params.output
  const connector = params.connector
  if (!connector) return params.output
  const fields = readConnectorPrivacyFields(connector.config)
  if (!fields) return params.output
  const tenantId = params.actingTenantId ?? connector.tenantId
  if (!tenantId) return params.output
  const scope = privacyScope(params.conversationId, params.ticketId)
  if (!scope) return params.output

  return pseudonymizeStructuredOutput({
    output: params.output,
    fields,
    engine: params.engine,
    tenantId,
    connectorId: connector.id,
    scope,
  })
}

function privacyScope(
  conversationId: string | null | undefined,
  ticketId: string | null | undefined,
): PrivacyScope | null {
  if (conversationId) return { type: 'conversation', id: conversationId }
  if (ticketId) return { type: 'conversation', id: ticketId }
  return null
}
