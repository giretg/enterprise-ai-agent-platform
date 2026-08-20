/**
 * APG-22 — Privacy observability (spec §14).
 *
 * A felhasználó a valódi értéket látja kiemelve; hover/debug panel mutatja az
 * entitástípust és a transzformáció státuszát. Admin nézetben végigkövethető a
 * lánc: eredeti → védelem → modell-bemenet → modell-kimenet → felhasználói kimenet.
 *
 * Építőelemek: `collectSensitivityMatchSpans` (minták) + strukturált connector mezők.
 */
import { collectSensitivityMatchSpans } from '@/domain/gateway/sensitivity-router'
import type { ConnectorFieldsPrivacy } from '@/domain/privacy/connector-privacy'
import { PRIVACY_CATEGORY_LABELS } from '@/domain/privacy/privacy-admin-copy'
import {
  actionForPrivacyCategory,
  canonicalPrivacyCategory,
  type PrivacyCategoryAction,
  type ResolvedPrivacyCategoryPolicy,
} from '@/domain/privacy/privacy-category-policy'
import { previewAliasForCategory } from '@/domain/privacy/privacy-dry-run'
import type { PrivacyGatewayMode } from '@/domain/privacy/privacy-mode'
import { isSurrogateEntityType } from '@/domain/privacy/surrogate-format'
import {
  PRIVACY_CHAIN_STAGE_LABELS,
  PRIVACY_TRANSFORM_STATUS_LABELS,
} from '@/domain/privacy/privacy-observability-copy'

export type PrivacyTransformStatus = 'observed' | 'applied' | 'skipped' | 'blocked' | 'none'

export type PrivacyEntityMarker = {
  start: number
  end: number
  category: string
  categoryLabel: string
  displayValue: string
  status: PrivacyTransformStatus
  action: PrivacyCategoryAction
  previewAlias: string | null
  source: 'pattern' | 'structured_field'
  field?: string
}

export type PrivacyTurnChainStageId =
  | 'original'
  | 'transformation'
  | 'llm_input'
  | 'llm_output'
  | 'user_output'

export type PrivacyTurnChainStage = {
  id: PrivacyTurnChainStageId
  label: string
  text: string
  markers: PrivacyEntityMarker[]
  summary?: string
}

export type PrivacyTurnChain = {
  mode: PrivacyGatewayMode
  stages: PrivacyTurnChainStage[]
  markerCount: number
  empty: boolean
}

export type PrivacyTurnChainInput = {
  mode: PrivacyGatewayMode
  policy: ResolvedPrivacyCategoryPolicy
  originalText: string
  structuredOutput?: unknown
  connectorFields?: ConnectorFieldsPrivacy
  llmInputText?: string
  llmOutputText?: string
  userOutputText?: string
}

function categoryLabel(category: string): string {
  return PRIVACY_CATEGORY_LABELS[category]?.label ?? category
}

function transformStatus(
  action: PrivacyCategoryAction,
  mode: PrivacyGatewayMode,
): PrivacyTransformStatus {
  if (mode === 'off') return 'none'
  if (action === 'block') return 'blocked'
  if (action === 'allow' || action === 'local_only') return 'skipped'
  if (action === 'tokenize') return mode === 'enforce' ? 'applied' : 'observed'
  return 'none'
}

function findAllPositions(text: string, needle: string, from = 0): number[] {
  const positions: number[] = []
  if (!needle) return positions
  let cursor = from
  while (cursor < text.length) {
    const index = text.indexOf(needle, cursor)
    if (index < 0) break
    positions.push(index)
    cursor = index + Math.max(needle.length, 1)
  }
  return positions
}

function mergeMarkers(markers: PrivacyEntityMarker[]): PrivacyEntityMarker[] {
  const sorted = [...markers].sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: PrivacyEntityMarker[] = []
  for (const marker of sorted) {
    const last = merged[merged.length - 1]
    if (last && marker.start < last.end) {
      if (marker.end - marker.start > last.end - last.start) merged[merged.length - 1] = marker
      continue
    }
    merged.push(marker)
  }
  return merged
}

