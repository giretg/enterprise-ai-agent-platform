/**
 * „Mondd el egy-két mondatban” (#957 D1): a céges alapmodell vázlatot ír a
 * leírásból, a tenant napi keretéből.
 *
 * - Modell: a tenant engedett listájának első modellje (ugyanaz, amit egy
 *   modell nélküli agent kapna), a globális tartalék-lánccal — a policy-n
 *   kívüli modell nem futhat.
 * - Keret: naponta legfeljebb `hireDraftDailyLimit` modellhívás tenantonként
 *   (0 = kikapcsolva). Elfogyott keretnél a varázsló a mintás / üres utat ajánlja.
 * - A válaszból csak a `sanitizeAiHireDraft` által engedett rész marad; a
 *   létező eszköznevekre szűrés ugyanaz a platform-szótár, mint az Agent
 *   Scaffold `create_draft`-jánál (`NORMAL_TOOL_CAPABILITY_NAMES`).
 * - Minden modellhívás auditált (`agent.hire_draft.suggest`); a leírás szövege
 *   nem kerül az auditba, csak a hossza.
 */
import { modelRefKey, type ModelPolicy, type ModelRef } from '@/lib/model-policy'
import { buildEffectiveFallbackChain, classifyProviderError, isFallbackEligible } from '@/domain/model-gateway/fallback-chain'
import type { ProviderRegistry } from '@/domain/model-gateway/proxy'
import type { AuditSink } from '@/lib/audit/types'
import type { HireDraft, HireLocale } from '@/lib/agent-hire'
import {
  buildHireDraftMessages,
  cleanHireDescription,
  extractJsonObject,
  hireDraftDayStart,
  sanitizeAiHireDraft,
} from '@/lib/agent-hire-draft'

export const HIRE_DRAFT_AUDIT_ACTION = 'agent.hire_draft.suggest'
/** Ezek a hívások értek el modellt — ezek fogyasztják a keretet. */
export const HIRE_DRAFT_COUNTED_DECISION = 'allowed'

const PROVIDER_TIMEOUT_MS = 45_000
const MAX_ATTEMPTS = 3

export type HireDraftFailure =
  | 'empty'
  | 'disabled'
  | 'budget_exhausted'
  | 'no_model'
  | 'provider_unavailable'
  | 'invalid_response'

export type HireDraftResult =
  | { ok: true; draft: HireDraft; model: string; remaining: number }
  | { ok: false; reason: HireDraftFailure; remaining: number }

export type HireDraftDeps = {
  readDailyLimit: (tenantId: string) => Promise<number>
  /** A mai (UTC) keretbe számító hívások száma. */
  countSince: (input: { tenantId: string; since: Date }) => Promise<number>
  getTenantPolicy: (tenantId: string) => Promise<ModelPolicy>
  getGlobalFallbackChain: () => Promise<ModelRef[]>
  providers: ProviderRegistry
  audit: AuditSink
  fetchImpl?: typeof fetch
  now?: () => Date
}

type ChatPayload = {
  error?: { code?: string | number; message?: string }
  choices?: Array<{ message?: { content?: unknown } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export async function hireDraftQuota(
  deps: Pick<HireDraftDeps, 'readDailyLimit' | 'countSince' | 'now'>,
  tenantId: string,
): Promise<{ limit: number; used: number; remaining: number }> {
  const limit = await deps.readDailyLimit(tenantId)
  const used = limit > 0 ? await deps.countSince({ tenantId, since: hireDraftDayStart(deps.now?.() ?? new Date()) }) : 0
  return { limit, used, remaining: Math.max(0, limit - used) }
}

export async function suggestHireDraft(
  deps: HireDraftDeps,
  input: { tenantId: string; userId: string; description: string; locale: HireLocale },
): Promise<HireDraftResult> {
  const description = cleanHireDescription(input.description)
  const quota = await hireDraftQuota(deps, input.tenantId)
  if (!description) return { ok: false, reason: 'empty', remaining: quota.remaining }
  if (quota.limit === 0) return { ok: false, reason: 'disabled', remaining: 0 }
  if (quota.remaining === 0) return { ok: false, reason: 'budget_exhausted', remaining: 0 }

  const [policy, globalChain] = await Promise.all([
    deps.getTenantPolicy(input.tenantId),
    deps.getGlobalFallbackChain(),
  ])
  const chain = buildEffectiveFallbackChain({
    primary: policy.enabled[0] ?? null,
    globalFallbacks: globalChain,
    policy,
    maxAttempts: MAX_ATTEMPTS,
  })
  if (chain.length === 0) return { ok: false, reason: 'no_model', remaining: quota.remaining }

  const messages = buildHireDraftMessages({ description, locale: input.locale })
  const audit = (decision: string, extra: { model?: string | null; metadata: Record<string, unknown> }) =>
    deps.audit.append({
      actorType: 'human',
      actorId: input.userId,
      action: HIRE_DRAFT_AUDIT_ACTION,
      targetType: 'tenant',
      targetId: input.tenantId,
      modelUsed: extra.model ?? null,
      inputRef: `chars:${description.length}`,
      policyDecision: decision,
      metadata: extra.metadata,
      tenantId: input.tenantId,
    })

  const failed: Array<{ model: string; errorClass: string }> = []
  for (const candidate of chain) {
    const model = modelRefKey(candidate)
    let payload: ChatPayload
    try {
      payload = await callModel(deps, input.tenantId, candidate, messages)
    } catch (error) {
      const errorClass = classifyProviderError(error)
      failed.push({ model, errorClass })
      if (!isFallbackEligible(errorClass)) break
      continue
    }
    const content = payload.choices?.[0]?.message?.content
    const draft = sanitizeAiHireDraft(extractJsonObject(typeof content === 'string' ? content : ''), {
      description,
      locale: input.locale,
    })
    const usage = payload.usage
      ? { promptTokens: payload.usage.prompt_tokens, completionTokens: payload.usage.completion_tokens }
      : null
    await audit(HIRE_DRAFT_COUNTED_DECISION, {
      model,
      metadata: { outcome: draft ? 'ok' : 'invalid_response', usage, failedCandidates: failed },
    })
    const remaining = Math.max(0, quota.remaining - 1)
    return draft ? { ok: true, draft, model, remaining } : { ok: false, reason: 'invalid_response', remaining }
  }
  await audit('error', { metadata: { outcome: 'provider_unavailable', failedCandidates: failed } })
  return { ok: false, reason: 'provider_unavailable', remaining: quota.remaining }
}

async function callModel(
  deps: HireDraftDeps,
  tenantId: string,
  candidate: ModelRef,
  messages: ReturnType<typeof buildHireDraftMessages>,
): Promise<ChatPayload> {
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
      messages,
      temperature: 0.2,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
      stream: false,
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${candidate.provider} provider failed: ${res.status} ${text.slice(0, 200)}`)
  let data: ChatPayload
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`${candidate.provider} provider failed: invalid response`)
  }
  // Az OpenRouter időnként 200-zal ad `{error}` testet.
  if (data?.error || !Array.isArray(data?.choices)) {
    throw new Error(`${candidate.provider} provider failed: ${data?.error?.code ?? ''} ${data?.error?.message ?? 'no choices'}`)
  }
  return data
}
