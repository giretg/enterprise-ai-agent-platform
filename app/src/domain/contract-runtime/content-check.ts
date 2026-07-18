/**
 * Opcionális mezőszintű tartalmi ellenőrzés (#45).
 * Determinisztikus minta elsődleges; ítélet csak kapun át.
 */
import type {
  GatewayMessage,
  ModelConfig,
} from '@/domain/gateway/model-gateway'
import { GatewaySensitivityError } from '@/domain/gateway/model-gateway'
import { extractLoose } from './extract'
import type {
  CompiledContract,
  ContractContentCheck,
  ContractField,
  ContractIssue,
} from './types'

function fieldLabel(field: ContractField): string {
  return field.description ? `${field.name} (${field.description})` : field.name
}

/** Érték szöveges alakja mintához / ítélethez. */
export function valueAsCheckText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function contractHasJudgmentChecks(fields: ContractField[]): boolean {
  return fields.some((f) => f.contentCheck?.kind === 'judgment')
}

function evaluatePattern(
  field: ContractField,
  check: Extract<ContractContentCheck, { kind: 'pattern' }>,
  value: unknown,
): ContractIssue | null {
  const label = fieldLabel(field)
  let re: RegExp
  try {
    re = new RegExp(check.regex, check.flags ?? '')
  } catch {
    return {
      field: field.name,
      code: 'content',
      message: `A(z) «${label}» tartalmi szabálya érvénytelen (hibás minta).`,
    }
  }

  const text = valueAsCheckText(value)
  const matched = re.test(text)
  const expect = check.expect ?? 'match'
  const ok = expect === 'match' ? matched : !matched
  if (ok) return null

  const fallback =
    expect === 'notMatch'
      ? `A(z) «${label}» mező tartalma tiltott mintát tartalmaz.`
      : `A(z) «${label}» mező tartalma nem felel meg a várt mintának.`
  return {
    field: field.name,
    code: 'content',
    message: check.message?.trim() || fallback,
  }
}

/** Alaki siker után: determinisztikus tartalmi minták (ingyenes). */
export function collectPatternContentIssues(
  fields: ContractField[],
  value: Record<string, unknown>,
): ContractIssue[] {
  const issues: ContractIssue[] = []
  for (const field of fields) {
    const check = field.contentCheck
    if (!check || check.kind !== 'pattern') continue
    if (!(field.name in value) && field.required === false) continue
    const issue = evaluatePattern(field, check, value[field.name])
    if (issue) issues.push(issue)
  }
  return issues
}

type JudgmentGateway = {
  call(params: {
    agentId: string
    agentVersion?: number
    ticketId?: string
    tenantId?: string
    conversationId?: string
    messages: GatewayMessage[]
    modelConfig: ModelConfig
  }): Promise<{ content: string }>
}

function parseJudgmentPass(raw: string): { pass: boolean; reason?: string } {
  const loose = extractLoose(raw)
  if (loose && typeof loose === 'object' && !Array.isArray(loose)) {
    const o = loose as Record<string, unknown>
    if (typeof o.pass === 'boolean') {
      return {
        pass: o.pass,
        reason: typeof o.reason === 'string' ? o.reason : undefined,
      }
    }
    if (typeof o.ok === 'boolean') {
      return {
        pass: o.ok,
        reason: typeof o.reason === 'string' ? o.reason : undefined,
      }
    }
  }
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === 'true' || trimmed === 'pass' || trimmed === 'yes') {
    return { pass: true }
  }
  if (trimmed === 'false' || trimmed === 'fail' || trimmed === 'no') {
    return { pass: false }
  }
  // Értelmezhetetlen válasz → fail-closed
  return { pass: false, reason: 'A tartalmi ítélet nem volt egyértelmű.' }
}

/**
 * Ítélet jellegű tartalmi ellenőrzések a modell-kapun át.
 * Nincs judgment mező → üres lista, nulla hívás.
 */
export async function collectJudgmentContentIssues(input: {
  gateway: JudgmentGateway
  contract: CompiledContract
  value: Record<string, unknown>
  modelConfig: ModelConfig
  structuringModel: ModelConfig
  agentId: string
  agentVersion?: number
  ticketId?: string
  tenantId?: string
  conversationId?: string
}): Promise<ContractIssue[]> {
  const issues: ContractIssue[] = []
  for (const field of input.contract.fields) {
    const check = field.contentCheck
    if (!check || check.kind !== 'judgment') continue
    if (!(field.name in input.value) && field.required === false) continue

    const label = fieldLabel(field)
    const criterion = check.criterion.trim()
    if (!criterion) {
      issues.push({
        field: field.name,
        code: 'content',
        message: `A(z) «${label}» tartalmi ítélete nincs megadva.`,
      })
      continue
    }

    const messages: GatewayMessage[] = [
      {
        role: 'system',
        content: [
          'Te egy tartalmi kapu vagy. Eldöntöd, hogy a megadott mezőérték megfelel-e a kritériumnak.',
          'Csak JSON objektumot adj vissza: {"pass":true} vagy {"pass":false,"reason":"rövid magyar indok"}.',
          'Ne találj ki adatot, ne javítsd az értéket — csak ítélj.',
          `Kritérium: ${criterion}`,
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Mező: ${field.name}`,
          `Érték:`,
          valueAsCheckText(input.value[field.name]),
        ].join('\n'),
      },
    ]

    const callArgs = {
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      ticketId: input.ticketId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messages,
    }

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

    const verdict = parseJudgmentPass(response.content)
    if (verdict.pass) continue

    issues.push({
      field: field.name,
      code: 'content',
      message:
        check.message?.trim() ||
        verdict.reason?.trim() ||
        `A(z) «${label}» mező nem felel meg a tartalmi követelménynek.`,
    })
  }
  return issues
}
