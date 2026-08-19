/**
 * Strukturált tool-output pszeudonimizáció (APG-04, spec §7).
 *
 * A connector `fields` sémája szerint a `tokenize` string mezők értékét
 * ref-surrogate-ra cseréli. Numerikus/dátum mezőt nem nyúl meg (R6). A bemenetet
 * nem mutálja: a modellnek szánt másolat készül. Tömbökben ugyanaz az
 * `(entityType, sourceId)` ugyanazt az álnevet kapja.
 */
import type { ConnectorFieldsPrivacy } from '@/domain/privacy/connector-privacy'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import type { SurrogateEntityType } from '@/domain/privacy/surrogate-format'
import { isSurrogateEntityType } from '@/domain/privacy/surrogate-format'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g

export type StructuredOutputPrivacyInput = {
  output: unknown
  fields: ConnectorFieldsPrivacy | undefined
  engine: SurrogateEngine
  tenantId: string
  connectorId: string
  scope: PrivacyScope
}

export async function pseudonymizeStructuredOutput(
  input: StructuredOutputPrivacyInput,
): Promise<unknown> {
  const tokenize = tokenizeFields(input.fields)
  if (!tokenize) return input.output

  let copy: unknown
  try {
    copy = structuredClone(input.output)
  } catch {
    return input.output
  }
  await walk(copy, tokenize, input)
  return copy
}

type TokenizeField = {
  entityType: SurrogateEntityType
  sourceIdTemplate: string | undefined
}

function tokenizeFields(
  fields: ConnectorFieldsPrivacy | undefined,
): Record<string, TokenizeField> | null {
  if (!fields) return null
  const tokenize: Record<string, TokenizeField> = {}
  for (const [name, spec] of Object.entries(fields)) {
    if (spec.privacy !== 'tokenize') continue
    if (!spec.entity_type || !isSurrogateEntityType(spec.entity_type)) continue
    tokenize[name] = { entityType: spec.entity_type, sourceIdTemplate: spec.source_id }
  }
  return Object.keys(tokenize).length > 0 ? tokenize : null
}

function resolveSourceId(
  template: string | undefined,
  record: Record<string, unknown>,
): string | null {
  if (!template) return null
  let missing = false
  const resolved = template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (typeof value === 'bigint') return value.toString()
    missing = true
    return ''
  })
  return missing || resolved.length === 0 ? null : resolved
}

async function walk(
  value: unknown,
  tokenize: Record<string, TokenizeField>,
  ctx: StructuredOutputPrivacyInput,
): Promise<void> {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) await walk(item, tokenize, ctx)
    return
  }

  const record = value as Record<string, unknown>
  for (const [key, child] of Object.entries(record)) {
    const spec = tokenize[key]
    if (spec && typeof child === 'string' && child.length > 0) {
      const sourceId = resolveSourceId(spec.sourceIdTemplate, record)
      if (sourceId) {
        record[key] = await ctx.engine.allocateRef({
          tenantId: ctx.tenantId,
          scope: ctx.scope,
          entityType: spec.entityType,
          connectorId: ctx.connectorId,
          sourceId,
          displayValue: child,
        })
        continue
      }
    }
    await walk(child, tokenize, ctx)
  }
}
