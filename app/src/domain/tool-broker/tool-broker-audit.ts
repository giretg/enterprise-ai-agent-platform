/**
 * WP-8 — Tool Broker audit/telemetria choke-point (a broker-magból kiemelve).
 *
 * A `recordCall` MINDEN allow/deny hívást rögzít: `ToolCall` sor + append-only
 * audit-esemény + WP-6 metrika/strukturált log. A `recordDenied` a deny-ág
 * rövid alakja. A keret (`invoke`) `self`-fel hívja; a viselkedés bittre azonos
 * a korábbi metódusokéval. Runtime import-ciklus nincs (a mag ÉRTÉKként importál,
 * ez a modul CSAK `import type ToolBrokerService`-t húz).
 */
import type { Prisma, ToolCallStatus } from '@prisma/client'
import { logger, toolBrokerCallsTotal, toolBrokerOutcomesTotal } from '@/lib/observability'
import { TOOL_REQUIREMENTS } from './tool-broker-authorizer'
import { argsMeta } from './tool-broker-support'
import { resolveTrustClass } from './tool-trust-registry'
import type { WebSearchEffectiveQuery } from '@/domain/web-search/web-search-types'
import type { ToolBrokerInvokeInput, ToolBrokerInvokeResult, TrustClass } from './tool-broker-types'
import type { ToolEffectSummary, ToolOutcome } from './tool-output-contract'
import type { ToolBrokerService } from './tool-broker-service'

export async function recordDenied(
  self: ToolBrokerService,
  input: ToolBrokerInvokeInput,
  ticketId: string | null,
  connectorId: string | null,
  reason: string,
  startedAt: number,
  actingUserId: string | null = null,
  grantId: string | null = null,
): Promise<ToolBrokerInvokeResult> {
  const latencyMs = Date.now() - startedAt
  await recordCall(self, {
    input,
    ticketId,
    connectorId,
    status: 'denied',
    latencyMs,
    policyDecision: reason,
    resultMeta: { denied: true, reason },
    actingUserId,
    grantId,
  })

  // issue #195 D1 — az elutasított hívás kimenetele `failed`: nem futott le.
  return { denied: true, reason, latencyMs, outcome: 'failed' }
}

export async function recordCall(
  self: ToolBrokerService,
  params: {
    input: ToolBrokerInvokeInput
    ticketId: string | null
    connectorId: string | null
    status: ToolCallStatus
    latencyMs: number
    policyDecision: string
    resultMeta: Record<string, unknown>
    actingUserId?: string | null
    grantId?: string | null
    webSearchEffective?: WebSearchEffectiveQuery
    /**
     * A hívás bizalmi osztálya (issue #97). Ha nincs megadva, a tool-nevenkénti
     * regiszterből oldjuk fel (fail-safe: ismeretlen → external_untrusted), hogy
     * a `ToolCall.trustClass` audit-oszlop minden ágon (ok/denied/error) töltődjön.
     */
    trustClass?: TrustClass
    /**
     * A hívás KIMENETELE (issue #195 D1). A `denied` / `error` ágakon `failed`,
     * a sikeres ágon a szerződés-kapu ítélete (`ok` / `empty` / `partial`).
     * A dedikált oszlop teszi megválaszolhatóvá: „melyik eszköz ad a
     * leggyakrabban üres vagy részleges eredményt?" — ez a lista mondja meg,
     * melyik eszközt kell javítani.
     */
    outcome?: ToolOutcome
    /** D4 — a MÉRT mellékhatás összegzése (olvasó toolnál `null`). */
    effect?: ToolEffectSummary | null
  },
) {
  const requirement = TOOL_REQUIREMENTS[params.input.tool]
  const connectorType = requirement?.connectorType ?? null
  const accessMode = requirement?.accessMode ?? null
  const trustClass = params.trustClass ?? resolveTrustClass(params.input.tool)
  // FAIL-SAFE: kimenetel nélkül hívott ág (régi hívó) `failed`-nek számít — egy
  // elfelejtett besorolás inkább látszódjon problémának, mint csendes sikernek.
  const outcome: ToolOutcome = params.outcome ?? (params.status === 'ok' ? 'ok' : 'failed')
  const effectSummary = params.effect ?? null
  const sanitizedArgsMeta = {
    ...argsMeta(params.input, params.webSearchEffective),
    acting_user_id: params.actingUserId ?? params.input.actingUserId ?? null,
    grant_id: params.grantId ?? null,
    connector_id: params.connectorId,
    connector_type: connectorType,
    access_mode: accessMode,
  }
  const metadata = {
    tool: params.input.tool,
    status: params.status,
    connector_id: params.connectorId,
    connector_type: connectorType,
    access_mode: accessMode,
    trust_class: trustClass,
    outcome,
    effect: effectSummary,
    argsMeta: sanitizedArgsMeta,
    resultMeta: params.resultMeta,
    acting_user_id: params.actingUserId ?? params.input.actingUserId ?? null,
    grant_id: params.grantId ?? null,
  }

  await self.tools.createToolCall({
    agentId: params.input.agentId,
    ticketId: params.ticketId,
    conversationId: params.input.conversationId ?? null,
    connectorId: params.connectorId,
    toolName: params.input.tool,
    status: params.status,
    argsMeta: sanitizedArgsMeta as Prisma.JsonValue,
    resultMeta: params.resultMeta as Prisma.JsonValue,
    latencyMs: params.latencyMs,
    policyDecision: params.policyDecision,
    trustClass,
    outcome,
    effectSummary: effectSummary as Prisma.JsonValue,
  })

  const targetType = params.ticketId ? 'ticket' : params.input.conversationId ? 'conversation' : 'tool'
  const targetId = params.ticketId ?? params.input.conversationId ?? params.connectorId

  await self.audit.append({
    actorType: 'agent',
    actorId: params.input.agentId,
    agentVersion: params.input.agentVersion,
    action: params.status === 'denied' ? 'tool.call.denied' : 'tool.call',
    targetType,
    targetId,
    modelUsed: null,
    inputRef: params.input.tool,
    outputRef: params.status,
    policyDecision: params.policyDecision,
    metadata: metadata as Prisma.JsonValue,
  })

  // WP-6 (O2): operatív telemetria (deny-arány + latency). Csak metaadat —
  // se args, se result-tartalom (a logger amúgy is redaktálná).
  toolBrokerCallsTotal.inc({
    tool: params.input.tool,
    status: params.status,
    decision: params.policyDecision,
  })
  // issue #195 WP-6 — a néma félremenetel akkor javítható, ha MÉRHETŐ: melyik
  // eszköz ad a leggyakrabban üres/részleges/hibás eredményt.
  toolBrokerOutcomesTotal.inc({ tool: params.input.tool, outcome })
  logger.info(
    {
      event: 'tool.call',
      tool: params.input.tool,
      status: params.status,
      outcome,
      outcomeReason: typeof params.resultMeta.outcome_reason === 'string' ? params.resultMeta.outcome_reason : null,
      decision: params.policyDecision,
      latencyMs: params.latencyMs,
      agentId: params.input.agentId,
      ticketId: params.ticketId,
      connectorId: params.connectorId,
    },
    'tool broker invocation',
  )
}
