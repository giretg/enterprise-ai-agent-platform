/**
 * #1075 — agent által javasolt wiki-beállítás: a műveletek érvényesítése és szimulációja.
 *
 * Tiszta függvények. A teljes lista úgy validálódik, mintha sorban lefutna, ezért egy
 * javaslat létrehozhat mezőt, utána sablont, utána kategóriát. Hibás műveletnél a
 * szimuláció megy tovább, hogy az agent egyszerre lássa az összes hibát.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  WIKI_CATEGORY_MAX_COUNT,
  WIKI_CATEGORY_MAX_DESCRIPTION,
  WIKI_CATEGORY_MAX_NAME,
  WIKI_CATEGORY_MAX_PAGE_ORDER,
  WIKI_CATEGORY_MAX_PINNED,
  WIKI_CATEGORY_ORDER_STEP,
  isValidCategoryKey,
  normalizeCategoryPath,
  type WikiCategoryApprovalRule,
  type WikiPageSort,
} from './wiki-categories'
import {
  WIKI_FIELD_MAX_COUNT,
  WIKI_FIELD_MAX_HELP,
  WIKI_FIELD_MAX_NAME,
  WIKI_FIELD_MAX_OPTION,
  WIKI_FIELD_MAX_OPTIONS,
  WIKI_REQUIRABLE_BUILTINS,
  WIKI_REVIEW_CYCLE_MAX_DAYS,
  WIKI_SECTIONS_MAX_COUNT,
  WIKI_TEMPLATE_MAX_CHARS,
  isValidFieldKey,
  uniqueSections,
  type WikiFieldTypeName,
} from './wiki-metadata'

export const WIKI_CONFIG_MAX_OPERATIONS = 200
export const WIKI_CONFIG_MAX_NOTE = 2000
export const WIKI_COLLECT_MAX_CHARS = 3000
export const WIKI_NAME_MAX_CHARS = 120
export const WIKI_MD_MAX_CHARS = 20_000

export type WikiConfigCategory = {
  key: string
  parentKey: string | null
  name: string
  description: string | null
  sortOrder: number | null
  approval: WikiCategoryApprovalRule
  pageSort: WikiPageSort
  pinnedPages: string[]
  pageOrder: string[]
  collapsed: boolean
  reviewCycleDays: number | null
  requiredFields: string[]
  requiredSections: string[]
  sectionRule: 'warn' | 'error'
  templateMd: string | null
  templateKey: string | null
  linkedConnectorId: string | null
}

export type WikiConfigField = {
  key: string
  name: string
  type: WikiFieldTypeName
  options: string[]
  help: string | null
  sortOrder: number
}

/** A javasolható beállítások teljes állapota; a `configVersion` ebből számolódik. */
export type WikiConfigState = {
  /** A `config.displayName`, ha van (a munkatárs saját KB-jának és a katalógusnak nincs). */
  name: string | null
  collect: string | null
  wikiMd: string
  managedCategories: boolean
  managedFields: boolean
  categories: WikiConfigCategory[]
  fields: WikiConfigField[]
}

export type WikiConfigPage = {
  path: string
  category: string | null
  status: 'published' | 'archived' | 'pending_approval'
  id: string
  version: number
  frontmatter: Record<string, unknown>
}

export type WikiConfigIssue = { index: number; op: string | null; code: string; message: string }

/** Oldalanként a változás: a végleges kategória és (ha változott) a teljes frontmatter. */
export type WikiConfigPageChange = {
  path: string
  fromCategory: string | null
  toCategory: string | null
  frontmatter?: Record<string, unknown>
}

export type WikiConfigDestructive =
  | { kind: 'merge'; from: string; to: string; pageCount: number }
  | { kind: 'rename_option'; field: string; from: string; to: string; pageCount: number }
  | { kind: 'remove_option'; field: string; option: string; remapTo: string | null; pageCount: number }

