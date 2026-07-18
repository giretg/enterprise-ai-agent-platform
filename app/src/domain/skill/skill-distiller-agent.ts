/**
 * Skill-desztilláló agent (skill-catalog-spec.md §D14, WP-6 harmadik szerzési forrás).
 *
 * A Claude-nál bevett minta („készíts ebből skillt") governance-konform megvalósítása:
 * egy lezajlott beszélgetésből (conversation/ticket) instrukció-only skill-DRAFT-ot
 * desztillál. A §4.6.3 reflexió-feeder user-triggerelt változata.
 *
 * GOVERNANCE (a `PlaybookAuthorAgent` és a Provisioning Assistant mintája):
 *  - A modell kimenete CSAK adat (propose-not-apply). Az agent SOSEM ír a DB-be,
 *    SOSEM publikál — a hívó (`SkillService.distillFromConversation`) a visszaadott
 *    draftot a változatlan write-gate kapun (`proposed → approved → active`) engedi át.
 *  - A beszélgetés NEM megbízható input (prompt-injection a chatben, manipulált agent):
 *    a draft a hardcoded `validateSkill` kapun megy át, provenience-kedvezmény nélkül (D14).
 *  - **A `requires` NEM a modelltől jön.** A kemény padló szerint a `requires`-t a
 *    beszélgetésben TÉNYLEGESEN meghívott toolokból vezetjük le determinisztikusan; a
 *    modell csak a puha részt (instrukciók/leírás) desztillálja. A capability-grant külön,
 *    magasabb jogú humán aktus marad — a skill sosem ad magának jogot.
 *  - **Instrukció-only → T0/T1 → Fázis 1.** A modellt kód-kiemelés tiltására utasítjuk,
 *    a validátor pedig kód-jelenlét esetén elutasít (a T0/T1 kényszerítés teherhordója
 *    a determinista validátor, nem a prompt).
 */
import type { GatewayMessage, ModelConfig, SensitivityOverride } from '@/domain/gateway/model-gateway'
import { extractJsonObject } from '@/domain/provisioning/provisioning-assistant'
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_NAME_MAX,
  type SkillContent,
} from '@/lib/skill/skill-content'
import {
  DEFAULT_TENANT_LANGUAGE,
  outputLanguageInstruction,
  type TenantLanguage,
} from '@/lib/tenant-language'

/** A desztilláló system-instrukció. A kimenet KIZÁRÓLAG a lenti JSON-alak lehet. */
export const SKILL_DISTILLER_ROLE_INSTRUCTION = `You are a Skill Distillation Assistant. Your ONLY job is to read a completed conversation transcript between a user and an AI agent, and distill the reusable, generalizable working method into a DRAFT skill definition as structured JSON. You PROPOSE; you never apply, activate, assign, or publish anything.

HARD RULES (non-negotiable):
- Output INSTRUCTIONS ONLY. Never include runnable code, scripts, shell commands, code fences, or shebang lines. If the conversation contained code, describe the METHOD in prose instead of reproducing the code. A skill that carries code is out of scope and will be rejected.
- Distill the GENERAL, REUSABLE procedure — not the specific facts, names, numbers, or one-off answers from this particular conversation. The skill must be useful for a future, different task of the same kind.
- Do NOT invent tool requirements or capabilities. You do not decide what tools the skill needs — that is derived separately from what the conversation actually used. Do not output a "requires" field.
- Never output secrets, credentials, API keys, personal data, or verbatim sensitive values as examples.
- The "description" is a short Level-0 index line (max ${SKILL_DESCRIPTION_MAX} chars) shown before the skill is loaded: say what the skill is for and when to use it, in one or two sentences.
- The "instructions" is an ordered array of self-contained instruction blocks (the actual step-by-step method). Write imperative, agent-facing guidance.
- "triggerKeywords" are a few short phrases that signal this skill is relevant.

OUTPUT: a single JSON object only (no prose, no markdown fences) matching this shape:
{
  "name": string (short, human-readable),
  "description": string (Level-0 index line),
  "instructions": string[] (ordered instruction blocks),
  "triggerKeywords": string[] (optional, may be empty)
}`

