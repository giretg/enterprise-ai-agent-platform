/**
 * Strukturált lekérdezés-leíró (#984 R3, Q8 v1-döntés): a modell NEM ír SQL-t.
 * Mezők, szűrők, csoportosítás, összesítés, rendezés — mind a katalógus ellen
 * ellenőrizve; legfeljebb egy kapcsolati ugrás (`ugyfel_ref.nev`). Csak olvasó
 * tranzakció, statement_timeout, sorlimit.
 */
import { z } from 'zod'
import type { CatalogDataset } from './plan'
import { qi, qt, SQL_TYPE } from './sql'

export const QUERY_MAX_LIMIT = 500

export const queryFilterSchema = z
  .object({
    field: z.string().min(1).max(110),
    op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'in', 'is_null', 'not_null', 'between']),
    value: z.unknown().optional(),
  })
  .strict()

export const queryFiltersSchema = z.array(queryFilterSchema).max(20)

export type QueryFilter = z.infer<typeof queryFilterSchema>

export type QuerySpec = {
  dataset: string
  fields: string[]
  filters: QueryFilter[]
  groupBy: string[]
  aggregates: Array<{ fn: 'count' | 'sum' | 'avg' | 'min' | 'max'; field: string | null }>
  orderBy: Array<{ field: string; desc: boolean }>
  limit: number
  offset: number
}

export type CompiledQuery = { sql: string; params: unknown[]; columns: string[] }

export class QueryError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(code)
    this.name = 'QueryError'
  }
}

type Resolved = { expr: string; type: string; name: string; joinAlias?: string }

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

/** `sum:osszeg,count:*` → aggregátumok. */
export function parseAggregates(value: string | undefined): QuerySpec['aggregates'] {
  return splitList(value).map((item) => {
    const [fn, field] = item.split(':').map((p) => p.trim())
    if (!fn || !['count', 'sum', 'avg', 'min', 'max'].includes(fn)) throw new QueryError('invalid_aggregate', item)
    return { fn: fn as QuerySpec['aggregates'][number]['fn'], field: !field || field === '*' ? null : field }
  })
}

/** `osszeg desc, datum` → rendezés. */
export function parseOrderBy(value: string | undefined): QuerySpec['orderBy'] {
  return splitList(value).map((item) => {
    const [field, dir] = item.split(/\s+/)
    if (dir && !/^(asc|desc)$/i.test(dir)) throw new QueryError('invalid_order', item)
    return { field: field!, desc: /^desc$/i.test(dir ?? '') }
  })
}