export function buildPatternEntityMarkers(input: {
  text: string
  policy: ResolvedPrivacyCategoryPolicy
  mode: PrivacyGatewayMode
}): PrivacyEntityMarker[] {
  const ordinals = new Map<string, number>()
  const markers: PrivacyEntityMarker[] = []
  for (const span of collectSensitivityMatchSpans(input.text)) {
    const category = canonicalPrivacyCategory(span.category)
    const action = actionForPrivacyCategory(input.policy, category)
    const nextOrdinal = (ordinals.get(category) ?? 0) + 1
    ordinals.set(category, nextOrdinal)
    markers.push({
      start: span.start,
      end: span.end,
      category,
      categoryLabel: categoryLabel(category),
      displayValue: span.value,
      status: transformStatus(action, input.mode),
      action,
      previewAlias: action === 'tokenize' ? previewAliasForCategory(category, nextOrdinal) : null,
      source: 'pattern',
    })
  }
  return markers
}

function walkStructuredValues(
  value: unknown,
  fields: ConnectorFieldsPrivacy,
  onField: (field: string, entityType: string, displayValue: string) => void,
): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) walkStructuredValues(item, fields, onField)
    return
  }
  const record = value as Record<string, unknown>
  for (const [key, child] of Object.entries(record)) {
    const spec = fields[key]
    if (spec?.privacy === 'tokenize' && typeof child === 'string' && child.length > 0) {
      const entityType = spec.entity_type
      if (entityType && isSurrogateEntityType(entityType)) {
        onField(key, entityType, child)
      }
      continue
    }
    walkStructuredValues(child, fields, onField)
  }
}

export function buildStructuredEntityMarkers(input: {
  text: string
  output: unknown
  fields: ConnectorFieldsPrivacy
  policy: ResolvedPrivacyCategoryPolicy
  mode: PrivacyGatewayMode
}): PrivacyEntityMarker[] {
  const ordinals = new Map<string, number>()
  const markers: PrivacyEntityMarker[] = []
  const seen = new Set<string>()
  walkStructuredValues(input.output, input.fields, (field, entityType, displayValue) => {
    const category = canonicalPrivacyCategory(entityType)
    const action = actionForPrivacyCategory(input.policy, category)
    const positions = findAllPositions(input.text, displayValue)
    for (const start of positions) {
      const key = `${start}:${displayValue}`
      if (seen.has(key)) continue
      seen.add(key)
      const nextOrdinal = (ordinals.get(category) ?? 0) + 1
      ordinals.set(category, nextOrdinal)
      markers.push({
        start,
        end: start + displayValue.length,
        category,
        categoryLabel: categoryLabel(category),
        displayValue,
        status: transformStatus(action, input.mode),
        action,
        previewAlias: action === 'tokenize' ? previewAliasForCategory(category, nextOrdinal) : null,
        source: 'structured_field',
        field,
      })
    }
  })
  return markers
}

export function buildEntityMarkers(input: {
  text: string
  policy: ResolvedPrivacyCategoryPolicy
  mode: PrivacyGatewayMode
  structuredOutput?: unknown
  connectorFields?: ConnectorFieldsPrivacy
}): PrivacyEntityMarker[] {
  const pattern = buildPatternEntityMarkers(input)
  if (!input.structuredOutput || !input.connectorFields) return mergeMarkers(pattern)
  const structured = buildStructuredEntityMarkers({
    text: input.text,
    output: input.structuredOutput,
    fields: input.connectorFields,
    policy: input.policy,
    mode: input.mode,
  })
  return mergeMarkers([...pattern, ...structured])
}

export function applyTransformPreview(
  text: string,
  markers: readonly PrivacyEntityMarker[],
  mode: PrivacyGatewayMode,
): string {
  if (mode !== 'enforce') return text
  const tokenized = markers
    .filter((marker) => marker.action === 'tokenize' && marker.previewAlias)
    .sort((a, b) => b.start - a.start)
  let out = text
  for (const marker of tokenized) {
    out = out.slice(0, marker.start) + marker.previewAlias + out.slice(marker.end)
  }
  return out
}

