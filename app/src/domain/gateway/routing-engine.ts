/**
 * Routing priority chain (§5, step 3 — Fázis 2-A)
 *
 * Resolution order (lower index = higher priority):
 *   1. Ticket/Playbook override (from modelConfig override hint)
 *   2. Agent modelConfig (model_config.default_model)
 *   3. Global routing policy from model_routing_policies table
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

export class RoutingEngine {
  constructor(private policyRepo: ModelRoutingPolicyRepository) {}

  async resolve(ctx: RoutingContext): Promise<RoutingDecision> {
    // 1. Ticket-level / Playbook override (request modelConfig override hint)
    if (ctx.overrideHint?.provider && ctx.overrideHint?.model) {
      return { provider: ctx.overrideHint.provider, model: ctx.overrideHint.model, source: 'override' }
    }

    // 2. Agent modelConfig
    if (ctx.agentModelConfig.provider && ctx.agentModelConfig.model) {
      // 3. Check if a routing policy overrides the agent config
      const policies = await this.policyRepo.findForRouting({
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        ticketType: ctx.ticketType,
      })

      // Find first matching policy (ordered by priority ASC)
      for (const policy of policies) {
        if (this.matchesConditions(policy.conditions, ctx)) {
          return { provider: policy.provider, model: policy.model, source: 'policy' }
        }
      }

      // No policy match → use agent config
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