export type WikiConfigSimulation = {
  ok: boolean
  issues: WikiConfigIssue[]
  next: WikiConfigState
  pageChanges: WikiConfigPageChange[]
  destructive: WikiConfigDestructive[]
  warnings: string[]
  /** Művelet-típusonkénti darabszám. */
  counts: Record<string, number>
}

export function categoryPathOf(row: Pick<WikiConfigCategory, 'key' | 'parentKey'>): string {
  return row.parentKey ? `${row.parentKey}/${row.key}` : row.key
}

/** Kanonikus sorrendű lenyomat: bármely beállítás változása új értéket ad. */
export function configVersionOf(state: WikiConfigState): string {
  const canonical = {
    ...state,
    categories: [...state.categories].sort((a, b) => categoryPathOf(a).localeCompare(categoryPathOf(b))),
    fields: [...state.fields].sort((a, b) => a.key.localeCompare(b.key)),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16)
}

/** Az oldalak változása a szimulációt is elavulttá teszi (új oldal is). */
export function configPagesVersionOf(pages: readonly Pick<WikiConfigPage, 'id' | 'version'>[]): string {
  const versions = pages.map(({ id, version }) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id))
  return createHash('sha256').update(JSON.stringify(versions)).digest('hex')
}

export function normalizeWikiMd(text: string): string {
  return `${text.replace(/\r\n/g, '\n').trim()}\n`
}

// ---------------------------------------------------------------------------
// Műveletek sémája

const PAGE_SORT_ALIASES: Record<string, WikiPageSort> = { newest: 'date_desc', updated: 'updated_desc' }
const pageSortSchema = z.preprocess(
  (value) => (typeof value === 'string' ? (PAGE_SORT_ALIASES[value] ?? value) : value),
  z.enum(['title', 'updated_desc', 'date_desc', 'manual']),
)
const fieldTypeSchema = z.preprocess(
  (value) => (value === 'single_select' ? 'select' : value),
  z.enum(['text', 'select', 'multi_select', 'date']),
)
const orderSchema = z.number().int().min(0).max(100_000)
const labelSchema = z.string().trim().min(1).max(WIKI_CATEGORY_MAX_NAME)
const descriptionSchema = z.string().max(WIKI_CATEGORY_MAX_DESCRIPTION)
const pathsSchema = z.array(z.string().trim().min(1).max(200)).max(WIKI_CATEGORY_MAX_PAGE_ORDER)
const keySchema = z.string().trim().toLowerCase().min(1).max(130)
const optionSchema = z.string().trim().min(1).max(WIKI_FIELD_MAX_OPTION)

const categoryPatchShape = {
  description: descriptionSchema.nullable().optional(),
  order: orderSchema.nullable().optional(),
  pageSort: pageSortSchema.optional(),
  collapsed: z.boolean().optional(),
  approval: z.enum(['inherit', 'always']).optional(),
  reviewCycleDays: z.number().int().min(1).max(WIKI_REVIEW_CYCLE_MAX_DAYS).nullable().optional(),
  template: z.string().trim().min(1).max(80).nullable().optional(),
}

