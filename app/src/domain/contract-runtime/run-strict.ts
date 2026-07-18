import type {
  GatewayMessage,
  ModelConfig,
} from '@/domain/gateway/model-gateway'
import { GatewaySensitivityError } from '@/domain/gateway/model-gateway'
import {
  collectJudgmentContentIssues,
  contractHasJudgmentChecks,
} from './content-check'
import { extractLoose } from './extract'
import { formatContractErrors } from './format-errors'
import { validateAgainstContract } from './validate'
import { contractToJsonSchema } from './compile'
import {
  DEFAULT_REPAIR_ATTEMPTS,
  HARD_MAX_REPAIR_ATTEMPTS,
  type CompiledContract,
  type ContractIssue,
  type CriticalityLevel,
  type StrictContractResult,
} from './types'

export type RunStrictContractInput = {
  /** Minimális kapu-felület — a ModelGateway és a fogyasztók thin model interfészei is megfelelnek. */
  gateway: {
    call(params: {
      agentId: string
      agentVersion?: number
      ticketId?: string
      tenantId?: string
      conversationId?: string
      messages: GatewayMessage[]
      modelConfig: ModelConfig
      responseJsonSchema?: Record<string, unknown>
    }): Promise<{
      content: string
      usage?: { promptTokens: number; completionTokens: number }
      /** EUR becslés, ha a kapu számolta. */
      costEstimate?: number
    }>
  }
  contract: CompiledContract
  /** Az agent eddigi (szabad) válasza — ezt validáljuk először, modellhívás nélkül. */
  rawContent: string
  /** A lépés már jóváhagyott modellje (érzékeny visszaesés ide). */
  modelConfig: ModelConfig
  /** Platform-szintű olcsó strukturáló modell. */
  structuringModel: ModelConfig
  agentId: string
  agentVersion?: number
  ticketId?: string
  tenantId?: string
  conversationId?: string
  criticality?: CriticalityLevel
  /** Lépésszintű felülbírálás; a kritikusság és a kemény 2-es korlát szűkíti. */
  maxRepairAttempts?: number
}

/**
 * Kritikusság + lépésszintű felülbírálás → tényleges javító próbaszám.
 * L3 → 0; egyébként min(requested, HARD_MAX); alap DEFAULT.
 */
export function resolveRepairAttempts(
  criticality: CriticalityLevel | undefined,
  requested?: number,
): number {
  if (criticality === 'L3') return 0
  const base = requested ?? DEFAULT_REPAIR_ATTEMPTS
  if (base < 0) return 0
  return Math.min(base, HARD_MAX_REPAIR_ATTEMPTS)
}