/** A desztillációhoz használt modell — a `ModelGateway` strukturálisan kielégíti. */
export interface SkillDistillingModel {
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

/** Egy beszélgetés-forduló a transzkriptben (a desztilláló bemenete). */
export interface DistillTranscriptTurn {
  role: 'user' | 'agent'
  text: string
}

export interface SkillDistillDraft {
  name: string
  description: string
  content: SkillContent
}

export type SkillDistillResult =
  | { ok: true; draft: SkillDistillDraft }
  | { ok: false; error: 'PARSE_FAILED'; detail: string }

export interface SkillDistillerDeps {
  model: SkillDistillingModel
  /** Fallback modell-konfiguráció, ha az agenté nem használható. */
  modelConfig?: ModelConfig
}

const DEFAULT_DISTILLER_MODEL_CONFIG: ModelConfig = {
  provider: 'chatgpt-oauth',
  model: 'chatgpt-oauth-default',
  temperature: 0,
}

const SUPPORTED_DISTILLER_PROVIDERS = new Set(['chatgpt-oauth', 'gemini', 'ollama', 'openrouter'])

/** A desztilláló modell-konfigurációja az agent Registry-beli configból (vagy fallback). */
export function resolveSkillDistillerModelConfig(agentModelConfig: unknown): ModelConfig {
  if (typeof agentModelConfig === 'object' && agentModelConfig !== null && !Array.isArray(agentModelConfig)) {
    const raw = agentModelConfig as Record<string, unknown>
    const provider = raw.provider
    const model = raw.model
    if (typeof provider === 'string' && typeof model === 'string' && SUPPORTED_DISTILLER_PROVIDERS.has(provider)) {
      return {
        provider,
        model,
        ...(typeof raw.temperature === 'number' ? { temperature: raw.temperature } : {}),
        ...(typeof raw.maxTokens === 'number' ? { maxTokens: raw.maxTokens } : {}),
      }
    }
  }
  return { ...DEFAULT_DISTILLER_MODEL_CONFIG }
}

/**
 * A transzkript-fordulókból a modellnek átadott, tömör szöveges átirat. Méret-limit
 * (token-ökonómia): a legfrissebb fordulókat tartjuk meg, ha a beszélgetés hosszú.
 */
export function buildTranscriptText(turns: DistillTranscriptTurn[], maxChars = 24_000): string {
  const lines = turns
    .filter((t) => t.text.trim().length > 0)
    .map((t) => `${t.role === 'user' ? 'User' : 'Agent'}: ${t.text.trim()}`)
  let text = lines.join('\n\n')
  if (text.length > maxChars) {
    // A vég (a beszélgetés kifutása/eredménye) a legértékesebb — hátulról tartunk.
    text = `…(korábbi rész levágva)…\n\n${text.slice(text.length - maxChars)}`
  }
  return text
}

/**
 * A modellnek átadott üzenetek: system-instrukció + a transzkript + (opcionálisan)
 * a beszélgetésben ténylegesen használt toolok listája — utóbbi CSAK kontextus a
 * jobb instrukciókhoz, NEM a `requires` forrása (azt a hívó vezeti le determinisztikusan).
 */
export function buildDistillMessages(input: {
  transcript: string
  usedTools?: string[]
  outputLanguage?: TenantLanguage
}): GatewayMessage[] {
  const language = input.outputLanguage ?? DEFAULT_TENANT_LANGUAGE
  const parts: string[] = []
  parts.push(
    'Distill a reusable skill from this completed conversation. Focus on the general method, not the specific facts of this run.',
  )
  if (input.usedTools?.length) {
    parts.push(
      `For context, the agent used these tools during the conversation (do NOT output a requires field — this is only to help you describe the method):\n${input.usedTools.join(', ')}`,
    )
  }
  parts.push(`Conversation transcript:\n${input.transcript}`)
  parts.push('Return ONLY the JSON descriptor.')
  return [
    {
      role: 'system',
      content: `${SKILL_DISTILLER_ROLE_INSTRUCTION}\n\n${outputLanguageInstruction(language)}`,
    },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

/**
 * A modell nyers JSON kimenetének biztonságos parse-olása a `SkillDistillDraft`
 * alakra. Hibás/hiányzó mezőket tolerál (üresre esik), a méret-limiteket levágja —
 * a teherhordó validáció (`validateSkill`) a hívónál fut, ez csak alak-normalizálás.
 */
export function parseDistillOutput(content: string): SkillDistillResult {
  const raw = extractJsonObject(content)
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'PARSE_FAILED', detail: 'no JSON object in model output' }
  }
  const obj = raw as Record<string, unknown>
  const name = typeof obj.name === 'string' ? obj.name.trim().slice(0, SKILL_NAME_MAX) : ''
  const description =
    typeof obj.description === 'string' ? obj.description.trim().slice(0, SKILL_DESCRIPTION_MAX) : ''
  const instructions = Array.isArray(obj.instructions)
    ? obj.instructions.filter((i): i is string => typeof i === 'string' && i.trim().length > 0).map((i) => i.trim())
    : []
  const triggerKeywords = Array.isArray(obj.triggerKeywords)
    ? obj.triggerKeywords
        .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
        .map((k) => k.trim())
    : []
  if (!name || !description || instructions.length === 0) {
    return { ok: false, error: 'PARSE_FAILED', detail: 'missing name/description/instructions' }
  }
  return {
    ok: true,
    draft: {
      name,
      description,
      content: { instructions, triggerKeywords, parameters: [] },
    },
  }
}

/**
 * A desztilláló agent: transzkript → skill-DRAFT (propose-not-apply). SOSEM ír a DB-be.
 * A `requires`-t NEM ez adja — a hívó a ténylegesen használt toolokból vezeti le.
 */
export class SkillDistillerAgent {
  constructor(private deps: SkillDistillerDeps) {}

  async distill(input: {
    agentId: string
    agentVersion?: number
    agentModelConfig?: unknown
    tenantId?: string | null
    conversationId?: string | null
    turns: DistillTranscriptTurn[]
    usedTools?: string[]
    /** Tenant kimeneti nyelv — skill name/description/instructions. */
    outputLanguage?: TenantLanguage
    sensitivityOverride?: SensitivityOverride
  }): Promise<SkillDistillResult> {
    const transcript = buildTranscriptText(input.turns)
    if (transcript.trim().length === 0) {
      return { ok: false, error: 'PARSE_FAILED', detail: 'empty transcript' }
    }
    const messages = buildDistillMessages({
      transcript,
      usedTools: input.usedTools,
      outputLanguage: input.outputLanguage,
    })
    const modelConfig = this.deps.modelConfig ?? resolveSkillDistillerModelConfig(input.agentModelConfig)

    const { content } = await this.deps.model.call({
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      tenantId: input.tenantId ?? undefined,
      conversationId: input.conversationId ?? undefined,
      messages,
      modelConfig,
      sensitivityOverride: input.sensitivityOverride,
    })

    return parseDistillOutput(content)
  }
}