const operationSchemas = {
  setName: z.object({ op: z.literal('setName'), name: z.string().trim().min(1).max(WIKI_NAME_MAX_CHARS) }).strict(),
  setCollectFocus: z.object({ op: z.literal('setCollectFocus'), collect: z.string().max(WIKI_COLLECT_MAX_CHARS).nullable() }).strict(),
  setWikiMd: z.object({ op: z.literal('setWikiMd'), text: z.string().trim().min(1).max(WIKI_MD_MAX_CHARS) }).strict(),
  upsertGroup: z
    .object({
      op: z.literal('upsertGroup'),
      key: keySchema,
      label: labelSchema,
      description: descriptionSchema.nullable().optional(),
      order: orderSchema.nullable().optional(),
      collapsed: z.boolean().optional(),
    })
    .strict(),
  upsertCategory: z.object({ op: z.literal('upsertCategory'), key: keySchema, label: labelSchema, ...categoryPatchShape }).strict(),
  updateCategory: z.object({ op: z.literal('updateCategory'), key: keySchema, label: labelSchema.optional(), ...categoryPatchShape }).strict(),
  removeCategory: z.object({ op: z.literal('removeCategory'), key: keySchema }).strict(),
  mergeCategory: z.object({ op: z.literal('mergeCategory'), from: keySchema, to: keySchema }).strict(),
  setPinned: z.object({ op: z.literal('setPinned'), category: keySchema, paths: pathsSchema }).strict(),
  setManualOrder: z.object({ op: z.literal('setManualOrder'), category: keySchema, paths: pathsSchema }).strict(),
  upsertMetadataField: z
    .object({
      op: z.literal('upsertMetadataField'),
      key: z.string().trim().toLowerCase().min(1).max(40),
      label: z.string().trim().min(1).max(WIKI_FIELD_MAX_NAME),
      type: fieldTypeSchema,
      options: z.array(optionSchema).max(WIKI_FIELD_MAX_OPTIONS).optional(),
      help: z.string().max(WIKI_FIELD_MAX_HELP).nullable().optional(),
    })
    .strict(),
  addFieldOption: z.object({ op: z.literal('addFieldOption'), field: z.string().trim().min(1), option: optionSchema }).strict(),
  renameFieldOption: z.object({ op: z.literal('renameFieldOption'), field: z.string().trim().min(1), from: optionSchema, to: optionSchema }).strict(),
  removeFieldOption: z
    .object({ op: z.literal('removeFieldOption'), field: z.string().trim().min(1), option: optionSchema, remapTo: optionSchema.optional() })
    .strict(),
  upsertTemplate: z
    .object({
      op: z.literal('upsertTemplate'),
      id: z.string().trim().toLowerCase().min(1).max(80),
      requiredFields: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
      requiredSections: z.array(z.string().max(200)).max(50).default([]),
      skeleton: z.string().max(WIKI_TEMPLATE_MAX_CHARS).nullable().optional(),
      sectionRule: z.enum(['warn', 'error']).optional(),
    })
    .strict(),
  removeTemplate: z.object({ op: z.literal('removeTemplate'), id: z.string().trim().toLowerCase().min(1).max(80) }).strict(),
}

type OperationName = keyof typeof operationSchemas
export type WikiConfigOperation = { [K in OperationName]: z.output<(typeof operationSchemas)[K]> }[OperationName]
export const WIKI_CONFIG_OPERATIONS = Object.keys(operationSchemas) as OperationName[]

type CategoryPatch = Partial<Pick<z.output<typeof operationSchemas.updateCategory>, keyof typeof categoryPatchShape | 'label'>>
type Template = Pick<WikiConfigCategory, 'requiredFields' | 'requiredSections' | 'sectionRule' | 'templateMd'>

// ---------------------------------------------------------------------------
// Szimuláció