function parseCandidate(raw: string): unknown {
  const loose = extractLoose(raw)
  if (loose != null) return loose
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

/** Tartalmi-only hiba → nincs javító modellhívás (#45: modell csak ítéletnél). */
function isContentOnlyFailure(errors: ContractIssue[]): boolean {
  return errors.length > 0 && errors.every((e) => e.code === 'content')
}

function buildRepairMessages(input: {
  rawContent: string
  errorText: string
  fieldNames: string[]
}): GatewayMessage[] {
  return [
    {
      role: 'system',
      content: [
        'A feladatod: a megadott agent-válaszból kinyerni a kért szerkezetet érvényes JSON objektumként.',
        'NE találj ki adatot. Ha egy mező nem nyerhető ki egyértelműen a válaszból, hagyd ki vagy hagyd üresen.',
        'Ne kutass, ne hívj eszközt — csak formázás.',
        'Csak JSON objektumot adj vissza, magyarázat nélkül.',
        `Várt mezők: ${input.fieldNames.join(', ')}.`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Az agent eredeti válasza:',
        '---',
        input.rawContent,
        '---',
        '',
        'A szerkezet ellenőrzése ezeket a hibákat találta:',
        input.errorText,
        '',
        'Javítsd a JSON-t úgy, hogy ezek a hibák megszűnjenek — de ne találj ki hiányzó értéket.',
      ].join('\n'),
    },
  ]
}

/**
 * Szigorú mód: (1) ingyenes validáció a meglévő kimeneten,
 * (2) bukásnál javító hívás a modell-kapun a konkrét hibákkal,
 * (3) korlát kimerülésekor hibás eredmény (fail-closed a hívónál).
 */
export async function runStrictContract(
  input: RunStrictContractInput,
): Promise<StrictContractResult> {
  const maxAttempts = resolveRepairAttempts(input.criticality, input.maxRepairAttempts)
  let repairAttempts = 0
  let repairCostEstimate = 0
  let candidate = parseCandidate(input.rawContent)
  let validated = validateAgainstContract(input.contract, candidate)

  let lastErrors = validated.ok ? [] : validated.errors

  if (!validated.ok && isContentOnlyFailure(validated.errors)) {
    return {
      ok: false,
      errors: validated.errors,
      repairAttempts: 0,
      repairCostEstimate: 0,
      humanSummary: formatContractErrors(validated.errors),
    }
  }

  if (!validated.ok) {
    while (repairAttempts < maxAttempts) {
      repairAttempts++
      const errorText = formatContractErrors(lastErrors)
      const repairMessages = buildRepairMessages({
        rawContent: input.rawContent,
        errorText,
        fieldNames: input.contract.fieldNames,
      })

      const responseJsonSchema = contractToJsonSchema(input.contract)
      const callArgs = {
        agentId: input.agentId,
        agentVersion: input.agentVersion,
        ticketId: input.ticketId,
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        messages: repairMessages,
        ...(responseJsonSchema ? { responseJsonSchema } : {}),
      }

      // Strukturáló modell a kapun át. Érzékeny tartalomnál fail-closed: a lépés
      // már jóváhagyott modelljére esünk vissza (ne olcsó/külső strukturálóhoz).
      let response
      try {
        response = await input.gateway.call({
          ...callArgs,
          modelConfig: {
            ...input.structuringModel,
            fallbackModels: [
              ...(input.structuringModel.fallbackModels ?? []),
              { provider: input.modelConfig.provider, model: input.modelConfig.model },
            ],
          },
        })
      } catch (error) {
        if (!(error instanceof GatewaySensitivityError)) throw error
        response = await input.gateway.call({
          ...callArgs,
          modelConfig: input.modelConfig,
        })
      }

      if (typeof response.costEstimate === 'number' && Number.isFinite(response.costEstimate)) {
        repairCostEstimate += response.costEstimate
      }

      candidate = parseCandidate(response.content)
      validated = validateAgainstContract(input.contract, candidate)
      if (validated.ok) break
      lastErrors = validated.errors
      // Javítás után csak tartalmi hiba → ne pazaroljunk további modellhívást.
      if (isContentOnlyFailure(validated.errors)) break
    }
  }

  if (!validated.ok) {
    return {
      ok: false,
      errors: lastErrors,
      repairAttempts,
      repairCostEstimate,
      humanSummary: formatContractErrors(lastErrors),
    }
  }

  // #45 — ítélet jellegű tartalmi kapu csak explicit mező-deklarációnál (kapun át).
  if (contractHasJudgmentChecks(input.contract.fields)) {
    const judgmentIssues = await collectJudgmentContentIssues({
      gateway: input.gateway,
      contract: input.contract,
      value: validated.value,
      modelConfig: input.modelConfig,
      structuringModel: input.structuringModel,
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      ticketId: input.ticketId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
    })
    if (judgmentIssues.length > 0) {
      return {
        ok: false,
        errors: judgmentIssues,
        repairAttempts,
        repairCostEstimate,
        humanSummary: formatContractErrors(judgmentIssues),
      }
    }
  }

  return { ok: true, value: validated.value, repairAttempts, repairCostEstimate }
}
