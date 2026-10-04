'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requirePlatformRole, requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { fallbackMaxAttemptsFromEnv } from '@/domain/model-gateway/fallback-chain'
import {
  agentModelConfigSchema,
  modelRefSchema,
  normalizeModelConfig,
  parseAgentModelConfig,
  resolveAgentPrimary,
} from '@/lib/agent-model-config'
import { isModelAllowed, modelRefKey } from '@/lib/model-policy'
import {
  generateModelGatewayJwtKey,
  parseModelGatewayJwtKey,
  resolveModelGatewayJwtKey,
  saveModelGatewayJwtKey,
} from '@/lib/model-gateway-jwt-key'
import { loadOpenRouterTenantKey, parseOpenRouterApiKey, saveOpenRouterTenantKey } from '@/lib/openrouter-tenant-key'
import { fail, ok } from '@/lib/result'
import { repositories } from '@/repositories/postgres'

function actionFail(e: unknown, code: 'load_failed' | 'save_failed') {
  return fail(e instanceof Error ? e.message : code)
}

export async function getTenantModelPolicy() {
  try {
    const ctx = await requireTenantRole('viewer')
    return ok(await services.platformSettings.getModelPolicy(ctx.activeTenantId))
  } catch (e) {
    return actionFail(e, 'load_failed')
  }
}

/** Csak azt mondja el, van-e tenant-kulcs — a nyers értéket soha nem adja vissza. */
export async function getOpenRouterKeyStatus() {
  try {
    const ctx = await requireTenantRole('admin')
    const key = await loadOpenRouterTenantKey(ctx.activeTenantId)
    return ok({ configured: Boolean(key) })
  } catch (e) {
    return actionFail(e, 'load_failed')
  }
}

export async function setOpenRouterApiKey(input: unknown) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = z.object({ apiKey: z.string() }).safeParse(input)
    if (!parsed.success) return fail('invalid_key')
    let apiKey: string
    try {
      apiKey = parseOpenRouterApiKey(parsed.data.apiKey)
    } catch {
      return fail('invalid_key')
    }
    await saveOpenRouterTenantKey(ctx.activeTenantId, apiKey)
    await services.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'model.openrouter_key.set',
      targetType: 'model_policy',
      targetId: ctx.activeTenantId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'updated',
      metadata: { configured: true },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath('/control-plane/settings')
    return ok({ configured: true })
  } catch (e) {
    return actionFail(e, 'save_failed')
  }
}

/** Platform-szintű aláíró kulcs állapota — a nyers értéket soha nem adja vissza. */
export async function getModelGatewayJwtKeyStatus() {
  try {
    await requirePlatformRole('platform_auditor')
    const key = await resolveModelGatewayJwtKey()
    return ok({ configured: Boolean(key) })
  } catch (e) {
    return actionFail(e, 'load_failed')
  }
}

export async function setModelGatewayJwtKey(input: unknown) {
  try {
    const ctx = await requirePlatformRole('superadmin')
    const parsed = z.object({ apiKey: z.string().optional(), generate: z.boolean().optional() }).safeParse(input)
    if (!parsed.success) return fail('invalid_key')
    let apiKey: string
    try {
      apiKey = parsed.data.generate ? generateModelGatewayJwtKey() : parseModelGatewayJwtKey(parsed.data.apiKey)
    } catch {
      return fail('invalid_key')
    }
    await saveModelGatewayJwtKey(apiKey)
    await services.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'model.gateway_jwt_key.set',
      targetType: 'model_gateway',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'updated',
      metadata: { configured: true, generated: Boolean(parsed.data.generate) },
    })
    revalidatePath('/control-plane/platform/settings')
    return ok({ configured: true })
  } catch (e) {
    return actionFail(e, 'save_failed')
  }
}

export async function setTenantModelEnabled(input: unknown) {
  try {
    const ctx = await requireTenantRole('admin')
    const parsed = modelRefSchema.extend({ enabled: z.boolean() }).parse(input)
    const { enabled, ...ref } = parsed
    const policy = await services.platformSettings.setModelEnabled(
      ctx.activeTenantId,
      ref,
      enabled,
      ctx.user.id,
    )
    await services.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'model_policy.set',
      targetType: 'model_policy',
      targetId: ctx.activeTenantId,
      modelUsed: modelRefKey(ref),
      inputRef: null,
      outputRef: enabled ? 'enabled' : 'disabled',
      policyDecision: 'updated',
      metadata: { enabled },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath('/control-plane/settings')
    return ok(policy)
  } catch (e) {
    return actionFail(e, 'save_failed')
  }
}

export async function getGlobalFallbackChain() {
  try {
    await requirePlatformRole('platform_auditor')
    return ok(await services.platformSettings.getFallbackChain())
  } catch (e) {
    return actionFail(e, 'load_failed')
  }
}

export async function setGlobalFallbackChain(input: unknown) {
  try {
    const ctx = await requirePlatformRole('superadmin')
    const chain = z.array(modelRefSchema).max(10).parse(input)
    const saved = await services.platformSettings.setFallbackChain(chain, ctx.user.id)
    await services.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'model_fallback_chain.set',
      targetType: 'model_policy',
      // Platform-globális beállítás: nincs entitás-UUID; a null a „nincs cél" értéke.
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: saved.map(modelRefKey).join(','),
      policyDecision: 'updated',
      metadata: { chain: saved },
    })
    revalidatePath('/control-plane/platform/settings')
    return ok(saved)
  } catch (e) {
    return actionFail(e, 'save_failed')
  }
}

/** Az agent adatlap modell-szekciójához: a mentett konfig + az engedett lista + a globális lánc. */
export async function getAgentModelSettings(input: { agentId: string }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const agent = await repositories.agents.findById(input.agentId, ctx.activeTenantId)
    if (!agent) return fail('not_found')
    const [policy, globalChain] = await Promise.all([
      services.platformSettings.getModelPolicy(ctx.activeTenantId),
      services.platformSettings.getFallbackChain(),
    ])
    return ok({
      policy,
      globalChain,
      config: parseAgentModelConfig(agent.modelConfig),
      effectivePrimary: resolveAgentPrimary(agent.modelConfig, policy),
      maxAttempts: fallbackMaxAttemptsFromEnv(),
    })
  } catch (e) {
    return actionFail(e, 'load_failed')
  }
}

export async function updateAgentModelConfig(input: { agentId: string; modelConfig: unknown }) {
  try {
    const ctx = await requireTenantRole('admin')
    const agent = await repositories.agents.findById(input.agentId, ctx.activeTenantId)
    if (!agent) return fail('not_found')
    const config = normalizeModelConfig(agentModelConfigSchema.parse(input.modelConfig))
    const policy = await services.platformSettings.getModelPolicy(ctx.activeTenantId)
    for (const ref of [config, ...config.fallbackModels]) {
      if (!isModelAllowed(policy, ref)) return fail('not_allowed')
    }
    const updated = await repositories.agents.updateModelConfig({
      agentId: agent.id,
      modelConfig: config,
    })
    await services.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'agent.model_config',
      targetType: 'agent',
      targetId: agent.id,
      modelUsed: modelRefKey(config),
      inputRef: null,
      outputRef: null,
      policyDecision: 'updated',
      metadata: { modelConfig: config },
      tenantId: ctx.activeTenantId,
    })
    revalidatePath(`/control-plane/agents/${agent.id}`)
    return ok(parseAgentModelConfig(updated.modelConfig))
  } catch (e) {
    return actionFail(e, 'save_failed')
  }
}
