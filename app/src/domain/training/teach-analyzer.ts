/**
 * MemoryTraining §4.4.1 — tanítás illesztése a meglévő szabályverzióhoz.
 * A modell CSAK tervet javasol; a kapu a sanitizeTeachPlan + applyTeachPlan.
 */
import { z } from 'zod'
import type { GatewayMessage, ModelConfig } from '@/domain/gateway/model-gateway'
import {
  compileFromZod,
  contractToJsonSchema,
  runStrictContract,
  structuringModelFromEnv,
  toStructuringModelConfig,
} from '@/domain/contract-runtime'
import { resolveProvisioningModelConfig } from '@/domain/provisioning/provisioning-assistant'
import {
  emptyTeachPlan,
  sanitizeTeachPlan,
  type TeachPlan,
} from './teach-plan'

export const TEACH_ANALYZER_ROLE_INSTRUCTION = `Szereped: a betanított működési szabályok szerkesztője. Az új tanítást a meglévő szabályokhoz illeszted. Javasolsz, nem döntesz, és nem aktiválsz semmit.

SZABÁLYOK:
- Ha az új tanítás NEM mond ellent a meglévőknek (új, kiegészítő elvárás), tedd az "added" listára, és a régi szabályokat hagyd békén.
- Ha ellentmond (más formátum, más szín, más kötelező viselkedés, más tiltás), a konfliktusos régi szabályokat "rewritten" vagy "removed" alá tedd. A rewritten.from legyen PONTOSAN egy meglévő szabály szövege.
- Ne ismételd ugyanazt a mondatot added-ben és rewritten.to-ban.
- Ne találj ki jogosultság-, tool-, connector- vagy tenant-változást.
- A javasolt szövegek legyenek tömörek, a tanítás nyelvén.

Kimenet CSAK JSON, próza és markdown nélkül:
{ "added": string[], "rewritten": [{ "from": string, "to": string }], "removed": string[] }`

const teachPlanSchema = z.object({
  added: z.array(z.string()).default([]),
  rewritten: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
      }),
    )
    .default([]),
  removed: z.array(z.string()).default([]),
})

const teachPlanContract = compileFromZod(teachPlanSchema as z.ZodType<Record<string, unknown>>)

export type TeachAnalyzerInput = {
  existingItems: string[]
  teaching: string
  agentId: string
  agentVersion?: number
  tenantId?: string | null
  modelConfig?: unknown
}

export interface TeachAnalyzer {
  analyze(input: TeachAnalyzerInput): Promise<TeachPlan>
}

export type TeachModel = {
  call: (params: {
    agentId: string
    agentVersion?: number
    tenantId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
    responseJsonSchema?: Record<string, unknown>
  }) => Promise<{ content: string }>
}

function numberedRules(items: string[]): string {
  if (items.length === 0) return '(nincs még betanított szabály)'
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n')
}

/** A tanítási terv rövid JSON; az agent chat-plafonja (16k) itt túl hosszú hívást okozna. */
export const TEACH_ANALYZER_MAX_TOKENS = 4096

/** Az előnézet UI-ja ettől tovább nem vár modellre. */
export const TEACH_ANALYZER_TIMEOUT_MS = 90_000

export const TEACH_ANALYZER_TIMEOUT_ERROR =
  'Az új tanítás elemzése túl sokáig tartott. Próbáld újra.'

function capTeachModelConfig(config: ModelConfig): ModelConfig {
  return {
    ...config,
    maxTokens: Math.min(config.maxTokens ?? TEACH_ANALYZER_MAX_TOKENS, TEACH_ANALYZER_MAX_TOKENS),
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } catch (error) {
    void promise.catch(() => {})
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class LlmTeachAnalyzer implements TeachAnalyzer {
  constructor(
    private deps: {
      model: TeachModel
      modelConfig?: ModelConfig
      timeoutMs?: number
    },
  ) {}

  async analyze(input: TeachAnalyzerInput): Promise<TeachPlan> {
    const teaching = input.teaching.trim()
    if (!teaching) return emptyTeachPlan('')
    if (input.existingItems.length === 0) return emptyTeachPlan(teaching)

    const timeoutMs = this.deps.timeoutMs ?? TEACH_ANALYZER_TIMEOUT_MS
    return withTimeout(this.runAnalyze(input, teaching), timeoutMs, TEACH_ANALYZER_TIMEOUT_ERROR)
  }

  private async runAnalyze(input: TeachAnalyzerInput, teaching: string): Promise<TeachPlan> {
    const modelConfig = capTeachModelConfig(
      this.deps.modelConfig ?? resolveProvisioningModelConfig(input.modelConfig),
    )
    const messages: GatewayMessage[] = [
      { role: 'system', content: TEACH_ANALYZER_ROLE_INSTRUCTION },
      {
        role: 'user',
        content: [
          'MEGLÉVŐ SZABÁLYOK:',
          numberedRules(input.existingItems),
          '',
          'ÚJ TANÍTÁS:',
          teaching,
        ].join('\n'),
      },
    ]
    const responseJsonSchema = contractToJsonSchema(teachPlanContract)
    const { content } = await this.deps.model.call({
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      tenantId: input.tenantId ?? undefined,
      messages,
      modelConfig,
      ...(responseJsonSchema ? { responseJsonSchema } : {}),
    })

    const structuringModel = capTeachModelConfig(
      toStructuringModelConfig(structuringModelFromEnv(), modelConfig),
    )
    const strict = await runStrictContract({
      gateway: this.deps.model,
      contract: teachPlanContract,
      rawContent: content,
      modelConfig,
      structuringModel,
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      tenantId: input.tenantId ?? undefined,
    })
    if (!strict.ok) {
      throw new Error('Az új tanítás elemzése nem sikerült. Próbáld újra.')
    }
    const raw = strict.value as TeachPlan
    return sanitizeTeachPlan(input.existingItems, raw, teaching)
  }
}
