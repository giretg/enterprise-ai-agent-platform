/**
 * Mentett lekérdezés (#1083) tiszta logikája: paraméterek feloldása, a használt
 * mezők lenyomata és az elavulás-állapot. A dátum nem dönt: az `updated_at` minden
 * importnál frissül, a `structure_version` pedig nem nő, ha egy nem megerősített
 * mező pénzneme vagy jelentése változik (§2) — ezért verzió + mezőnkénti lenyomat.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { CatalogDataset, CatalogField } from './plan'
import { compileQuery, parseGroupField, QueryError, type QueryFilter, type QuerySpec } from './query'

export const SAVED_QUERY_MAX_PER_AGENT = 200
export const SAVED_QUERY_DESCRIPTION_MAX = 500
export const SAVED_QUERY_CHANGE_NOTE_MAX = 500
export const SAVED_QUERY_NAME = /^[a-z][a-z0-9_]{2,60}$/
export const SAVED_QUERY_TIME_ZONE = 'Europe/Budapest'

const PARAM_NAME = /^[a-z][a-z0-9_]{0,40}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const RELATIVE_DATE = /^(today|month_start|prev_month_start|prev_month_end|year_start|days_ago:\d{1,4})$/

const relativeDateSchema = z.object({ relative: z.string().regex(RELATIVE_DATE) }).strict()

const paramValueSchema = z.union([z.string().max(1_000), z.number(), z.boolean(), relativeDateSchema])

export const savedQueryParamSchema = z
  .object({
    name: z.string().regex(PARAM_NAME),
    type: z.enum(['text', 'number', 'date', 'boolean']),
    description: z.string().max(200).optional(),
    default: paramValueSchema.optional(),
  })
  .strict()

export const savedQueryParamsSchema = z.array(savedQueryParamSchema).max(10)

export type SavedQueryParam = z.infer<typeof savedQueryParamSchema>
export type SavedQueryParamValue = z.infer<typeof paramValueSchema>

export type SavedQueryStatus = 'current' | 'dataset_extended' | 'meaning_changed' | 'broken'

/** Adatkészletenként: szerkezeti verzió, az összes mezőnév, a használt mezők lenyomata. */
export type DatasetSnapshot = { structureVersion: number; fieldNames: string[]; fields: Record<string, string> }
export type SavedQuerySnapshots = Record<string, DatasetSnapshot>

export type SavedQueryStatusReport = {
  status: SavedQueryStatus
  datasets: Array<{ key: string; structureVersionAtSave: number; structureVersionNow: number | null; structureChangedAt: string | null }>
  newFields: Array<{ dataset: string; field: string }>
  changedFields: Array<{ dataset: string; field: string }>
  error?: { code: string; detail?: string }
}

function paramRef(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0] === 'param' && typeof (value as { param: unknown }).param === 'string' ? (value as { param: string }).param : null
}

function filterParamRefs(filter: QueryFilter): string[] {
  const values = Array.isArray(filter.value) ? filter.value : [filter.value]
  return values.map(paramRef).filter((name): name is string => name !== null)
}

/** Egy naptári nap Budapest szerint, `YYYY-MM-DD` — a futás napjából számolva, nem UTC-ből. */
function budapestDate(now: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: SAVED_QUERY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  return { year: get('year'), month: get('month'), day: get('day') }
}

function isoFromUtc(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10)
}

export function resolveRelativeDate(relative: string, now: Date): string {
  if (!RELATIVE_DATE.test(relative)) throw new QueryError('invalid_param', relative)
  const { year, month, day } = budapestDate(now)
  if (relative === 'today') return isoFromUtc(year, month, day)
  if (relative === 'month_start') return isoFromUtc(year, month, 1)
  if (relative === 'prev_month_start') return isoFromUtc(year, month - 1, 1)
  if (relative === 'prev_month_end') return isoFromUtc(year, month, 0)
  if (relative === 'year_start') return isoFromUtc(year, 1, 1)
  return isoFromUtc(year, month, day - Number(relative.slice('days_ago:'.length)))
}

function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function coerceParam(param: SavedQueryParam, value: unknown, now: Date): string | number | boolean {
  const invalid = () => new QueryError('invalid_param', param.name)
  switch (param.type) {
    case 'text':
      if (typeof value !== 'string') throw invalid()
      return value
    case 'number': {
      const number = typeof value === 'string' && value.trim() ? Number(value) : value
      if (typeof number !== 'number' || !Number.isFinite(number)) throw invalid()
      return number
    }
    case 'boolean':
      if (value === 'true' || value === 'false') return value === 'true'
      if (typeof value !== 'boolean') throw invalid()
      return value
    default: {
      const relative = relativeDateSchema.safeParse(value)
      if (relative.success) return resolveRelativeDate(relative.data.relative, now)
      if (typeof value !== 'string' || !isRealDate(value)) throw invalid()
      return value
    }
  }
}