export function simulateConfigOperations(input: {
  state: WikiConfigState
  pages: WikiConfigPage[]
  operations: unknown[]
  /** A munkatárs saját KB-jának és a céges katalógusnak a neve nem írható át. */
  nameEditable: boolean
}): WikiConfigSimulation {
  const next: WikiConfigState = {
    ...input.state,
    categories: input.state.categories.map((row) => ({ ...row })),
    fields: input.state.fields.map((row) => ({ ...row, options: [...row.options] })),
  }
  const pages = input.pages.map((page) => ({ ...page, frontmatter: { ...page.frontmatter } }))
  const original = new Map(input.pages.map((page) => [page.path, page]))
  const templates = templatesOf(next.categories)
  const issues: WikiConfigIssue[] = []
  const destructive: WikiConfigDestructive[] = []
  const counts: Record<string, number> = {}
  const rewritten = new Set<string>()

  const findCategory = (path: string) => next.categories.find((row) => categoryPathOf(row) === path)
  const pagesIn = (path: string) => pages.filter((page) => normalizeCategoryPath(page.category) === path)

  /** Felső szintű vagy gyerek kategória létrehozása / módosítása. */
  const upsert = (fail: (code: string, message: string) => void, path: string, label: string | undefined, patch: CategoryPatch) => {
    const parts = path.split('/')
    if (parts.length > 2 || !parts.every(isValidCategoryKey)) {
      return fail('invalid_key', `"${path}" is not a valid key: use lowercase letters, digits and hyphens, at most one "/".`)
    }
    const key = parts[parts.length - 1]
    const parentKey = parts.length === 2 ? parts[0] : null
    let row = next.categories.find((candidate) => candidate.key === key)
    if (row && (row.parentKey ?? null) !== parentKey) {
      return fail('key_taken', `The key "${key}" is already used by ${categoryPathOf(row)}: keys are unique within a wiki, the group does not make them unique.`)
    }
    if (row?.linkedConnectorId) return fail('linked_wiki_item', `${path} is a link to another wiki and cannot be changed here.`)
    if (parentKey) {
      const parent = next.categories.find((candidate) => candidate.key === parentKey && !candidate.parentKey)
      if (!parent) return fail('unknown_group', `The group "${parentKey}" does not exist; create it with an earlier upsertGroup.`)
      if (parent.linkedConnectorId) return fail('linked_wiki_item', `${parentKey} is a link to another wiki and cannot have subcategories.`)
    }
    const template = patch.template ? templates.get(patch.template) : null
    if (patch.template && !template) return fail('unknown_template', `The template "${patch.template}" does not exist; create it with an earlier upsertTemplate.`)
    if (!row) {
      if (next.categories.length >= WIKI_CATEGORY_MAX_COUNT) return fail('too_many_categories', `A wiki can have at most ${WIKI_CATEGORY_MAX_COUNT} categories.`)
      const siblings = next.categories.filter((candidate) => (candidate.parentKey ?? null) === parentKey)
      row = {
        key,
        parentKey,
        name: label ?? key,
        description: null,
        sortOrder: siblings.reduce((max, candidate) => Math.max(max, candidate.sortOrder ?? 0), 0) + WIKI_CATEGORY_ORDER_STEP,
        approval: 'inherit',
        pageSort: 'title',
        pinnedPages: [],
        pageOrder: [],
        collapsed: false,
        reviewCycleDays: null,
        requiredFields: [],
        requiredSections: [],
        sectionRule: 'warn',
        templateMd: null,
        templateKey: null,
        linkedConnectorId: null,
      }
      next.categories.push(row)
    }
    if (label !== undefined) row.name = label
    if (patch.description !== undefined) row.description = patch.description?.trim() || null
    if (patch.order !== undefined) row.sortOrder = patch.order
    if (patch.pageSort !== undefined) row.pageSort = patch.pageSort
    if (patch.collapsed !== undefined) row.collapsed = patch.collapsed
    if (patch.approval !== undefined) row.approval = patch.approval
    if (patch.reviewCycleDays !== undefined) row.reviewCycleDays = patch.reviewCycleDays
    if (patch.template === null) Object.assign(row, { requiredFields: [], requiredSections: [], sectionRule: 'warn', templateMd: null, templateKey: null })
    if (patch.template && template) Object.assign(row, { ...template, templateKey: patch.template })
  }

  input.operations.forEach((raw, index) => {
    const opName = raw && typeof raw === 'object' && typeof (raw as { op?: unknown }).op === 'string' ? (raw as { op: string }).op : null
    const fail = (code: string, message: string) => {
      issues.push({ index, op: opName, code, message })
    }
    const schema = opName && Object.hasOwn(operationSchemas, opName) ? operationSchemas[opName as OperationName] : null
    if (!schema) return fail('unknown_operation', `Unknown op "${opName ?? ''}". Use one of: ${WIKI_CONFIG_OPERATIONS.join(', ')}.`)
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      return fail('invalid_operation', parsed.error.issues.map((issue) => `${issue.path.join('.') || 'operation'}: ${issue.message}`).join('; '))
    }
    const op = parsed.data as WikiConfigOperation
    counts[op.op] = (counts[op.op] ?? 0) + 1

    switch (op.op) {
      case 'setName':
        if (!input.nameEditable) return fail('name_not_editable', 'The name of this knowledge base follows the agent or the organization and cannot be changed.')
        next.name = op.name
        return
      case 'setCollectFocus':
        next.collect = op.collect?.trim() || null
        return
      case 'setWikiMd':
        next.wikiMd = normalizeWikiMd(op.text)
        return
      case 'upsertGroup':
        if (op.key.includes('/')) return fail('invalid_key', `A group key has no "/": "${op.key}".`)
        return upsert(fail, op.key, op.label, op)
      case 'upsertCategory':
        return upsert(fail, op.key, op.label, op)
      case 'updateCategory':
        if (!findCategory(op.key)) return fail('unknown_category', `No category at ${op.key}.`)
        return upsert(fail, op.key, op.label, op)
      case 'removeCategory': {
        const row = findCategory(op.key)
        if (!row) return fail('unknown_category', `No category at ${op.key}.`)
        if (row.linkedConnectorId) return fail('linked_wiki_item', `${op.key} is a link to another wiki and cannot be removed here.`)
        if (pagesIn(op.key).length > 0) return fail('category_not_empty', `${op.key} has ${pagesIn(op.key).length} pages; move them with mergeCategory first.`)
        if (next.categories.some((candidate) => candidate.parentKey === row.key)) return fail('category_not_empty', `${op.key} still has subcategories.`)
        next.categories = next.categories.filter((candidate) => candidate !== row)
        return
      }
      case 'mergeCategory': {
        const from = findCategory(op.from)
        const to = findCategory(op.to)
        if (!from) return fail('unknown_category', `No category at ${op.from}.`)
        if (!to) return fail('unknown_category', `No category at ${op.to}.`)
        if (from === to) return fail('invalid_merge', 'A category cannot be merged into itself.')
        if (from.linkedConnectorId || to.linkedConnectorId) return fail('linked_wiki_item', 'A link to another wiki cannot be merged.')
        if (next.categories.some((candidate) => candidate.parentKey === from.key)) return fail('category_not_empty', `${op.from} still has subcategories.`)
        const moved = pagesIn(op.from)
        for (const page of moved) page.category = op.to
        next.categories = next.categories.filter((candidate) => candidate !== from)
        destructive.push({ kind: 'merge', from: op.from, to: op.to, pageCount: moved.length })
        return
      }
      case 'setPinned':
      case 'setManualOrder': {
        const row = findCategory(op.category)
        if (!row) return fail('unknown_category', `No category at ${op.category}.`)
        if (row.linkedConnectorId) return fail('linked_wiki_item', `${op.category} is a link to another wiki.`)
        const paths = [...new Set(op.paths)]
        const live = new Set(pagesIn(op.category).filter((page) => page.status === 'published').map((page) => page.path))
        const missing = paths.filter((path) => !live.has(path))
        if (missing.length) return fail('page_not_in_category', `Not published pages of ${op.category}: ${missing.slice(0, 10).join(', ')}.`)
        if (op.op === 'setPinned') {
          if (paths.length > WIKI_CATEGORY_MAX_PINNED) return fail('too_many_pinned', `At most ${WIKI_CATEGORY_MAX_PINNED} pages can be pinned.`)
          row.pinnedPages = paths
        } else {
          if (row.pageSort !== 'manual') return fail('not_manual_sort', `${op.category} is not sorted manually; set pageSort "manual" first.`)
          row.pageOrder = paths
        }
        return
      }
      case 'upsertMetadataField': {
        if (!isValidFieldKey(op.key)) return fail('invalid_key', `"${op.key}" is not a valid field key (lowercase letters, digits, underscore; some names are reserved).`)
        const options = cleanOptions(op.options ?? [])
        const selectable = op.type === 'select' || op.type === 'multi_select'
        if (selectable && op.options !== undefined && options.length === 0) return fail('invalid_options', `${op.key} needs at least one option.`)
        const current = next.fields.find((field) => field.key === op.key)
        if (!current) {
          if (next.fields.length >= WIKI_FIELD_MAX_COUNT) return fail('too_many_fields', `A wiki can have at most ${WIKI_FIELD_MAX_COUNT} fields.`)
          if (selectable && options.length === 0) return fail('invalid_options', `${op.key} needs at least one option.`)
          next.fields.push({
            key: op.key,
            name: op.label,
            type: op.type,
            options: selectable ? options : [],
            help: op.help?.trim() || null,
            sortOrder: next.fields.reduce((max, field) => Math.max(max, field.sortOrder), 0) + 10,
          })
          return
        }
        if (current.type !== op.type) return fail('field_type_immutable', `${op.key} is ${current.type}; the type of a field cannot change.`)
        if (selectable && op.options !== undefined) {
          const kept = new Set(options.map((option) => option.toLowerCase()))
          const lost = current.options.filter((option) => !kept.has(option.toLowerCase()) && pages.some((page) => fieldHasValue(page.frontmatter[op.key], option)))
          if (lost.length) return fail('option_in_use', `Options in use cannot be dropped: ${lost.join(', ')}. Use renameFieldOption or removeFieldOption with remapTo.`)
          current.options = options
        }
        current.name = op.label
        if (op.help !== undefined) current.help = op.help?.trim() || null
        return
      }
      case 'addFieldOption':
      case 'renameFieldOption':
      case 'removeFieldOption': {
        const field = next.fields.find((candidate) => candidate.key === op.field)
        if (!field) return fail('unknown_field', `No metadata field "${op.field}".`)
        if (field.type !== 'select' && field.type !== 'multi_select') return fail('invalid_options', `${op.field} has no options (${field.type}).`)
        const has = (option: string) => field.options.some((candidate) => candidate.toLowerCase() === option.toLowerCase())
        if (op.op === 'addFieldOption') {
          const [option] = cleanOptions([op.option])
          if (!option) return fail('invalid_options', 'The option is empty.')
          if (has(option)) return fail('option_exists', `${op.field} already has "${option}".`)
          if (field.options.length >= WIKI_FIELD_MAX_OPTIONS) return fail('invalid_options', `A field can have at most ${WIKI_FIELD_MAX_OPTIONS} options.`)
          field.options.push(option)
          return
        }
        const source = op.op === 'renameFieldOption' ? op.from : op.option
        if (!has(source)) return fail('unknown_option', `${op.field} has no option "${source}".`)
        const rewrite = (to: string | null) => {
          let count = 0
          for (const page of pages) {
            const value = page.frontmatter[field.key]
            if (!fieldHasValue(value, source)) continue
            page.frontmatter[field.key] = replaceFieldValue(value, source, to)
            rewritten.add(page.path)
            count++
          }
          return count
        }
        if (op.op === 'renameFieldOption') {
          const [to] = cleanOptions([op.to])
          if (!to) return fail('invalid_options', 'The new option is empty.')
          if (has(to) && to.toLowerCase() !== source.toLowerCase()) return fail('option_exists', `${op.field} already has "${to}"; use removeFieldOption with remapTo to merge them.`)
          field.options = field.options.map((candidate) => (candidate.toLowerCase() === source.toLowerCase() ? to : candidate))
          destructive.push({ kind: 'rename_option', field: field.key, from: source, to, pageCount: rewrite(to) })
          return
        }
        const inUse = pages.some((page) => fieldHasValue(page.frontmatter[field.key], source))
        if (inUse && !op.remapTo) return fail('option_in_use', `"${source}" is in use; pass remapTo.`)
        if (op.remapTo && (!has(op.remapTo) || op.remapTo.toLowerCase() === source.toLowerCase())) {
          return fail('unknown_option', `remapTo must be another existing option of ${op.field}.`)
        }
        const remapTo = op.remapTo ? field.options.find((candidate) => candidate.toLowerCase() === op.remapTo!.toLowerCase())! : null
        const remaining = field.options.filter((candidate) => candidate.toLowerCase() !== source.toLowerCase())
        if (remaining.length === 0) return fail('invalid_options', `${op.field} must keep at least one option.`)
        field.options = remaining
        destructive.push({ kind: 'remove_option', field: field.key, option: source, remapTo, pageCount: inUse ? rewrite(remapTo) : 0 })
        return
      }
      case 'upsertTemplate': {
        if (!isValidCategoryKey(op.id)) return fail('invalid_key', `"${op.id}" is not a valid template id (lowercase letters, digits, hyphens).`)
        const known = new Set<string>([...WIKI_REQUIRABLE_BUILTINS, ...next.fields.map((field) => field.key)])
        const unknown = op.requiredFields.filter((key) => !known.has(key))
        if (unknown.length) return fail('unknown_field', `Unknown required fields: ${unknown.join(', ')}. Use ${WIKI_REQUIRABLE_BUILTINS.join(', ')} or a field created earlier.`)
        const requiredSections = uniqueSections(op.requiredSections)
        if (requiredSections.length > WIKI_SECTIONS_MAX_COUNT) return fail('too_many_sections', `At most ${WIKI_SECTIONS_MAX_COUNT} required sections.`)
        const template: Template = {
          requiredFields: [...new Set(op.requiredFields)],
          requiredSections,
          sectionRule: op.sectionRule ?? 'warn',
          templateMd: op.skeleton?.trim() || null,
        }
        templates.set(op.id, template)
        for (const row of next.categories) if (row.templateKey === op.id) Object.assign(row, template)
        return
      }
      case 'removeTemplate': {
        if (!templates.has(op.id)) return fail('unknown_template', `No template "${op.id}".`)
        const users = next.categories.filter((row) => row.templateKey === op.id).map(categoryPathOf)
        if (users.length) return fail('template_in_use', `Still used by: ${users.join(', ')}. Clear it with updateCategory template:null first.`)
        templates.delete(op.id)
        return
      }
    }
  })

  const pageChanges: WikiConfigPageChange[] = []
  for (const page of pages) {
    const before = original.get(page.path)!
    const moved = normalizeCategoryPath(before.category) !== normalizeCategoryPath(page.category)
    if (!moved && !rewritten.has(page.path)) continue
    pageChanges.push({
      path: page.path,
      fromCategory: before.category,
      toCategory: page.category,
      ...(rewritten.has(page.path) ? { frontmatter: page.frontmatter } : {}),
    })
  }

  const warnings: string[] = []
  if (!next.managedCategories && next.categories.length > 0) warnings.push('managed_categories_off')
  if (!next.managedFields && next.fields.length > 0) warnings.push('managed_fields_off')
  return { ok: issues.length === 0, issues, next, pageChanges, destructive, warnings, counts }
}

