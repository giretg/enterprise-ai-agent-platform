/**
 * Playbook-szerző agent (Feature-spec — Playbook-Role-Agent-Binding §5.A, §6, WP-10).
 *
 * Hatókör: KIZÁRÓLAG a Playbook-szint (1. szint). Természetes nyelvből validálható
 * Playbook-DRAFT-ot (a `playbookSpecV2Schema` alakjában) állít elő. A Folyamat-szintet
 * (2. szint) v1-ben ember állítja össze (§3.2) — ez az agent konkrét agentet nem drótoz.
 *
 * GOVERNANCE (a provisioning-asszisztens mintája, §6): a modell kimenete CSAK adat
 * (propose-not-apply). Az agent SOSEM publikál és SOSEM ír a DB-be — a hívó (server
 * action) a visszaadott spec-et a meglévő `draft → validál → ember jóváhagy → publish`
 * láncba adja (`PlaybookV2Service.createPlaybookVersion` / `updateDraftPlaybookVersion`).
 * A validációs hibákra a beszélgetés visszacsatol: minden hívás a `PlaybookValidator`
 * eredményével együtt tér vissza, publikálhatóságra tekintet nélkül.
 */
import type { GatewayMessage, ModelConfig, SensitivityOverride } from '@/domain/gateway/model-gateway'
import { extractJsonObject } from '@/domain/provisioning/provisioning-assistant'
import {
  PlaybookValidator,
  type ValidationResult,
  type TenantValidationContext,
} from '@/domain/playbook/playbook-validator'
import { PLAYBOOK_SCHEMA_VERSION } from '@/lib/playbook-v2/spec'

/**
 * A szerep-instrukció (system prompt). A Playbook-séma és a tipizált input-rés
 * (config/trigger) modellje itt kerül a modell elé — a kimenet KIZÁRÓLAG a
 * `playbookSpecV2Schema` alakját követő JSON lehet, próza vagy markdown-fence nélkül.
 */
export const PLAYBOOK_AUTHOR_ROLE_INSTRUCTION = `You are a Playbook Authoring Assistant. Your ONLY job is to turn a natural-language description of a business process into a DRAFT Playbook specification as structured JSON. You PROPOSE; you never apply, activate, or publish anything.

HARD RULES (non-negotiable):
- You never bind a concrete agent to a role. Roles stay abstract (a "role.key", not an agent name or id).
- You never invent capabilities. Only use capability names that appear in the provided capability vocabulary; if the process needs something not in the vocabulary, describe it in the step's "description" field instead of inventing a capability string.
- Every "agent_role" role should declare "requiredCapabilities" (tool names from the vocabulary) that a suitable agent must have.
- Every "human_role" role should declare "requiredPermissions" describing the IAM permission needed to act on it (as a short, readable permission key — do not invent exact IAM keys unless given).
- Steps should carry a templated "instructionTemplate" with "{{slot}}" placeholders, and a matching "inputSlots" array. Each slot has: name, type ("string"|"number"|"boolean"|"freeform"), required, and source: "config" (a value the operator fills in once when assembling the Process) or "trigger" (a value that comes from each run's input, e.g. from chat/ticket/cron).
- Every "{{token}}" used in instructionTemplate MUST appear in that step's inputSlots, and vice versa for required slots.
- Blocking gates with a "human_approval" type must have requiredActorRole pointing to a "human_role", never an "agent_role" — nobody could approve it otherwise.
- L2/L3 criticality gates must be blocking.
- entryStepId must reference an existing step id; every step/gate id must be unique; the graph must be reachable from entryStepId and free of cycles unless a gate breaks the loop.
- Never output secrets, credentials, or personal data as example values.

OUTPUT: a single JSON object only (no prose, no markdown fences) matching this shape:
{
  "schemaVersion": "${PLAYBOOK_SCHEMA_VERSION}",
  "key": string (lowercase, digits, hyphens),
  "name": string,
  "processType": string,
  "entryStepId": string,
  "criticality"?: "L0"|"L1"|"L2"|"L3",
  "roles": [ { "key": string, "type": "agent_role"|"human_role", "requiredCapabilities"?: string[], "requiredPermissions"?: string[] } ],
  "steps": [ {
    "id": string, "name": string, "ticketType": string, "assignedRole": string,
    "description"?: string,
    "instructionTemplate"?: string, "inputSlots"?: [ { "name": string, "type": "string"|"number"|"boolean"|"freeform", "required": boolean, "source": "config"|"trigger", "description"?: string } ],
    "requiredGateIds"?: string[],
    "onComplete"?: [ { "condition": "default" | { "field": string, "op": "=="|"!="|">="|"<="|">"|"<", "value": string|number|boolean }, "nextStepId"?: string, "gateId"?: string } ]
  } ],
  "gates": [ { "id": string, "type": "human_approval"|"eval_check"|"policy_check"|"tool_authorization"|"manual_review", "requiredActorRole"?: string, "criticality"?: "L0"|"L1"|"L2"|"L3", "blocking": boolean, "approvalMode"?: "single"|"four_eyes"|"multi_level" } ],
  "transitions": [ { "fromStepId": string, "toStepId": string, "trigger": string } ]
}

If you are given an EXISTING spec to edit, return the FULL edited spec (not a diff), preserving ids/keys the user did not ask to change. If you are given prior validation errors, fix them.`