/** A mentett leíró + paraméterek → futtatható `QuerySpec`; az érték a fordítóban `$n` paraméter marad. */
export function resolveSavedQuery(spec: QuerySpec, params: SavedQueryParam[], args: Record<string, unknown>, now: Date): QuerySpec {
  const known = new Map(params.map((param) => [param.name, param]))
  for (const name of Object.keys(args)) if (!known.has(name)) throw new QueryError('unknown_param', name)
  const valueOf = (name: string) => {
    const param = known.get(name)
    if (!param) throw new QueryError('unknown_param', name)
    const raw = (Object.hasOwn(args, name) ? args[name] : undefined) ?? param.default
    if (raw === undefined || raw === null) throw new QueryError('missing_param', name)
    return coerceParam(param, raw, now)
  }
  const substitute = (value: unknown) => {
    const name = paramRef(value)
    return name === null ? value : valueOf(name)
  }
  return {
    ...spec,
    filters: spec.filters.map((filter) => ({
      ...filter,
      ...(filter.value === undefined ? {} : { value: Array.isArray(filter.value) ? filter.value.map(substitute) : substitute(filter.value) }),
    })),
  }
}

/** Paraméter nélküli, csak a fordítóhoz való értékek: az állapot-ellenőrzés nem nyúl az adathoz. */
function placeholderArgs(params: SavedQueryParam[]): Record<string, unknown> {
  const sample = { text: 'x', number: 0, date: '2000-01-01', boolean: true } as const
  return Object.fromEntries(params.map((param) => [param.name, sample[param.type]]))
}

/** A leíró ténylegesen használt mezői adatkészletenként (a kapcsolati ugrás a célkészletet is érinti). */
export function usedFields(spec: QuerySpec, catalog: Map<string, CatalogDataset>): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>([[spec.dataset, new Set()]])
  const add = (dataset: string, field: string) => {
    if (!used.has(dataset)) used.set(dataset, new Set())
    used.get(dataset)!.add(field)
  }
  const base = catalog.get(spec.dataset)
  const addPath = (path: string) => {
    if (path === '_id' || path === '_updated_at') return
    const [first, target] = path.split('.') as [string, string | undefined]
    add(spec.dataset, first)
    if (!target) return
    const link = base?.fields.find((field) => field.name === first && field.role === 'link')
    if (link?.linkDataset) add(link.linkDataset, target)
  }
  const aggregated = spec.aggregates.length > 0 || spec.groupBy.length > 0
  if (!aggregated) spec.fields.forEach(addPath)
  spec.groupBy.forEach((value) => addPath(parseGroupField(value).path))
  for (const aggregate of spec.aggregates) if (aggregate.field) addPath(aggregate.field)
  spec.filters.forEach((filter) => addPath(filter.field))
  // Csoportosításnál a rendezés a kimeneti oszlopra hivatkozik, azt a fenti ágak már lefedték.
  if (!aggregated) spec.orderBy.forEach((order) => addPath(order.field))
  return used
}

/** Ami a válasz jelentését befolyásolja. A `proposed → confirmed` váltás és a felirat nem változás. */
function fieldFingerprint(field: CatalogField): string {
  const signature = JSON.stringify([field.type, field.role, field.linkDataset, field.linkField, field.unit, field.currency, field.amountBasis, field.meaning])
  return createHash('sha256').update(signature).digest('hex').slice(0, 16)
}

export function buildSnapshots(spec: QuerySpec, catalog: Map<string, CatalogDataset>): SavedQuerySnapshots {
  const snapshots: SavedQuerySnapshots = {}
  for (const [key, names] of usedFields(spec, catalog)) {
    const dataset = catalog.get(key)
    if (!dataset) continue
    const fields: Record<string, string> = {}
    for (const name of names) {
      const field = dataset.fields.find((candidate) => candidate.name === name)
      if (field) fields[name] = fieldFingerprint(field)
    }
    snapshots[key] = { structureVersion: dataset.structureVersion, fieldNames: dataset.fields.map((field) => field.name), fields }
  }
  return snapshots
}

/** Mentésnél az „összes mező” konkrét lista lesz: egy új oszlop ne változtassa csendben az eredményt. */
export function pinFields(spec: QuerySpec, catalog: Map<string, CatalogDataset>): QuerySpec {
  const aggregated = spec.aggregates.length > 0 || spec.groupBy.length > 0
  if (aggregated || spec.fields.length > 0) return spec
  const base = catalog.get(spec.dataset)
  return base ? { ...spec, fields: ['_id', ...base.fields.map((field) => field.name)] } : spec
}