/** A sablon a kategórián él; a név alatti változat a legelső rá hivatkozó kategória szabálya. */
export function templatesOf(categories: readonly WikiConfigCategory[]): Map<string, Template> {
  const out = new Map<string, Template>()
  for (const row of categories) {
    if (!row.templateKey || out.has(row.templateKey)) continue
    out.set(row.templateKey, {
      requiredFields: [...row.requiredFields],
      requiredSections: [...row.requiredSections],
      sectionRule: row.sectionRule,
      templateMd: row.templateMd,
    })
  }
  return out
}

/** Ugyanaz a tisztítás, mint a felületen (`WikiMetadataService`): vessző nélkül, kis-nagybetűre egyedi. */
function cleanOptions(options: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of options) {
    const value = raw.replace(/\s+/g, ' ').trim().replace(/,/g, ' ').slice(0, WIKI_FIELD_MAX_OPTION)
    if (!value || seen.has(value.toLowerCase())) continue
    seen.add(value.toLowerCase())
    out.push(value)
  }
  return out
}

function sameOption(value: unknown, option: string): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === option.toLowerCase()
}

function fieldHasValue(value: unknown, option: string): boolean {
  return Array.isArray(value) ? value.some((item) => sameOption(item, option)) : sameOption(value, option)
}

