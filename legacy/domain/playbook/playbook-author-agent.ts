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
import { z } from 'zod'
import {
  compileFromZod,
  contractToJsonSchema,
  runStrictContract,
  structuringModelFromEnv,
  toStructuringModelConfig,
} from '@/domain/contract-runtime'
import {
  PlaybookValidator,
  type ValidationResult,
  type TenantValidationContext,
} from '@/domain/playbook/playbook-validator'
import { PLAYBOOK_AUTHOR_AGENT_NAME } from '@/lib/platform-agent-registry'
import { PLAYBOOK_SCHEMA_VERSION } from '@/lib/playbook-v2/spec'
import {
  buildReferencedSkillPrompt,
  buildSkillCatalogPrompt,
  type SkillReferenceEntry,
} from '@/lib/skill/skill-reference'
import {
  DEFAULT_TENANT_LANGUAGE,
  outputLanguageInstruction,
  type TenantLanguage,
} from '@/lib/tenant-language'

/**
 * A szerep-instrukció (system prompt). A Playbook-séma és a tipizált input-rés
 * (config/trigger) modellje itt kerül a modell elé — a kimenet KIZÁRÓLAG a
 * `playbookSpecV2Schema` alakját követő JSON lehet, próza vagy markdown-fence nélkül.
 */
export const PLAYBOOK_AUTHOR_ROLE_INSTRUCTION = `You are a Playbook Authoring Assistant. Your ONLY job is to turn a natural-language description of a business process into a DRAFT Playbook specification as structured JSON. You PROPOSE; you never apply, activate, or publish anything.

HARD RULES (non-negotiable):
- You never bind a concrete agent to a role. Roles stay abstract (a "role.key", not an agent name or id).
- You never invent capabilities. Only use capability names that appear in the provided capability vocabulary; if the process needs something not in the vocabulary, describe it in the step's "description" field instead of inventing a capability string.
- You never invent IAM permissions. Only use permission keys that appear in the provided IAM permission vocabulary; if none fits, omit "requiredPermissions" and describe the approval expectation in the role/step/gate names and descriptions.
- Every "agent_role" role should declare "requiredCapabilities" (tool names from the vocabulary) that a suitable agent must have.
- Every "human_role" role may declare "requiredPermissions" from the IAM permission vocabulary when a platform permission is actually required.
- Steps should carry a templated "instructionTemplate" with "{{slot}}" placeholders, and a matching "inputSlots" array. Each slot has: name, type ("string"|"number"|"boolean"|"freeform"), required, and source: "config" (a value the operator fills in once when assembling the Process) or "trigger" (a value that comes from each run's input, e.g. from chat/ticket/cron) or "step" (output from the previous step in the flow).
- Every "{{token}}" used in instructionTemplate MUST appear in that step's inputSlots, and vice versa for required slots.
- Blocking gates with a "human_approval" type must have requiredActorRole pointing to a "human_role", never an "agent_role" — nobody could approve it otherwise.
- L2/L3 criticality gates must be blocking.
- entryStepId must reference an existing step id; every step/gate id must be unique; the graph must be reachable from entryStepId and free of cycles unless a gate breaks the loop.
- Never output secrets, credentials, or personal data as example values.

STEP CONTRACT CHAINING (the most common way a generated Playbook dies at runtime — check it explicitly before you answer):
- The output of one step and the input of the next step are ONE contract, matched by EXACT field name. "companyName", "company_name" and "cegnev" are three different fields: the runtime does no fuzzy matching, no translation, no case folding.
- For every edge A → B (via onComplete.nextStepId, a decision branch/fallback, or a transition): every inputSlot of B with source "step" and required true MUST be produced by A under exactly that name. For each such field do all three of these:
  1. DECLARE it on A: "outputContract": { "requiredFields": ["<exact name>", ...] } (typed form also allowed: { "fields": [ { "name": ..., "type": "string"|"number"|"boolean"|"date"|"enum"|"array"|"object", "required": true } ] }).
  2. PROMPT it in A's instructionTemplate: literally write the field name there and ask for a structured answer, e.g. 'A válaszod végén adj vissza egy JSON objektumot pontosan ezekkel a kulcsokkal: {"crmStatus": ..., "contactEmail": ...}'. A step that is never asked for its own contract answers in prose, and the run stops with "output_contract_unmet". The runtime's generic fallback instruction is NOT strong enough.
  3. TYPE it: if B's slot is "number"/"boolean", say so in A's prompt; if only a fixed set of values is acceptable (routing!), enumerate those exact values verbatim in A's prompt.
- Routing fields: if any onComplete condition or decision branch compares { "field": "X", "op": ..., "value": V }, then X must be in the producing step's outputContract AND named in its instructionTemplate, and every compared V must be listed in that prompt as an allowed value. A router comparing against a value the prompt never mentioned never routes.
- A step may use source "step" ONLY for values that some step BEFORE it on EVERY incoming path actually produces. If a value cannot come from an earlier step, its source is "config" (the operator fills it in once) or "trigger" (it arrives with each run) — never "step".
- Do not rename a value as it travels: if B expects "invoiceId", A must emit "invoiceId", and if C also needs it, C's slot is "invoiceId" too and B must pass it through (declare it in B's outputContract and prompt as well).
- Before returning the JSON, walk every edge once and verify points 1-3 for each chained field. Fixing this here costs nothing; at runtime it is a blocked process a human has to unstick.

SKILLS (approved, versioned working procedures — you may be given a SKILL CATALOG and the full text of the skills the request refers to):
- A skill is NOT a capability and NOT a step: it is written guidance that the EXECUTING agent loads at runtime. You never call a skill, never inline it, and never invent one that is missing from the catalog.
- If the request (or the spec you are editing) refers to a skill, its full instruction text is given to you. READ IT, and make the affected step consistent with it: the step must ask for exactly what the skill can produce, and provide exactly what the skill needs.
- For a step meant to run with a skill: (a) name the skill in the instructionTemplate ("Használd a \`<skill-name>\` skillt."), (b) copy every tool from that skill's "required tools" into the assignedRole's requiredCapabilities — without them the runtime refuses to load the skill and the step degrades silently, (c) turn the skill's declared parameters into inputSlots of that step (source "config" or "trigger"), (d) only put fields into that step's outputContract that the skill actually produces.
- Never paste the skill's text into instructionTemplate: the skill is versioned separately, and copying it forks it.
- If the request names a skill that is NOT in the catalog, do not invent it — describe the work in the step's "description" and state there that the skill is missing.

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
    "instructionTemplate"?: string, "inputSlots"?: [ { "name": string, "type": "string"|"number"|"boolean"|"freeform", "required": boolean, "source": "config"|"trigger"|"step", "description"?: string } ],
    "outputContract"?: { "requiredFields"?: string[], "fields"?: [ { "name": string, "type": "string"|"number"|"boolean"|"date"|"enum"|"array"|"object", "required"?: boolean, "description"?: string, "enumValues"?: string[] } ] },
    "requiredGateIds"?: string[],
    "onComplete"?: [ { "condition": "default" | { "field": string, "op": "=="|"!="|">="|"<="|">"|"<", "value": string|number|boolean }, "nextStepId"?: string, "gateId"?: string } ]
  } ],
  "gates": [ { "id": string, "type": "human_approval"|"eval_check"|"policy_check"|"tool_authorization"|"manual_review", "requiredActorRole"?: string, "criticality"?: "L0"|"L1"|"L2"|"L3", "blocking": boolean, "approvalMode"?: "single"|"four_eyes"|"multi_level" } ],
  "transitions": [ { "fromStepId": string, "toStepId": string, "trigger": string } ]
}

If you are given an EXISTING spec to edit, return the FULL edited spec (not a diff), preserving ids/keys the user did not ask to change. If you are given prior validation errors, fix them.`