export function savedQueryStatus(input: {
  schema: string
  spec: QuerySpec
  params: SavedQueryParam[]
  snapshots: SavedQuerySnapshots
  catalog: Map<string, CatalogDataset>
  now: Date
}): SavedQueryStatusReport {
  const { spec, params, snapshots, catalog } = input
  const datasets = Object.entries(snapshots).map(([key, snapshot]) => {
    const current = catalog.get(key)
    return {
      key,
      structureVersionAtSave: snapshot.structureVersion,
      structureVersionNow: current?.structureVersion ?? null,
      structureChangedAt: current?.structureChangedAt ?? null,
    }
  })
  const report = { datasets, newFields: [] as SavedQueryStatusReport['newFields'], changedFields: [] as SavedQueryStatusReport['changedFields'] }
  try {
    compileQuery(input.schema, resolveSavedQuery(spec, params, placeholderArgs(params), input.now), catalog)
  } catch (error) {
    if (error instanceof QueryError) return { ...report, status: 'broken', error: { code: error.code, ...(error.detail ? { detail: error.detail } : {}) } }
    throw error
  }
  for (const [key, snapshot] of Object.entries(snapshots)) {
    const current = catalog.get(key)
    if (!current) return { ...report, status: 'broken', error: { code: 'dataset_not_found', detail: key } }
    for (const [name, fingerprint] of Object.entries(snapshot.fields)) {
      const field = current.fields.find((candidate) => candidate.name === name)
      if (!field) return { ...report, status: 'broken', error: { code: 'field_not_found', detail: `${key}.${name}` } }
      if (fieldFingerprint(field) !== fingerprint) report.changedFields.push({ dataset: key, field: name })
    }
    if (current.structureVersion !== snapshot.structureVersion) {
      const known = new Set(snapshot.fieldNames)
      for (const field of current.fields) if (!known.has(field.name)) report.newFields.push({ dataset: key, field: field.name })
    }
  }
  if (report.changedFields.length > 0) return { ...report, status: 'meaning_changed' }
  const extended = datasets.some((dataset) => dataset.structureVersionNow !== dataset.structureVersionAtSave)
  return { ...report, status: extended ? 'dataset_extended' : 'current' }
}

/** A fordító értéket `$n::típus`-ra önt: a rossz típusú paraméter így már mentéskor kiderül. */
function expectedParamType(field: CatalogField): SavedQueryParam['type'] {
  if (field.type === 'integer' || field.type === 'decimal') return 'number'
  if (field.type === 'date' || field.type === 'boolean') return field.type
  return 'text'
}

/** Mentés előtti ellenőrzés: minden hivatkozott paraméter deklarált, minden deklarált használt, a típus illik. */
export function checkSavedQueryParams(spec: QuerySpec, params: SavedQueryParam[], catalog: Map<string, CatalogDataset>): void {
  if (new Set(params.map((param) => param.name)).size !== params.length) throw new QueryError('invalid_params', 'duplicate parameter name')
  const declared = new Map(params.map((param) => [param.name, param]))
  const referenced = new Set<string>()
  const base = catalog.get(spec.dataset)
  for (const filter of spec.filters) {
    for (const name of filterParamRefs(filter)) {
      referenced.add(name)
      const param = declared.get(name)
      if (!param) throw new QueryError('unknown_param', name)
      if (filter.op === 'contains' || filter.op === 'starts_with') {
        if (param.type !== 'text') throw new QueryError('invalid_params', `${name} must be text for ${filter.op}`)
        continue
      }
      const [first, target] = filter.field.split('.') as [string, string | undefined]
      const owner = target ? catalog.get(base?.fields.find((field) => field.name === first)?.linkDataset ?? '') : base
      const field = owner?.fields.find((candidate) => candidate.name === (target ?? first))
      if (field && expectedParamType(field) !== param.type) {
        throw new QueryError('invalid_params', `${name} must be ${expectedParamType(field)} for field ${filter.field}`)
      }
    }
  }
  for (const param of params) if (!referenced.has(param.name)) throw new QueryError('invalid_params', `${param.name} is not used in filters`)
  const now = new Date()
  for (const param of params) if (param.default !== undefined) coerceParam(param, param.default, now)
}

export function requiredParams(params: SavedQueryParam[]): string[] {
  return params.filter((param) => param.default === undefined).map((param) => param.name)
}

/** A mentett tartalom kanonikus hash-e: azonos tartalom újramentése nem új verzió, hanem megerősítés. */
export function savedQueryHash(input: { description: string; spec: QuerySpec; params: SavedQueryParam[] }): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]))
    }
    return value
  }
  return createHash('sha256').update(JSON.stringify(stable(input))).digest('hex')
}

