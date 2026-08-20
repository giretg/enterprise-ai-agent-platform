/**
 * Strukturált tool-output pszeudonimizáció (APG-04, spec §7; APG-09 OBSERVE; APG-10 batch).
 *
 * A connector `fields` sémája szerint a `tokenize` string mezők értékét
 * ref-surrogate-ra cseréli. Numerikus/dátum mezőt nem nyúl meg (R6). A bemenetet
 * nem mutálja: a modellnek szánt másolat készül. Tömbökben ugyanaz az
 * `(entityType, sourceId)` ugyanazt az álnevet kapja. Az allokáció batchelve
 * megy a vaultba — nem rekordonkénti írás.
 *
 * OBSERVE (`apply: false`): a spaneket összegyűjti vault-írás nélkül — a
 * modellnek szánt adat érintetlen marad.
 */
import type { ConnectorFieldsPrivacy } from '@/domain/privacy/connector-privacy'
import type { PrivacySpan } from '@/domain/privacy/privacy-mode'
import { runPrivacyTransformLayer } from '@/domain/privacy/privacy-transform-failure'
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

export type StructuredPrivacyTransformResult = {
  output: unknown
  spans: PrivacySpan[]
}

export async function pseudonymizeStructuredOutput(
  input: StructuredOutputPrivacyInput,
): Promise<unknown> {
  const result = await transformStructuredOutput({ ...input, apply: true })
  return result.output
}

export async function transformStructuredOutput(
  input: StructuredOutputPrivacyInput & { apply: boolean },
): Promise<StructuredPrivacyTransformResult> {
  const tokenize = tokenizeFields(input.fields)
  if (!tokenize) return { output: input.output, spans: [] }

  let copy: unknown
  try {
    copy = structuredClone(input.output)
  } catch {
    return { output: input.output, spans: [] }
  }
  const spans: PrivacySpan[] = []
  const pending: PendingReplace[] = []
  collect(copy, tokenize, input, spans, pending)
  if (pending.length > 0 && input.apply) {
    await runPrivacyTransformLayer({
      layer: 'structured_field',
      mode: 'enforce',
      work: async () => {
        const surrogates = await input.engine.allocateRefs(
          pending.map((slot) => ({
            tenantId: input.tenantId,
            scope: input.scope,
            entityType: slot.entityType,
            connectorId: input.connectorId,
            sourceId: slot.sourceId,
            displayValue: slot.displayValue,
          })),
        )
        for (let i = 0; i < pending.length; i += 1) {
          const slot = pending[i]
          const surrogate = surrogates[i]
          if (!slot || !surrogate) continue
          slot.record[slot.key] = surrogate
        }
      },
      onFailOpen: () => {},
    })
  }
  return { output: copy, spans }
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

type PendingReplace = {
  record: Record<string, unknown>
  key: string
  entityType: SurrogateEntityType
  sourceId: string
  displayValue: string
}

function collect(
  value: unknown,
  tokenize: Record<string, TokenizeField>,
  ctx: StructuredOutputPrivacyInput & { apply: boolean },
  spans: PrivacySpan[],
  pending: PendingReplace[],
): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collect(item, tokenize, ctx, spans, pending)
    return
  }

  const record = value as Record<string, unknown>
  for (const [key, child] of Object.entries(record)) {
    const spec = tokenize[key]
    if (spec && typeof child === 'string' && child.length > 0) {
      const sourceId = resolveSourceId(spec.sourceIdTemplate, record)
      if (sourceId) {
        spans.push({ entityType: spec.entityType, field: key })
        if (ctx.apply) {
          pending.push({
            record,
            key,
            entityType: spec.entityType,
            sourceId,
            displayValue: child,
          })
        }
        continue
      }
    }
    collect(child, tokenize, ctx, spans, pending)
  }
}