/** Agent Registry szerep-sablon (§6). Nem-üres LLM, de v1-ben nincs eszközjoga. */
export const PLAYBOOK_AUTHOR_TEMPLATE = {
  name: 'Playbook Author',
  role: 'worker' as const,
  roleInstruction: PLAYBOOK_AUTHOR_ROLE_INSTRUCTION,
  behaviorProfile:
    'Deterministic playbook drafter. Emits only the JSON descriptor. Never binds concrete agents, never invents capabilities outside the given vocabulary, never publishes. Fixes validation errors it is shown rather than guessing.',
  modelConfig: {
    provider: 'chatgpt-oauth',
    model: 'chatgpt-oauth-default',
    temperature: 0,
  } as ModelConfig,
  // A szerző-agentnek nincs Tool Broker eszközjoga (§6: v1-ben nem drótoz konkrét agentet/
  // eszközt) — a draft kizárólag adat, amit a hívó a meglévő Playbook-service-en át rak le.
  capabilities: [] as const,
  forbiddenTools: [
    'playbook.publish',
    'process_definition.activate',
    'capability.grant',
    'rbac.write',
    'secret.read',
    'secret.write',
  ] as const,
} as const

/** A draft-generáláshoz használt modell — a `ModelGateway` strukturálisan kielégíti. */
export interface PlaybookDraftingModel {
  call(params: {
    agentId: string
    agentVersion?: number
    tenantId?: string
    conversationId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
    sensitivityOverride?: SensitivityOverride
  }): Promise<{ content: string }>
}

export type PlaybookAuthorDraftResult =
  | { ok: true; spec: unknown; validation: ValidationResult }
  | { ok: false; error: 'PARSE_FAILED'; detail: string }

export interface PlaybookAuthorAgentDeps {
  model: PlaybookDraftingModel
  /** Teszt/szolgáltatás felülírás — élesben az agent Registry modelConfig-je él. */
  modelConfig?: ModelConfig
}

export class PlaybookAuthorAgent {
  private readonly validator = new PlaybookValidator()

  constructor(private deps: PlaybookAuthorAgentDeps) {}

