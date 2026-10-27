/**
 * Verziózott importterv (#984 §4–§5, Q4 v1-döntés): az AI (vagy ember) DEKLARATÍV
 * tervet ad, a kód ellenőrzi. Ismeretlen kulcs → elutasítás (`.strict()`), így a
 * fájlba rejtett „utasítás” legfeljebb szöveg lehet a tervben, végrehajtható
 * művelet nem (AC13). A DDL-t a szerkezetkezelő generálja, nem a terv.
 */
import { z } from 'zod'
import type { SheetProfile } from './profiler'
import { WAREHOUSE_FIELD_TYPES, type WarehouseFieldType } from './value-parse'

export const IMPORT_PLAN_SCHEMA_ID = 'warehouse.import_plan/v1'

export const DATASET_KEY = /^[a-z][a-z0-9_]{1,40}$/
export const FIELD_NAME = /^[a-z][a-z0-9_]{0,50}$/

const datasetKey = z.string().regex(DATASET_KEY, 'lowercase letters, digits, underscore; starts with a letter')
const fieldName = z.string().regex(FIELD_NAME, 'lowercase letters, digits, underscore; starts with a letter')
const shortText = (max: number) => z.string().trim().min(1).max(max)

export const planFieldSchema = z
  .object({
    source: shortText(200).describe('Column header exactly as in the profile, or the column letter (e.g. "C").'),
    target: fieldName,
    type: z.enum(WAREHOUSE_FIELD_TYPES as [WarehouseFieldType, ...WarehouseFieldType[]]),
    label: shortText(120),
    meaning: z.string().trim().max(500).optional(),
    unit: z.string().trim().max(40).optional(),
    currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
    amountBasis: z.enum(['net', 'gross', 'unknown']).optional(),
    required: z.boolean().optional(),
  })
  .strict()

export const planLinkSchema = z
  .object({
    field: fieldName.describe('A target field of THIS plan whose value identifies the related record.'),
    toDataset: datasetKey,
    by: z.enum(['key', 'name']).describe('key = exact business key; name = normalized name (exact after case/space normalization).'),
    toField: fieldName,
    as: fieldName.describe('New link column holding the internal id of the matched record, e.g. "customer_ref".'),
  })
  .strict()

export const importPlanSchema = z
  .object({
    schema: z.literal(IMPORT_PLAN_SCHEMA_ID),
    sheet: shortText(200),
    headerRow: z.number().int().min(1).max(1_000).optional(),
    headerRowCount: z.number().int().min(1).max(3).optional(),
    dataset: z
      .object({
        key: datasetKey,
        title: shortText(120),
        purpose: z.string().trim().max(1_000).optional(),
        rowMeaning: z.string().trim().max(300).optional(),
        temporal: z.enum(['master', 'snapshot', 'event', 'period']).optional(),
      })
      .strict(),
    mode: z.enum(['upsert', 'append']),
    businessKey: z.array(fieldName).max(4).default([]),
    fields: z.array(planFieldSchema).min(1).max(150),
    links: z.array(planLinkSchema).max(10).default([]),
    duplicates: z.enum(['reject', 'last_wins']).default('reject'),
  })
  .strict()

export type ImportPlan = z.infer<typeof importPlanSchema>
export type PlanField = z.infer<typeof planFieldSchema>
export type PlanLink = z.infer<typeof planLinkSchema>

export type CatalogField = {
  name: string
  type: WarehouseFieldType | 'link'
  label: string
  meaning: string | null
  unit: string | null
  currency: string | null
  amountBasis: string | null
  role: 'data' | 'link'
  linkDataset: string | null
  linkBy: 'key' | 'name' | null
  linkField: string | null
  status: 'proposed' | 'confirmed'
  sourceHeader: string | null
}

export type CatalogDataset = {
  key: string
  tableName: string
  title: string
  purpose: string | null
  rowMeaning: string | null
  temporal: string | null
  status: 'proposed' | 'confirmed'
  structureVersion: number
  businessKey: string[]
  mode: 'upsert' | 'append'
  publishedAt: string | null
  lastImportId: string | null
  rowCount: number
  fields: CatalogField[]
}

export type PlanCheck = {
  ok: boolean
  errors: Array<{ code: string; path?: string; detail?: string }>
  warnings: Array<{ code: string; path?: string; detail?: string }>
  /** Szerkezeti változás → emberi jóváhagyás kell (§4). */
  structure: { newDataset: boolean; newFields: string[] }
}

export function parseImportPlan(raw: unknown):
  | { ok: true; plan: ImportPlan }
  | { ok: false; issues: Array<{ path: string; message: string }> } {
  const parsed = importPlanSchema.safeParse(raw)
  if (parsed.success) return { ok: true, plan: parsed.data }
  return {
    ok: false,
    issues: parsed.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  }
}

