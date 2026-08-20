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
import { VaultUnavailableError } from '@/domain/privacy/privacy-transform-failure'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import type { SurrogateEntityType } from '@/domain/privacy/surrogate-format'
import { isSurrogateEntityType } from '@/domain/privacy/surrogate-format'
import type { PrivacyScope } from '@/domain/privacy/surrogate-vault'

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g

export type StructuredOutputPrivacyInput = {
  output: unknown
  fields: ConnectorFieldsPrivacy | undefined
  engine?: SurrogateEngine | null
  tenantId?: string | null
  connectorId?: string | null
  scope?: PrivacyScope | null
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
  const actions = privacyFields(input.fields)
  if (!actions) return { output: input.output, spans: [] }

  return runPrivacyTransformLayer({
    layer: 'structured_field',
    work: async () => {
      const copy = structuredClone(input.output)
      const spans: PrivacySpan[] = []
      const pending: PendingReplace[] = []
      collect(copy, actions, input, spans, pending)
      if (pending.length > 0 && input.apply) {
        if (!input.engine) throw new VaultUnavailableError()
        if (!input.tenantId || !input.connectorId || !input.scope) {
          throw new Error('A strukturált privacy transzformáció scope-ja hiányzik.')
        }
        const tenantId = input.tenantId
        const connectorId = input.connectorId
        const scope = input.scope
        const surrogates = await input.engine.allocateRefs(
          pending.map((slot) => ({
            tenantId,
            scope,
            entityType: slot.entityType,
            connectorId,
            sourceId: slot.sourceId,
            displayValue: slot.displayValue,
            displayValueSource: 'structured_field',
          })),
        )
        if (surrogates.length !== pending.length) {
          throw new Error('Az álnév-allokáció hiányos eredményt adott.')
        }
        for (let i = 0; i < pending.length; i += 1) {
          const slot = pending[i]
          const surrogate = surrogates[i]
          if (!slot || !surrogate) throw new Error('Az álnév-allokáció hiányos eredményt adott.')
          slot.record[slot.key] = surrogate
        }
      }
      return { output: copy, spans }
    },
    onFailOpen: () => ({ output: input.output, spans: [] }),
  }).then((result) => result.value)
}

type TokenizeField = {
  entityType: SurrogateEntityType
  sourceIdTemplate?: string
}

type StructuredPrivacyFields = {
  tokenize: Record<string, TokenizeField>
  blocked: Set<string>
}

function privacyFields(
  fields: ConnectorFieldsPrivacy | undefined,
): StructuredPrivacyFields | null {
  if (!fields) return null
  const tokenize: Record<string, TokenizeField> = {}
  const blocked = new Set<string>()
  for (const [name, spec] of Object.entries(fields)) {
    if (spec.privacy === 'block') {
      blocked.add(name)
      continue
    }
    if (spec.privacy !== 'tokenize') continue
    if (!spec.entity_type || !isSurrogateEntityType(spec.entity_type)) {
      throw new Error(`Hibás tokenize deklaráció: ${name}`)
    }
    tokenize[name] = { entityType: spec.entity_type, sourceIdTemplate: spec.source_id }
  }
  return Object.keys(tokenize).length > 0 || blocked.size > 0 ? { tokenize, blocked } : null
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
  fields: StructuredPrivacyFields,
  ctx: StructuredOutputPrivacyInput & { apply: boolean },
  spans: PrivacySpan[],
  pending: PendingReplace[],
): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collect(item, fields, ctx, spans, pending)
    return
  }

  const record = value as Record<string, unknown>
  for (const [key, child] of Object.entries(record)) {
    if (fields.blocked.has(key)) {
      delete record[key]
      continue
    }
    const spec = fields.tokenize[key]
    if (spec && typeof child === 'string' && child.length > 0) {
      const sourceId = resolveSourceId(spec.sourceIdTemplate, record)
      if (!sourceId && ctx.apply) {
        throw new Error(`A(z) ${key} mező source_id értéke nem oldható fel a payloadból.`)
      }
      spans.push({ entityType: spec.entityType, field: key })
      if (ctx.apply) {
        if (!sourceId) throw new Error(`A(z) ${key} mező stabil source_id értéke hiányzik.`)
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
    collect(child, fields, ctx, spans, pending)
  }
}