export function buildQuerySpec(input: {
  dataset: string
  fields?: string
  filters?: string
  groupBy?: string
  aggregates?: string
  orderBy?: string
  limit?: number
  offset?: number
}): QuerySpec {
  let filters: QueryFilter[] = []
  if (input.filters) {
    let raw: unknown
    try {
      raw = JSON.parse(input.filters)
    } catch {
      throw new QueryError('invalid_filters', 'filters must be a JSON array')
    }
    const parsed = queryFiltersSchema.safeParse(raw)
    if (!parsed.success) throw new QueryError('invalid_filters', parsed.error.issues[0]?.message)
    filters = parsed.data
  }
  return {
    dataset: input.dataset,
    fields: splitList(input.fields),
    filters,
    groupBy: splitList(input.groupBy),
    aggregates: parseAggregates(input.aggregates),
    orderBy: parseOrderBy(input.orderBy),
    limit: Math.max(1, Math.min(QUERY_MAX_LIMIT, input.limit ?? 100)),
    offset: Math.max(0, Math.min(1_000_000, input.offset ?? 0)),
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`)
}

export function compileQuery(schema: string, spec: QuerySpec, catalog: Map<string, CatalogDataset>): CompiledQuery {
  const base = catalog.get(spec.dataset)
  if (!base) throw new QueryError('dataset_not_found', spec.dataset)
  const joins = new Map<string, { alias: string; dataset: CatalogDataset; on: string }>()
  const resolve = (path: string): Resolved => {
    const parts = path.split('.')
    if (parts.length > 2) throw new QueryError('field_not_found', path)
    if (parts.length === 1) {
      if (path === '_id') return { expr: 't._id', type: 'uuid', name: '_id' }
      if (path === '_updated_at') return { expr: 't._updated_at', type: 'timestamptz', name: '_updated_at' }
      const field = base.fields.find((f) => f.name === path)
      if (!field) throw new QueryError('field_not_found', path)
      return { expr: `t.${qi(field.name)}`, type: SQL_TYPE[field.type], name: field.name }
    }
    const [linkName, targetName] = parts as [string, string]
    const link = base.fields.find((f) => f.name === linkName && f.role === 'link')
    if (!link?.linkDataset) throw new QueryError('field_not_found', path)
    const target = catalog.get(link.linkDataset)
    const field = target?.fields.find((f) => f.name === targetName && f.role === 'data')
    if (!target || !field) throw new QueryError('field_not_found', path)
    let join = joins.get(linkName)
    if (!join) {
      join = { alias: `j${joins.size}`, dataset: target, on: `t.${qi(link.name)}` }
      joins.set(linkName, join)
    }
    return { expr: `${join.alias}.${qi(field.name)}`, type: SQL_TYPE[field.type], name: `${linkName}.${targetName}`, joinAlias: join.alias }
  }

  const params: unknown[] = []
  const param = (value: unknown, type: string) => {
    params.push(value)
    return `$${params.length}::${type}`
  }
  const scalar = (value: unknown, path: string) => {
    if (value === null || value === undefined) throw new QueryError('invalid_filter_value', path)
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new QueryError('invalid_filter_value', path)
    return value
  }
  const where = spec.filters.map((filter) => {
    const col = resolve(filter.field)
    switch (filter.op) {
      case 'is_null':
        return `${col.expr} IS NULL`
      case 'not_null':
        return `${col.expr} IS NOT NULL`
      case 'contains':
      case 'starts_with': {
        const text = String(scalar(filter.value, filter.field))
        const pattern = filter.op === 'contains' ? `%${escapeLike(text)}%` : `${escapeLike(text)}%`
        return `${col.expr}::text ILIKE ${param(pattern, 'text')}`
      }
      case 'in': {
        if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 200) throw new QueryError('invalid_filter_value', filter.field)
        return `${col.expr} = ANY(${param(filter.value.map((v) => String(scalar(v, filter.field))), 'text[]')}::${col.type}[])`
      }
      case 'between': {
        if (!Array.isArray(filter.value) || filter.value.length !== 2) throw new QueryError('invalid_filter_value', filter.field)
        return `${col.expr} BETWEEN ${param(scalar(filter.value[0], filter.field), col.type)} AND ${param(scalar(filter.value[1], filter.field), col.type)}`
      }
      default: {
        const op = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[filter.op]
        return `${col.expr} ${op} ${param(scalar(filter.value, filter.field), col.type)}`
      }
    }
  })

  const selects: string[] = []
  const columns: string[] = []
  const aggregated = spec.aggregates.length > 0 || spec.groupBy.length > 0
  if (aggregated) {
    for (const g of spec.groupBy) {
      const col = resolve(g)
      selects.push(`${col.expr} AS ${qi(`c${columns.length}`)}`)
      columns.push(col.name)
    }
    for (const agg of spec.aggregates) {
      if (agg.fn === 'count' && !agg.field) {
        selects.push(`count(*)::int AS ${qi(`c${columns.length}`)}`)
        columns.push('count')
        continue
      }
      if (!agg.field) throw new QueryError('invalid_aggregate', agg.fn)
      const col = resolve(agg.field)
      if ((agg.fn === 'sum' || agg.fn === 'avg') && !['bigint', 'numeric'].includes(col.type)) throw new QueryError('invalid_aggregate', `${agg.fn}:${agg.field}`)
      selects.push(`${agg.fn}(${col.expr})${agg.fn === 'count' ? '::int' : ''} AS ${qi(`c${columns.length}`)}`)
      columns.push(`${agg.fn}:${agg.field}`)
    }
  } else {
    const wanted = spec.fields.length ? spec.fields : ['_id', ...base.fields.map((f) => f.name)]
    for (const f of wanted) {
      const col = resolve(f)
      selects.push(`${col.expr} AS ${qi(`c${columns.length}`)}`)
      columns.push(col.name)
    }
  }
  if (selects.length === 0) throw new QueryError('nothing_selected')

  const order = spec.orderBy.map((o) => {
    // Csoportosított lekérdezésben az aggregátum-oszlopnévre is lehet rendezni.
    const index = columns.indexOf(o.field)
    const expr = index >= 0 ? qi(`c${index}`) : resolve(o.field).expr
    return `${expr} ${o.desc ? 'DESC' : 'ASC'} NULLS LAST`
  })
  const from = [
    `${qt(schema, base.tableName)} t`,
    ...[...joins.values()].map((j) => `LEFT JOIN ${qt(schema, j.dataset.tableName)} ${j.alias} ON ${j.alias}._id = ${j.on}`),
  ].join(' ')
  const groupExprs = spec.groupBy.map((g) => resolve(g).expr)
  const inner = [
    `SELECT ${selects.join(', ')} FROM ${from}`,
    where.length ? `WHERE ${where.join(' AND ')}` : '',
    aggregated && groupExprs.length ? `GROUP BY ${groupExprs.join(', ')}` : '',
    order.length ? `ORDER BY ${order.join(', ')}` : aggregated ? '' : 'ORDER BY t._source_row NULLS LAST, t._id',
    `LIMIT ${param(spec.limit + 1, 'int')} OFFSET ${param(spec.offset, 'int')}`,
  ]
    .filter(Boolean)
    .join(' ')
  return { sql: `SELECT to_jsonb(q) AS r FROM (${inner}) q`, params, columns }
}