const AGGREGATE_HU: Record<QuerySpec['aggregates'][number]['fn'], string> = { count: 'megszámolja', sum: 'összegzi', avg: 'átlagolja', min: 'minimumát veszi', max: 'maximumát veszi' }
const BUCKET_HU: Record<string, string> = { day: 'Napi', week: 'Heti', month: 'Havi', quarter: 'Negyedéves', year: 'Éves' }

function fieldLabel(spec: QuerySpec, catalog: Map<string, CatalogDataset>, path: string): string {
  const [first, target] = path.split('.') as [string, string | undefined]
  const field = catalog.get(spec.dataset)?.fields.find((candidate) => candidate.name === first)
  if (!target) return field?.label ?? first
  const linked = catalog.get(field?.linkDataset ?? '')?.fields.find((candidate) => candidate.name === target)
  return linked?.label ?? target
}

const AGGREGATE_COLUMN_HU: Record<string, string> = { sum: 'összeg', avg: 'átlag', min: 'legkisebb', max: 'legnagyobb', count: 'darabszám' }
const BUCKET_COLUMN_HU: Record<string, string> = { day: 'nap', week: 'hét', month: 'hónap', quarter: 'negyedév', year: 'év' }

/** Eredményoszlop emberi felirata: `sum:netto` → „Nettó összeg (összeg)”, `datum:month` → „Dátum (hónap)”. */
export function savedQueryColumnLabel(spec: QuerySpec, catalog: Map<string, CatalogDataset>, column: string): string {
  // Az oszlop eredetét a leíróból olvassuk, hogy egy `count` vagy `sum` nevű mező ne keveredjen az összesítéssel.
  if (column === 'count' && spec.aggregates.some((aggregate) => aggregate.fn === 'count' && !aggregate.field)) return 'Darabszám'
  const aggregate = spec.aggregates.find((candidate) => candidate.field && `${candidate.fn}:${candidate.field}` === column)
  if (aggregate) return `${fieldLabel(spec, catalog, aggregate.field!)} (${AGGREGATE_COLUMN_HU[aggregate.fn]})`
  const bucketed = spec.groupBy.map(parseGroupField).find((group) => group.bucket !== null && `${group.path}:${group.bucket}` === column)
  if (bucketed) return `${fieldLabel(spec, catalog, bucketed.path)} (${BUCKET_COLUMN_HU[bucketed.bucket!] ?? bucketed.bucket})`
  if (column === '_id') return 'Belső azonosító'
  if (column === '_updated_at') return 'Utolsó módosítás'
  return fieldLabel(spec, catalog, column)
}

/** Hétköznapi mondat a Control Plane-re (§6): szakszó és SQL nélkül. */
export function describeSavedQuery(spec: QuerySpec, catalog: Map<string, CatalogDataset>): string {
  const base = catalog.get(spec.dataset)
  const label = (path: string) => fieldLabel(spec, catalog, path)
  const from = base?.title ?? spec.dataset
  const parts: string[] = []
  const buckets = spec.groupBy.map(parseGroupField).filter((group) => group.bucket !== null)
  const plainGroups = spec.groupBy.map(parseGroupField).filter((group) => group.bucket === null)
  if (spec.aggregates.length > 0) {
    const actions = spec.aggregates.map((aggregate) => (aggregate.field ? `${AGGREGATE_HU[aggregate.fn]} a(z) „${label(aggregate.field)}” mezőt` : 'megszámolja a sorokat'))
    const prefix = buckets.length > 0 ? `${buckets.map((group) => BUCKET_HU[group.bucket!] ?? group.bucket).join(', ')} bontásban ` : ''
    const sentence = `${prefix}${actions.join(' és ')}`
    parts.push(sentence.charAt(0).toUpperCase() + sentence.slice(1))
    if (plainGroups.length > 0) parts.push(`„${plainGroups.map((group) => label(group.path)).join('”, „')}” szerint`)
  } else if (spec.groupBy.length > 0) {
    parts.push(`Felsorolja a(z) „${spec.groupBy.map((value) => label(parseGroupField(value).path)).join('”, „')}” különböző értékeit`)
  } else {
    const shown = spec.fields.filter((field) => !field.startsWith('_'))
    parts.push(shown.length > 0 ? `Listázza a(z) ${shown.map((field) => `„${label(field)}”`).join(', ')} mezőket` : 'Listázza a sorokat')
  }
  parts.push(`a(z) „${from}” adatkészletből`)
  if (spec.filters.length > 0) parts.push(`a(z) ${[...new Set(spec.filters.map((filter) => `„${label(filter.field)}”`))].join(', ')} mező szerint szűrve`)
  return `${parts.join(' ')}.`
}