/** A forrásoszlop indexe a profil fejlécei alapján (pontos név, kis-/nagybetű mindegy, vagy oszlopbetű). */
export function resolveSourceColumn(sheet: { columns: Array<Pick<SheetProfile['columns'][number], 'header' | 'index' | 'letter'>> }, source: string): number | null {
  const wanted = source.trim().toLowerCase()
  const byHeader = sheet.columns.find((c) => c.header.trim().toLowerCase() === wanted)
  if (byHeader) return byHeader.index
  const byLetter = sheet.columns.find((c) => c.letter.toLowerCase() === wanted)
  return byLetter ? byLetter.index : null
}

export function checkPlan(
  plan: ImportPlan,
  sheet: SheetProfile | null,
  catalog: Map<string, CatalogDataset>,
): PlanCheck {
  const errors: PlanCheck['errors'] = []
  const warnings: PlanCheck['warnings'] = []
  if (!sheet) errors.push({ code: 'sheet_not_found', path: 'sheet', detail: plan.sheet })
  const targets = new Set<string>()
  plan.fields.forEach((field, i) => {
    if (targets.has(field.target)) errors.push({ code: 'duplicate_target', path: `fields.${i}.target`, detail: field.target })
    targets.add(field.target)
    if (sheet) {
      const col = resolveSourceColumn(sheet, field.source)
      if (col === null) errors.push({ code: 'source_column_not_found', path: `fields.${i}.source`, detail: field.source })
      else {
        const inferred = sheet.columns[col]!.inferredType
        const compatible =
          inferred === 'empty' ||
          inferred === field.type ||
          field.type === 'text' ||
          (field.type === 'decimal' && inferred === 'integer')
        if (!compatible) {
          warnings.push({ code: 'type_mismatch', path: `fields.${i}.type`, detail: `${field.source}: profile=${inferred}, plan=${field.type}` })
        }
      }
    }
  })
  for (const link of plan.links) {
    if (targets.has(link.as)) errors.push({ code: 'duplicate_target', path: 'links.as', detail: link.as })
    targets.add(link.as)
  }

  // R5: frissítő módban kötelező az üzleti kulcs.
  if (plan.mode === 'upsert' && plan.businessKey.length === 0) {
    errors.push({ code: 'business_key_required', path: 'businessKey' })
  }
  for (const key of plan.businessKey) {
    const field = plan.fields.find((f) => f.target === key)
    if (!field) errors.push({ code: 'business_key_not_in_fields', path: 'businessKey', detail: key })
  }

  const existing = catalog.get(plan.dataset.key)
  const newFields: string[] = []
  if (existing) {
    if (existing.mode !== plan.mode) errors.push({ code: 'mode_change_not_allowed', path: 'mode', detail: `${existing.mode} → ${plan.mode}` })
    if (existing.businessKey.join(',') !== plan.businessKey.join(',')) {
      errors.push({ code: 'business_key_change_not_allowed', path: 'businessKey', detail: existing.businessKey.join(',') })
    }
    const byName = new Map(existing.fields.map((f) => [f.name, f]))
    for (const field of plan.fields) {
      const current = byName.get(field.target)
      if (!current) newFields.push(field.target)
      else if (current.type !== field.type) {
        // Típusváltás romboló művelet (§4) — v1-ben nem engedett.
        errors.push({ code: 'type_change_not_allowed', path: `fields.${field.target}`, detail: `${current.type} → ${field.type}` })
      }
    }
    for (const link of plan.links) {
      const current = byName.get(link.as)
      if (!current) newFields.push(link.as)
      else if (current.role !== 'link' || current.linkDataset !== link.toDataset) {
        errors.push({ code: 'type_change_not_allowed', path: `links.${link.as}`, detail: 'existing non-link column' })
      }
    }
  }

  for (const link of plan.links) {
    if (!targets.has(link.field) || !plan.fields.some((f) => f.target === link.field)) {
      errors.push({ code: 'link_field_not_in_fields', path: 'links.field', detail: link.field })
    }
    if (link.toDataset === plan.dataset.key) {
      errors.push({ code: 'self_link_not_supported', path: 'links.toDataset' })
      continue
    }
    const target = catalog.get(link.toDataset)
    if (!target) {
      errors.push({ code: 'link_dataset_not_found', path: 'links.toDataset', detail: link.toDataset })
      continue
    }
    const toField = target.fields.find((f) => f.name === link.toField && f.role === 'data')
    if (!toField) errors.push({ code: 'link_field_not_found', path: 'links.toField', detail: `${link.toDataset}.${link.toField}` })
    if (link.by === 'key' && (target.businessKey.length !== 1 || target.businessKey[0] !== link.toField)) {
      errors.push({ code: 'link_key_must_be_business_key', path: 'links.toField', detail: target.businessKey.join(',') || 'none' })
    }
  }
  if (sheet && sheet.dataRowCount === 0) errors.push({ code: 'no_data_rows', path: 'sheet' })
  if (sheet?.hidden) warnings.push({ code: 'hidden_sheet', path: 'sheet' })
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    structure: { newDataset: !existing, newFields: existing ? newFields : [...targets] },
  }
}

/** A plan-hash a preview ↔ commit összekötéshez (a commit pontosan az előnézetet hajtja végre). */
export function canonicalPlanJson(plan: ImportPlan): string {
  return JSON.stringify(plan)
}