function summarizeTransformation(markers: readonly PrivacyEntityMarker[], mode: PrivacyGatewayMode): string {
  if (markers.length === 0) {
    return mode === 'off'
      ? 'A védelem ki van kapcsolva — nem találtunk cserélendő adatot.'
      : 'Nem találtunk védendő adatot ebben a szövegben.'
  }
  const byCategory = new Map<string, number>()
  for (const marker of markers) {
    byCategory.set(marker.categoryLabel, (byCategory.get(marker.categoryLabel) ?? 0) + 1)
  }
  const parts = [...byCategory.entries()].map(([label, count]) => `${count} ${label.toLowerCase()}`)
  const statusHint =
    mode === 'observe'
      ? 'Megfigyelés: feljegyeztük, de a modell még a valódi adatot kapja.'
      : mode === 'enforce'
        ? 'Érvényesítés: a modell az álneveket kapja.'
        : 'A védelem ki van kapcsolva.'
  return `${markers.length} védendő adat (${parts.join(', ')}) — ${statusHint}`
}

export function buildPrivacyTurnChain(input: PrivacyTurnChainInput): PrivacyTurnChain {
  const originalText = input.originalText
  const markers = buildEntityMarkers({
    text: originalText,
    policy: input.policy,
    mode: input.mode,
    structuredOutput: input.structuredOutput,
    connectorFields: input.connectorFields,
  })
  const llmInputText =
    input.llmInputText ??
    (input.mode === 'enforce' ? applyTransformPreview(originalText, markers, input.mode) : originalText)
  const llmOutputText = input.llmOutputText ?? ''
  const userOutputText = input.userOutputText ?? llmOutputText
  const llmInputMarkers = buildEntityMarkers({
    text: llmInputText,
    policy: input.policy,
    mode: input.mode,
  })
  const llmOutputMarkers = llmOutputText
    ? buildEntityMarkers({
        text: llmOutputText,
        policy: input.policy,
        mode: input.mode,
      })
    : []
  const userOutputMarkers = userOutputText
    ? buildEntityMarkers({
        text: userOutputText,
        policy: input.policy,
        mode: input.mode,
      })
    : []

  const stages: PrivacyTurnChainStage[] = [
    {
      id: 'original',
      label: PRIVACY_CHAIN_STAGE_LABELS.original,
      text: originalText,
      markers,
    },
    {
      id: 'transformation',
      label: PRIVACY_CHAIN_STAGE_LABELS.transformation,
      text: originalText,
      markers,
      summary: summarizeTransformation(markers, input.mode),
    },
    {
      id: 'llm_input',
      label: PRIVACY_CHAIN_STAGE_LABELS.llm_input,
      text: llmInputText,
      markers: llmInputMarkers,
    },
    {
      id: 'llm_output',
      label: PRIVACY_CHAIN_STAGE_LABELS.llm_output,
      text: llmOutputText,
      markers: llmOutputMarkers,
    },
    {
      id: 'user_output',
      label: PRIVACY_CHAIN_STAGE_LABELS.user_output,
      text: userOutputText,
      markers: userOutputMarkers,
    },
  ]

  return {
    mode: input.mode,
    stages,
    markerCount: markers.length,
    empty: !originalText.trim() && markers.length === 0,
  }
}

export function markerTooltipText(marker: PrivacyEntityMarker): string {
  const status = PRIVACY_TRANSFORM_STATUS_LABELS[marker.status]
  return `${marker.categoryLabel} — ${status.label}. ${status.explanation}`
}

export function markerHighlightClass(status: PrivacyTransformStatus): string {
  switch (status) {
    case 'observed':
      return 'bg-honey/25 text-ink border-b border-honey/60'
    case 'applied':
      return 'bg-sage/20 text-ink border-b border-sage/50'
    case 'blocked':
      return 'bg-coral/15 text-ink border-b border-coral/50'
    case 'skipped':
      return 'bg-night-3 text-ink-soft border-b border-line/60'
    default:
      return 'bg-night-3 text-ink-soft'
  }
}
