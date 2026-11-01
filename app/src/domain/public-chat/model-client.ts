/**
 * #1016 D15: a nyilvános asszisztens modell-hívása. Saját modellválasztó (a publikált profilban),
 * alapból olcsó-gyors modell, a megszokott tartalék-lánccal és a tenant engedett modell-listájával.
 * Nem-stream, OpenAI chat_completions — ugyanazok a providerek, mint a Model Gatewayen.
 */
import {
  buildEffectiveFallbackChain,
  classifyProviderError,
  isFallbackEligible,
} from '@/domain/model-gateway/fallback-chain'
import type { ProviderRegistry } from '@/domain/model-gateway/proxy'
import { costOfUsage } from '@/domain/platform-chat/gateway'
import { isModelAllowed, type ModelPolicy, type ModelRef } from '@/lib/model-policy'
import type { PublicAssistantConfig } from './config'
import type { ModelReply, PublicTurnDeps, ToolCall } from './runtime'

const REQUEST_TIMEOUT_MS = 60_000
const MAX_REPLY_TOKENS = 1024
const CHEAP_MODEL_RE = /flash|mini|haiku|lite|small|nano/i

export type PublicModelDeps = {
  getTenantPolicy: (tenantId: string) => Promise<ModelPolicy>
  getGlobalFallbackChain: () => Promise<ModelRef[]>
  providers: ProviderRegistry
  fetchImpl?: typeof fetch
  fallbackUsdPerMTok?: number
}

/** D15: kifejezett választás híján az engedett lista első olcsó-gyors modellje. */
export function defaultPublicModel(policy: ModelPolicy): ModelRef | null {
  return policy.enabled.find((ref) => CHEAP_MODEL_RE.test(ref.model)) ?? policy.enabled[0] ?? null
}

export class PublicModelUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`public_model_unavailable: ${reason}`)
    this.name = 'PublicModelUnavailableError'
  }
}

export function createPublicModelCaller(
  deps: PublicModelDeps,
  input: { tenantId: string; config: PublicAssistantConfig },
): PublicTurnDeps['callModel'] {
  return async ({ messages, tools, toolChoice }) => {
    const [policy, globalChain] = await Promise.all([deps.getTenantPolicy(input.tenantId), deps.getGlobalFallbackChain()])
    const chosen = input.config.model
    const primary = chosen && isModelAllowed(policy, chosen) ? { provider: chosen.provider, model: chosen.model } : defaultPublicModel(policy)
    const chain = buildEffectiveFallbackChain({
      primary,
      agentFallbacks: chosen?.fallbackModels ?? [],
      globalFallbacks: globalChain,
      policy,
    })
    if (chain.length === 0) throw new PublicModelUnavailableError('no_allowed_model')

    let lastError: unknown = null
    for (const candidate of chain) {
      try {
        return await callOnce(deps, input.tenantId, candidate, { messages, tools, toolChoice })
      } catch (error) {
        lastError = error
        if (!isFallbackEligible(classifyProviderError(error))) break
      }
    }
    throw lastError ?? new PublicModelUnavailableError('provider_failed')
  }
}

async function callOnce(
  deps: PublicModelDeps,
  tenantId: string,
  candidate: ModelRef,
  body: Parameters<PublicTurnDeps['callModel']>[0],
): Promise<ModelReply> {
  const endpoint = await deps.providers(candidate.provider, tenantId)
  if (!endpoint) throw new Error(`${candidate.provider} provider is not configured`)
  const res = await (deps.fetchImpl ?? fetch)(`${endpoint.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
      ...endpoint.headers,
    },
    body: JSON.stringify({
      model: candidate.model,
      messages: body.messages,
      ...(body.tools.length ? { tools: body.tools, tool_choice: body.toolChoice } : {}),
      max_tokens: MAX_REPLY_TOKENS,
      temperature: 0.3,
      stream: false,
      ...(candidate.provider === 'openrouter' ? { usage: { include: true } } : {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${candidate.provider} provider failed: ${res.status} ${text.slice(0, 200)}`)
  let data: {
    error?: { code?: unknown; message?: string }
    choices?: Array<{ message?: { content?: unknown; tool_calls?: ToolCall[] } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
  }
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`${candidate.provider} provider failed: invalid response`)
  }
  if (data.error || !Array.isArray(data.choices)) {
    throw new Error(`${candidate.provider} provider failed: ${String(data.error?.code ?? '')} ${data.error?.message ?? 'no choices'}`)
  }
  const message = data.choices[0]?.message
  const usage = data.usage
    ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        ...(typeof data.usage.cost === 'number' ? { costUsd: data.usage.cost } : {}),
      }
    : null
  return {
    content: typeof message?.content === 'string' ? message.content : null,
    toolCalls: Array.isArray(message?.tool_calls)
      ? message.tool_calls.filter((c) => c && c.type === 'function' && typeof c.function?.name === 'string')
      : [],
    costUsd: costOfUsage(usage, deps.fallbackUsdPerMTok),
  }
}
