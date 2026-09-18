import type { ZodError } from 'zod'
import { collectPatternContentIssues } from './content-check'
import type {
  CompiledContract,
  ContractIssue,
  ValidationResult,
} from './types'

function issueFromZod(error: ZodError, fields: CompiledContract['fields']): ContractIssue[] {
  const byName = new Map(fields.map((f) => [f.name, f]))
  return error.issues.map((issue) => {
    const field = String(issue.path[0] ?? '')
    const meta = byName.get(field)
    const label = meta?.description ? `${field} (${meta.description})` : field || '(gyökér)'

    if (issue.code === 'invalid_type' && (issue as { received?: string }).received === 'undefined') {
      return {
        field,
        code: 'missing' as const,
        message: `A(z) «${label}» mező hiányzik.`,
      }
    }
    if (issue.code === 'too_small') {
      return {
        field,
        code: 'empty' as const,
        message: `A(z) «${label}» mező üres — kitöltött értéket vártunk.`,
      }
    }
    if (issue.code === 'invalid_value') {
      const values = meta?.enumValues?.join(', ') ?? ''
      return {
        field,
        code: 'enum' as const,
        message: values
          ? `A(z) «${label}» mező csak ezeket az értékeket veheti fel: ${values}.`
          : `A(z) «${label}» mező értéke nem szerepel a megengedett listában.`,
      }
    }
    if (issue.code === 'invalid_type') {
      const expected = (issue as { expected?: string }).expected
      return {
        field,
        code: 'type' as const,
        message: expected
          ? `A(z) «${label}» mezőben ${typeLabelHu(expected)} értéket vártunk.`
          : `A(z) «${label}» mező típusa nem megfelelő.`,
      }
    }
    return {
      field,
      code: 'invalid' as const,
      message: `A(z) «${label}» mező érvénytelen: ${issue.message}`,
    }
  })
}

function typeLabelHu(expected: string): string {
  switch (expected) {
    case 'number':
      return 'szám'
    case 'boolean':
      return 'igen/nem (logikai)'
    case 'string':
      return 'szöveg'
    case 'array':
      return 'lista'
    case 'object':
      return 'összetett'
    default:
      return expected
  }
}

/**
 * Validál egy már parse-olt objektumot a lefordított contract ellen.
 * Üres string ≠ kitöltött.
 */
export function validateAgainstContract(
  contract: CompiledContract,
  value: unknown,
): ValidationResult {
  if (contract.fieldNames.length === 0) {
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      return { ok: true, value: value as Record<string, unknown> }
    }
    return { ok: true, value: {} }
  }

  const parsed = contract.schema.safeParse(value)
  if (!parsed.success) {
    return { ok: false, errors: issueFromZod(parsed.error, contract.fields) }
  }

  // #45 — alaki siker után determinisztikus tartalmi minták (deklaráció nélkül üres).
  const contentIssues = collectPatternContentIssues(contract.fields, parsed.data)
  if (contentIssues.length > 0) {
    return { ok: false, errors: contentIssues }
  }

  return { ok: true, value: parsed.data }
}