/** Agent Registry szerep-sablon (§6). Nem-üres LLM, de v1-ben nincs eszközjoga. */
export const PLAYBOOK_AUTHOR_TEMPLATE = {
  name: PLAYBOOK_AUTHOR_AGENT_NAME,
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
    responseJsonSchema?: Record<string, unknown>
  }): Promise<{ content: string }>
}

/**
 * #33 — alak-contract a playbook-spec tetejére. A semantikát továbbra is a
 * PlaybookValidator dönti el; ez csak a gépi-olvasható vázat kényszeríti.
 */
const playbookDraftShapeSchema = z
  .object({
    schemaVersion: z.string().min(1),
    key: z.string().min(1),
    name: z.string().min(1),
    processType: z.string().min(1),
    entryStepId: z.string().min(1),
    roles: z.array(z.unknown()).min(1),
    steps: z.array(z.unknown()).min(1),
    gates: z.array(z.unknown()),
    transitions: z.array(z.unknown()),
  })
  .passthrough()

const playbookDraftContract = compileFromZod(
  playbookDraftShapeSchema as z.ZodType<Record<string, unknown>>,
)

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
    knownPermissions?: string[]
    skillCatalog?: SkillReferenceEntry[]
    referencedSkills?: SkillReferenceEntry[]
    existingSpec?: unknown
    priorValidation?: ValidationResult
    outputLanguage?: TenantLanguage
  }): GatewayMessage[] {
    const language = input.outputLanguage ?? DEFAULT_TENANT_LANGUAGE
    const parts: string[] = []
    // Skill-kontextus (skill-reference.ts): Level-0 katalógus mindig, Level-1 törzs
    // csak a ténylegesen hivatkozott skillekre. A katalógus a capability-szótár ELŐTT
    // áll, mert a hivatkozott skill `requiredTools`-a magyarázza a szótár egy részét.
    const catalogPrompt = buildSkillCatalogPrompt(input.skillCatalog ?? [])
    if (catalogPrompt) parts.push(catalogPrompt)
    for (const skill of input.referencedSkills ?? []) {
      parts.push(buildReferencedSkillPrompt(skill))
    }
    if (input.knownCapabilities?.length) {
      parts.push(`Capability vocabulary (only use these for requiredCapabilities):\n${input.knownCapabilities.join(', ')}`)
    } else {
      parts.push('Capability vocabulary: none provided yet — keep requiredCapabilities generic and few, or omit them.')
    }
    if (input.knownPermissions?.length) {
      parts.push(`IAM permission vocabulary (only use these for human_role.requiredPermissions):\n${input.knownPermissions.join(', ')}`)
    } else {
      parts.push('IAM permission vocabulary: none provided yet — omit human_role.requiredPermissions instead of inventing permission keys.')
    }
    if (input.existingSpec != null) {
      parts.push(`EXISTING spec to edit (return the full edited spec):\n${JSON.stringify(input.existingSpec)}`)
    }
    if (input.priorValidation && !input.priorValidation.valid) {
      parts.push(
        `The previous draft FAILED validation with these errors — fix them:\n${JSON.stringify(input.priorValidation.errors)}`,
      )
    }
    // A warningok NEM buktatják a draftot (`valid` maradhat true), de az
    // OUTPUT_CONTRACT_NOT_PROMPTED/OUTPUT_CONTRACT_INCOMPLETE (§checkOutputContractCoverage)
    // pontosan ilyen — visszacsatolás nélkül a szerző agent soha nem szembesülne vele,
    // csak a következő futáskor a runtime `output_contract_unmet` blokkjában.
    if (input.priorValidation?.warnings?.length) {
      parts.push(
        `The previous draft passed validation but raised these warnings — address them if reasonable:\n${JSON.stringify(input.priorValidation.warnings)}`,
      )
    }
    parts.push(`User request:\n${input.description}`)
    parts.push('Return ONLY the JSON descriptor.')

    return [
      {
        role: 'system',
        content: `${PLAYBOOK_AUTHOR_ROLE_INSTRUCTION}\n\n${outputLanguageInstruction(language)}`,
      },
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
    knownPermissions?: string[]
    /** A tenantból olvasható skillek Level-0 indexe (`SkillService.listReferenceCatalog`). */
    skillCatalog?: SkillReferenceEntry[]
    /** A kérésben hivatkozott skillek — teljes törzzsel (`detectReferencedSkills`). */
    referencedSkills?: SkillReferenceEntry[]
    existingSpec?: unknown
    priorValidation?: ValidationResult
    validationContext?: TenantValidationContext
    /** Tenant kimeneti nyelv — playbook name/description/instructionTemplate. */
    outputLanguage?: TenantLanguage
    sensitivityOverride?: SensitivityOverride
  }): Promise<PlaybookAuthorDraftResult> {
    if (!input.description?.trim() && input.existingSpec == null) {
      return { ok: false, error: 'PARSE_FAILED', detail: 'empty description' }
    }

    const messages = this.buildAuthoringMessages({
      description: input.description,
      knownCapabilities: input.knownCapabilities,
      knownPermissions: input.knownPermissions,
      skillCatalog: input.skillCatalog,
      referencedSkills: input.referencedSkills,
      existingSpec: input.existingSpec,
      priorValidation: input.priorValidation,
      outputLanguage: input.outputLanguage,
    })

    const modelConfig = this.deps.modelConfig ?? resolvePlaybookAuthorModelConfig(input.agentModelConfig)

    const responseJsonSchema = contractToJsonSchema(playbookDraftContract)
    const { content } = await this.deps.model.call({
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      tenantId: input.tenantId ?? undefined,
      conversationId: input.conversationId ?? undefined,
      messages,
      modelConfig,
      sensitivityOverride: input.sensitivityOverride,
      ...(responseJsonSchema ? { responseJsonSchema } : {}),
    })

    // #33 — alak-sértésnél javítási esély; tartósan hibás alak → PARSE_FAILED
    // (többé nem térünk vissza ok:true-val érvénytelen alakú, de „sikeres” drafttal).
    const structuringModel = toStructuringModelConfig(structuringModelFromEnv(), modelConfig)
    const strict = await runStrictContract({
      gateway: this.deps.model,
      contract: playbookDraftContract,
      rawContent: content,
      modelConfig,
      structuringModel,
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      tenantId: input.tenantId ?? undefined,
      conversationId: input.conversationId ?? undefined,
    })
    if (!strict.ok) {
      return { ok: false, error: 'PARSE_FAILED', detail: strict.humanSummary }
    }
    const raw = strict.value

    const knownCapabilities =
      input.validationContext?.knownCapabilities ??
      (input.knownCapabilities?.length ? new Set(input.knownCapabilities) : undefined)
    const knownPermissions =
      input.validationContext?.knownPermissions ??
      (input.knownPermissions?.length ? new Set(input.knownPermissions) : undefined)

    const validation = this.validator.validateSpec(raw, {
      ...input.validationContext,
      knownCapabilities,
      knownPermissions,
    })

    return { ok: true, spec: raw, validation }
  }
}

const SUPPORTED_AUTHOR_PROVIDERS = new Set(['chatgpt-oauth', 'claude-code-oauth', 'grok-cli-oauth', 'gemini', 'ollama', 'openrouter'])

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