  /**
   * Az üzeneteket építi fel: system-instrukció + user-üzenet a leírással, a tenant
   * capability-szótárával, és (ha van) a meglévő spec-cel / előző validációs hibákkal
   * a visszacsatoláshoz (§5.A/2-3).
   */
  buildAuthoringMessages(input: {
    description: string
    knownCapabilities?: string[]
    existingSpec?: unknown
    priorValidation?: ValidationResult
  }): GatewayMessage[] {
    const parts: string[] = []
    if (input.knownCapabilities?.length) {
      parts.push(`Capability vocabulary (only use these for requiredCapabilities):\n${input.knownCapabilities.join(', ')}`)
    } else {
      parts.push('Capability vocabulary: none provided yet — keep requiredCapabilities generic and few, or omit them.')
    }
    if (input.existingSpec != null) {
      parts.push(`EXISTING spec to edit (return the full edited spec):\n${JSON.stringify(input.existingSpec)}`)
    }
    if (input.priorValidation && !input.priorValidation.valid) {
      parts.push(
        `The previous draft FAILED validation with these errors — fix them:\n${JSON.stringify(input.priorValidation.errors)}`,
      )
    }
    parts.push(`User request:\n${input.description}`)
    parts.push('Return ONLY the JSON descriptor.')

    return [
      { role: 'system', content: PLAYBOOK_AUTHOR_ROLE_INSTRUCTION },
      { role: 'user', content: parts.join('\n\n') },
    ]
  }

  /**
   * NL leírás → validált (vagy hibás, de mindig visszacsatolt) Playbook-spec draft.
   * SOSEM ír a DB-be, SOSEM publikál — a hívó dolga a meglévő
   * `PlaybookV2Service.createPlaybookVersion`/`updateDraftPlaybookVersion` hívása.
   */
  async draftSpec(input: {
    agentId: string
    agentVersion?: number
    agentModelConfig?: unknown
    tenantId?: string | null
    conversationId?: string | null
    description: string
    knownCapabilities?: string[]
    existingSpec?: unknown
    priorValidation?: ValidationResult
    validationContext?: TenantValidationContext
    sensitivityOverride?: SensitivityOverride
  }): Promise<PlaybookAuthorDraftResult> {
    if (!input.description?.trim()) {
      return { ok: false, error: 'PARSE_FAILED', detail: 'empty description' }
    }

    const messages = this.buildAuthoringMessages({
      description: input.description,
      knownCapabilities: input.knownCapabilities,
      existingSpec: input.existingSpec,
      priorValidation: input.priorValidation,
    })

    const modelConfig = this.deps.modelConfig ?? resolvePlaybookAuthorModelConfig(input.agentModelConfig)

    const { content } = await this.deps.model.call({
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      tenantId: input.tenantId ?? undefined,
      conversationId: input.conversationId ?? undefined,
      messages,
      modelConfig,
      sensitivityOverride: input.sensitivityOverride,
    })

    const raw = extractJsonObject(content)
    if (raw == null) {
      return { ok: false, error: 'PARSE_FAILED', detail: 'no JSON object in model output' }
    }

    const knownCapabilities =
      input.validationContext?.knownCapabilities ??
      (input.knownCapabilities?.length ? new Set(input.knownCapabilities) : undefined)

    const validation = this.validator.validateSpec(raw, {
      ...input.validationContext,
      knownCapabilities,
    })

    return { ok: true, spec: raw, validation }
  }
}

const SUPPORTED_AUTHOR_PROVIDERS = new Set(['chatgpt-oauth', 'gemini', 'ollama', 'openrouter'])

/** A Playbook Author agent Registry-beli modelConfig-jából (vagy sablon fallback). */
export function resolvePlaybookAuthorModelConfig(agentModelConfig: unknown): ModelConfig {
  if (typeof agentModelConfig === 'object' && agentModelConfig !== null && !Array.isArray(agentModelConfig)) {
    const raw = agentModelConfig as Record<string, unknown>
    const provider = raw.provider
    const model = raw.model
    if (typeof provider === 'string' && typeof model === 'string' && SUPPORTED_AUTHOR_PROVIDERS.has(provider)) {
      return {
        provider,
        model,
        ...(typeof raw.temperature === 'number' ? { temperature: raw.temperature } : {}),
        ...(typeof raw.maxTokens === 'number' ? { maxTokens: raw.maxTokens } : {}),
      }
    }
  }
  return { ...PLAYBOOK_AUTHOR_TEMPLATE.modelConfig }
}