/** Egy opció cseréje (vagy törlése, `to: null`) egy- és többértékű mezőben, duplikátum nélkül. */
function replaceFieldValue(value: unknown, option: string, to: string | null): unknown {
  if (!Array.isArray(value)) return to
  const mapped = value.flatMap((item) => (sameOption(item, option) ? (to ? [to] : []) : [item]))
  const seen = new Set<string>()
  return mapped.filter((item) => {
    const key = typeof item === 'string' ? item.trim().toLowerCase() : JSON.stringify(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ---------------------------------------------------------------------------
// Változás-összefoglaló (jóváhagyó oldal, agent-válasz)

export type WikiConfigListDiff = { added: string[]; changed: string[]; removed: string[] }

export type WikiConfigDiff = {
  name: { from: string | null; to: string | null } | null
  collect: { from: string | null; to: string | null } | null
  wikiMd: { from: string; to: string } | null
  groups: WikiConfigListDiff
  categories: WikiConfigListDiff
  fields: WikiConfigListDiff
  templates: WikiConfigListDiff
}

function listDiff<T>(before: readonly T[], after: readonly T[], keyOf: (row: T) => string): WikiConfigListDiff {
  const old = new Map(before.map((row) => [keyOf(row), JSON.stringify(row)]))
  const now = new Map(after.map((row) => [keyOf(row), JSON.stringify(row)]))
  return {
    added: [...now.keys()].filter((key) => !old.has(key)),
    changed: [...now.keys()].filter((key) => old.has(key) && old.get(key) !== now.get(key)),
    removed: [...old.keys()].filter((key) => !now.has(key)),
  }
}

export function diffConfig(before: WikiConfigState, after: WikiConfigState): WikiConfigDiff {
  const isGroup = (row: WikiConfigCategory) => !row.parentKey
  const isChild = (row: WikiConfigCategory) => !!row.parentKey
  return {
    name: before.name !== after.name ? { from: before.name, to: after.name } : null,
    collect: before.collect !== after.collect ? { from: before.collect, to: after.collect } : null,
    wikiMd: before.wikiMd !== after.wikiMd ? { from: before.wikiMd, to: after.wikiMd } : null,
    groups: listDiff(before.categories.filter(isGroup), after.categories.filter(isGroup), categoryPathOf),
    categories: listDiff(before.categories.filter(isChild), after.categories.filter(isChild), categoryPathOf),
    fields: listDiff(before.fields, after.fields, (row) => row.key),
    templates: listDiff(
      [...templatesOf(before.categories)].map(([id, template]) => ({ id, ...template })),
      [...templatesOf(after.categories)].map(([id, template]) => ({ id, ...template })),
      (row) => row.id,
    ),
  }
}

/** Rövid összefoglaló az agentnek: darabszámok és érintett kulcsok, szöveg nélkül. */
export function summarizeSimulation(state: WikiConfigState, simulation: WikiConfigSimulation) {
  const diff = diffConfig(state, simulation.next)
  return {
    operations: simulation.counts,
    ...(diff.name ? { nameChanged: true } : {}),
    ...(diff.collect ? { collectChanged: true } : {}),
    ...(diff.wikiMd ? { wikiMdChanged: true } : {}),
    groups: diff.groups,
    categories: diff.categories,
    fields: diff.fields,
    templates: diff.templates,
    pageChanges: simulation.pageChanges.length,
  }
}
