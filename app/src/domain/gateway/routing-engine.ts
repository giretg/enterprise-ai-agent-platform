/**
 * Routing priority chain (§5, step 3 — Fázis 2-A)
 *
 * Resolution order (lower index = higher priority):
 *   1. Routing policy from model_routing_policies table
 *   2. Request override, only when the matched policy explicitly allows it
 *   3. Agent modelConfig (model_config.default_model)
 *   4. Fallback model (from agent model_config.fallback_model)
 *
 * The Gateway makes the final deterministic decision — agents cannot override it.
 */

import type { ModelConfig } from './model-gateway'
import type { ModelRoutingPolicyRepository } from '@/repositories/interfaces'

export type RoutingContext = {
  agentId: string
  tenantId?: string
  ticketType?: string
  /** Override hint from the request (low trust — only used if policy allows). */
  overrideHint?: { provider: string; model: string }
  /** Agent's configured model_config. */
  agentModelConfig: ModelConfig
  /** Agent's fallback model (from model_config.fallback_model). */
  fallbackModel?: { provider: string; model: string }
}

export type RoutingDecision = {
  provider: string
  model: string
  /** Source of the routing decision for audit metadata. */
  source: 'override' | 'agent' | 'policy' | 'fallback'
}

type OverridePolicyConditions = {
  allowRequestOverride?: boolean
  allowedRequestModels?: Array<string | { provider?: string; model?: string }>
  allowedRequestProviders?: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function parseConditions(conditions: unknown): OverridePolicyConditions {
  if (!isRecord(conditions)) return {}
  return {
    allowRequestOverride:
      typeof conditions.allowRequestOverride === 'boolean'
        ? conditions.allowRequestOverride
        : undefined,
    allowedRequestModels: Array.isArray(conditions.allowedRequestModels)
      ? conditions.allowedRequestModels.filter((item): item is string | { provider?: string; model?: string } => {
          if (typeof item === 'string') return true
          return isRecord(item)
        })
      : undefined,
    allowedRequestProviders: isStringArray(conditions.allowedRequestProviders)
      ? conditions.allowedRequestProviders
      : undefined,
  }
}

function modelAllowed(
  allowed: OverridePolicyConditions['allowedRequestModels'],
  override: { provider: string; model: string },
): boolean {
  if (!allowed?.length) return true
  return allowed.some((item) => {
    if (typeof item === 'string') {
      return item === override.model || item === `${override.provider}/${override.model}`
    }
    return (
      (item.provider === undefined || item.provider === override.provider) &&
      item.model === override.model
    )
  })
}

export class RoutingEngine {
  constructor(private policyRepo: ModelRoutingPolicyRepository) {}

  async resolve(ctx: RoutingContext): Promise<RoutingDecision> {
    const policies = await this.policyRepo.findForRouting({
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      ticketType: ctx.ticketType,
    })

    // 1-2. First matching governance policy wins. A request-level model
    // override is honored only when that matched policy explicitly permits it.
    for (const policy of policies) {
      if (!this.matchesConditions(policy.conditions, ctx)) continue
      if (ctx.overrideHint?.provider && ctx.overrideHint?.model) {
        const conditions = parseConditions(policy.conditions)
        const providerAllowed =
          !conditions.allowedRequestProviders?.length ||
          conditions.allowedRequestProviders.includes(ctx.overrideHint.provider)
        if (
          conditions.allowRequestOverride === true &&
          providerAllowed &&
          modelAllowed(conditions.allowedRequestModels, ctx.overrideHint)
        ) {
          return { provider: ctx.overrideHint.provider, model: ctx.overrideHint.model, source: 'override' }
        }
      }
      return { provider: policy.provider, model: policy.model, source: 'policy' }
    }

    // 3. Agent modelConfig. Request overrides are deliberately ignored when no
    // governance policy allowed them.
    if (ctx.agentModelConfig.provider && ctx.agentModelConfig.model) {
      return {
        provider: ctx.agentModelConfig.provider,
        model: ctx.agentModelConfig.model,
        source: 'agent',
      }
    }

    // 4. Fallback model
    if (ctx.fallbackModel) {
      return { provider: ctx.fallbackModel.provider, model: ctx.fallbackModel.model, source: 'fallback' }
    }

    // Should never reach here — caller validates provider exists before routing
    return {
      provider: ctx.agentModelConfig.provider ?? 'chatgpt-oauth',
      model: ctx.agentModelConfig.model ?? 'chatgpt-oauth-default',
      source: 'agent',
    }
  }

  private matchesConditions(
    conditions: unknown,
    _ctx: RoutingContext,
  ): boolean {
    void _ctx
    // Null conditions = unconditional match
    if (!conditions || typeof conditions !== 'object') return true
    // Structured conditions matching could be extended here.
    // For MVP Fázis 2 we support only unconditional policies.
    return true
  }
}
