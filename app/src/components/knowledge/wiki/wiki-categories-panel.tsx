'use client'

import { useState, useTransition, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  createWikiCategoryAction,
  deleteWikiCategoryAction,
  reorderWikiCategoriesAction,
  setWikiCategoriesManagedAction,
  updateWikiCategoryAction,
} from '@/app/actions/knowledge-wiki'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { Card } from '@/components/ui/shell'
import { WIKI_CATEGORY_MAX_PINNED, WIKI_PAGE_SORTS, slugifyCategory, type WikiPageSort } from '@/lib/wiki-categories'

type Approval = 'inherit' | 'always'
type Node = {
  id: string
  key: string
  path: string
  parentId: string | null
  name: string
  description: string | null
  /** `null` = nincs megadva (a sorrendezettek után, név szerint). */
  sortOrder: number | null
  approval: Approval
  /** Menü: oldalrendezés, kiemelt oldalak, kézi sorrend, alapból becsukva; a publikált oldalak menüsorrendben. */
  pageSort?: WikiPageSort
  pinnedPages?: string[]
  pageOrder?: string[]
  collapsed?: boolean
  pages?: Array<{ path: string; title: string }>
  protected: boolean
  published: number
  archived: number
  totalPublished?: number
  children: Node[]
  /** #1061 F3/F4: átnézési ciklus, kötelező mezők, oldalsablon. */
  reviewCycleDays?: number | null
  requiredFields?: string[]
  requiredSections?: string[]
  sectionRule?: 'warn' | 'error'
  templateMd?: string | null
}

type RulesPatch = {
  pageSort?: WikiPageSort
  pinnedPages?: string[]
  pageOrder?: string[]
  collapsed?: boolean
  reviewCycleDays?: number | null
  requiredFields?: string[]
  requiredSections?: string[]
  sectionRule?: 'warn' | 'error'
  templateMd?: string | null
}

type Requirable = { key: string; name: string | null; builtin: boolean }

export type WikiCategoriesData = {
  managed: boolean
  maxCategories: number
  categories: Node[]
  outsideTree: number
  importPreview: Array<{ key: string; name: string; pageCount: number; exists: boolean }>
  /** #1061 F2: „kapcsolt wiki” menüpontok és a felvehető célok. */
  linkedWikis: Array<{
    id: string
    key: string
    name: string
    parentKey: string | null
    linkedConnectorId: string
    targetName: string | null
    targetVisible: boolean
  }>
  linkableWikis: Array<{ connectorId: string; name: string }>
  /** #1061 F3: kötelezővé tehető mezők (csak bekapcsolt metaadat-mezőknél). */
  fieldsManaged?: boolean
  requirableFields?: Requirable[]
}

const CATEGORY_ERRORS = [
  'not_found',
  'forbidden',
  'invalid_args',
  'key_taken',
  'invalid_key',
  'too_deep',
  'not_empty',
  'too_many',
  'conflict',
] as const

function categoryErrorKey(code: string): (typeof CATEGORY_ERRORS)[number] | 'generic' {
  return (CATEGORY_ERRORS as readonly string[]).includes(code) ? (code as (typeof CATEGORY_ERRORS)[number]) : 'generic'
}

const inputClass = 'w-full rounded-lg border border-line/70 px-3 py-1.5 text-sm'

/** Egy elem áthelyezése a listában (`to` = a cél indexe az eredeti listában). */
function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/**
 * Húzással és ↑/↓ gombbal rendezhető lista. Csak a fogantyú húzható, így a sorban lévő
 * űrlapmezők továbbra is szerkeszthetők; a gombok mobilon és billentyűzettel is működnek.
 */
function SortableList<T extends { id: string }>({
  items,
  disabled,
  onReorder,
  renderItem,
  className,
  itemClassName,
  testId,
}: {
  items: T[]
  disabled?: boolean
  onReorder: (ids: string[]) => void
  renderItem: (item: T, controls: ReactNode) => ReactNode
  className?: string
  itemClassName?: string
  testId?: string
}) {
  const t = useTranslations('ControlPlane.wiki.categories.order')
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const ids = items.map((item) => item.id)
  const move = (from: number, to: number) => {
    const next = moveItem(ids, from, to)
    if (next !== ids) onReorder(next)
  }
  return (
    <ul className={className} data-testid={testId}>
      {items.map((item, index) => {
        const controls = items.length > 1 ? (
          <span className="flex shrink-0 items-center gap-0.5 text-ink-faint">
            <span
              draggable={!disabled}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', item.id)
                setDragId(item.id)
              }}
              onDragEnd={() => {
                setDragId(null)
                setOverId(null)
              }}
              title={t('dragHint')}
              aria-hidden
              className={`select-none px-0.5 ${disabled ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'}`}
              data-testid="sortable-handle"
            >
              ⋮⋮
            </span>
            <button
              type="button"
              disabled={disabled || index === 0}
              onClick={() => move(index, index - 1)}
              aria-label={t('moveUp')}
              title={t('moveUp')}
              className="rounded px-0.5 hover:text-ink disabled:opacity-30"
            >
              ↑
            </button>
            <button
              type="button"
              disabled={disabled || index === items.length - 1}
              onClick={() => move(index, index + 1)}
              aria-label={t('moveDown')}
              title={t('moveDown')}
              className="rounded px-0.5 hover:text-ink disabled:opacity-30"
            >
              ↓
            </button>
          </span>
        ) : null
        return (
          <li
            key={item.id}
            className={`${itemClassName ?? ''} ${overId === item.id && dragId && dragId !== item.id ? 'bg-coral/5 ring-1 ring-inset ring-coral/40' : ''}`}
            onDragOver={(event) => {
              if (!dragId || !ids.includes(dragId)) return
              event.preventDefault()
              setOverId(item.id)
            }}
            onDragLeave={() => setOverId((current) => (current === item.id ? null : current))}
            onDrop={(event) => {
              event.preventDefault()
              if (dragId && ids.includes(dragId)) move(ids.indexOf(dragId), index)
              setDragId(null)
              setOverId(null)
            }}
          >
            {renderItem(item, controls)}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * #1061 F1: „Kategóriák” — kezelt kategória-fa (2 szint), kategóriánkénti
 * jóváhagyási szabály. Minden mentés előtt kimondja, mi fog történni (NFR-1).
 */
export function WikiCategoriesPanel({ connectorId, data }: { connectorId: string; data: WikiCategoriesData }) {
  const t = useTranslations('ControlPlane.wiki.categories')
  const tw = useTranslations('ControlPlane.wiki')
  const router = useRouter()
  const [pending, start] = useTransition()
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [confirmToggle, setConfirmToggle] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const run = (fn: () => Promise<{ success: boolean; error?: string }>, okText: string, after?: () => void) =>
    start(async () => {
      setMessage(null)
      const res = await fn()
      if (!res.success) {
        setMessage({ kind: 'error', text: t(`errors.${categoryErrorKey(res.error ?? '')}`) })
        return
      }
      setMessage({ kind: 'ok', text: okText })
      after?.()
      router.refresh()
    })

  const topLevel = data.categories
  const count = data.categories.reduce((sum, node) => sum + 1 + node.children.length, 0)

  return (
    <Card title={t('title')}>
      <div className="space-y-4" data-testid="wiki-categories">
        <div className="rounded-lg border border-line/70 bg-paper/60 px-3 py-2 text-sm text-ink-soft">
          <p>{t('intro')}</p>
          <p className="mt-1">{t('introApproval')}</p>
        </div>

        {!data.managed ? (
          <div className="space-y-3">
            <p className="text-sm font-medium text-ink" data-testid="wiki-categories-off">{t('off')}</p>
            {confirmToggle ? (
              <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm" data-testid="wiki-categories-preview">
                {data.importPreview.length === 0 ? (
                  <p>{t('previewNone')}</p>
                ) : (
                  <>
                    <p>{t('previewTitle', { count: data.importPreview.length })}</p>
                    <ul className="list-disc space-y-0.5 pl-5">
                      {data.importPreview.map((row) => (
                        <li key={row.key}>
                          <span className="font-medium">{row.name}</span>{' '}
                          <code className="text-xs text-ink-faint">{row.key}</code> — {t('pages', { count: row.pageCount })}
                          {row.exists ? ` · ${t('previewExists')}` : ''}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <p>{t('previewAfter')}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    data-testid="wiki-categories-enable-confirm"
                    onClick={() =>
                      run(
                        () => setWikiCategoriesManagedAction({ connectorId, managed: true }),
                        t('enabled'),
                        () => setConfirmToggle(false),
                      )
                    }
                    className="rounded-lg bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-50"
                  >
                    {pending ? tw('common.saving') : t('enableConfirm')}
                  </button>
                  <button type="button" onClick={() => setConfirmToggle(false)} className="rounded-lg px-3 py-1.5 text-sm text-ink-soft">
                    {tw('common.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                data-testid="wiki-categories-enable"
                onClick={() => setConfirmToggle(true)}
                className="rounded-lg bg-ink px-3 py-1.5 text-sm text-white"
              >
                {t('enable')}
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-ink" data-testid="wiki-categories-on">{t('on')}</p>
              {confirmToggle ? (
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-ink-soft">{t('disableWarning')}</span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      run(
                        () => setWikiCategoriesManagedAction({ connectorId, managed: false }),
                        t('disabled'),
                        () => setConfirmToggle(false),
                      )
                    }
                    className="rounded-lg border border-line px-2 py-1 text-xs"
                  >
                    {t('disableConfirm')}
                  </button>
                  <button type="button" onClick={() => setConfirmToggle(false)} className="text-xs text-ink-soft">
                    {tw('common.cancel')}
                  </button>
                </span>
              ) : (
                <button type="button" onClick={() => setConfirmToggle(true)} className="text-xs text-ink-soft underline">
                  {t('disable')}
                </button>
              )}
            </div>
            {data.outsideTree > 0 ? <p className="text-xs text-ink-faint">{t('outsideTree', { count: data.outsideTree })}</p> : null}

            {data.categories.length === 0 ? (
              <p className="text-sm text-ink-soft">{t('emptyTree')}</p>
            ) : (
              <SortableList
                items={data.categories}
                disabled={pending}
                onReorder={(orderedIds) => run(() => reorderWikiCategoriesAction({ connectorId, parentId: null, orderedIds }), t('order.saved'))}
                className="divide-y divide-line/60 rounded-lg border border-line/70"
                testId="wiki-categories-tree"
                renderItem={(node, controls) => (
                  <>
                    <CategoryRow
                      key={JSON.stringify(node)}
                      controls={controls}
                      requirable={data.fieldsManaged ? data.requirableFields ?? [] : null}
                      node={node}
                      parent={null}
                      topLevel={topLevel}
                      editing={editing === node.id}
                      onEdit={() => setEditing(editing === node.id ? null : node.id)}
                      pending={pending}
                      onSave={(patch) =>
                        run(() => updateWikiCategoryAction({ connectorId, categoryId: node.id, ...patch }), t('saved'), () => setEditing(null))
                      }
                      onDelete={() => run(() => deleteWikiCategoryAction({ connectorId, categoryId: node.id }), t('deleted'))}
                    />
                    {node.children.length ? (
                      <SortableList
                        items={node.children}
                        disabled={pending}
                        onReorder={(orderedIds) =>
                          run(() => reorderWikiCategoriesAction({ connectorId, parentId: node.id, orderedIds }), t('order.saved'))
                        }
                        className="border-t border-line/40 bg-paper/40"
                        itemClassName="pl-6"
                        renderItem={(child, childControls) => (
                          <CategoryRow
                            key={JSON.stringify(child)}
                            controls={childControls}
                            requirable={data.fieldsManaged ? data.requirableFields ?? [] : null}
                            node={child}
                            parent={node}
                            topLevel={topLevel}
                            editing={editing === child.id}
                            onEdit={() => setEditing(editing === child.id ? null : child.id)}
                            pending={pending}
                            onSave={(patch) =>
                              run(
                                () => updateWikiCategoryAction({ connectorId, categoryId: child.id, ...patch }),
                                t('saved'),
                                () => setEditing(null),
                              )
                            }
                            onDelete={() => run(() => deleteWikiCategoryAction({ connectorId, categoryId: child.id }), t('deleted'))}
                          />
                        )}
                      />
                    ) : null}
                  </>
                )}
              />
            )}
            {data.categories.length > 1 ? <p className="text-xs text-ink-faint">{t('order.treeHint')}</p> : null}

            <LinkedWikisSection
              data={data}
              topLevel={topLevel}
              pending={pending}
              onCreate={(input) => run(() => createWikiCategoryAction({ connectorId, ...input }), t('linked.created'))}
              onDelete={(categoryId) => run(() => deleteWikiCategoryAction({ connectorId, categoryId }), t('deleted'))}
            />

            {adding ? (
              <NewCategoryForm
                topLevel={topLevel}
                pending={pending}
                onCancel={() => setAdding(false)}
                onSubmit={(input) =>
                  run(() => createWikiCategoryAction({ connectorId, ...input }), t('created'), () => setAdding(false))
                }
              />
            ) : (
              <button
                type="button"
                disabled={count >= data.maxCategories}
                data-testid="wiki-category-add"
                onClick={() => setAdding(true)}
                className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink disabled:opacity-50"
              >
                {t('add')}
              </button>
            )}
          </div>
        )}

        {message ? (
          <p className={`text-sm ${message.kind === 'ok' ? 'text-sage' : 'text-coral-deep'}`} role="status">
            {message.text}
          </p>
        ) : null}
      </div>
    </Card>
  )
}

function CategoryRow({
  controls,
  node,
  parent,
  topLevel,
  editing,
  onEdit,
  pending,
  onSave,
  onDelete,
  requirable,
}: {
  /** Húzó-fogantyú és ↑/↓ gombok (a szülő lista adja). */
  controls?: ReactNode
  node: Node
  parent: Node | null
  topLevel: Node[]
  editing: boolean
  onEdit: () => void
  pending: boolean
  onSave: (patch: { name?: string; description?: string | null; parentId?: string | null; sortOrder?: number | null; approval?: Approval } & RulesPatch) => void
  onDelete: () => void
  /** `null` = a metaadat-mezők ki vannak kapcsolva (ciklus és kötelező mező nem állítható). */
  requirable: Requirable[] | null
}) {
  const t = useTranslations('ControlPlane.wiki.categories')
  const tw = useTranslations('ControlPlane.wiki')
  const [name, setName] = useState(node.name)
  const [description, setDescription] = useState(node.description ?? '')
  const [parentId, setParentId] = useState(node.parentId ?? '')
  const [sortOrder, setSortOrder] = useState(node.sortOrder === null ? '' : String(node.sortOrder))
  const [pageSort, setPageSort] = useState<WikiPageSort>(node.pageSort ?? 'title')
  const [collapsed, setCollapsed] = useState(!!node.collapsed)
  const [pinned, setPinned] = useState<string[]>(node.pinnedPages ?? [])
  const categoryPages = node.pages ?? []
  // Kézi sorrend: a mostani menüsorrendből indul (a kiemeltek nélkül nem kell külön kezelni — azok úgyis felül vannak).
  const [manual, setManual] = useState<string[]>(categoryPages.map((page) => page.path))
  const sortOrderValue = sortOrder.trim() === '' ? null : Math.max(0, Math.min(100000, Math.floor(Number(sortOrder)) || 0))
  const titleOf = (path: string) => categoryPages.find((page) => page.path === path)?.title ?? path
  const [approval, setApproval] = useState<Approval>(node.approval)
  const [cycle, setCycle] = useState(node.reviewCycleDays ? String(node.reviewCycleDays) : '')
  const [required, setRequired] = useState<string[]>(node.requiredFields ?? [])
  const [sections, setSections] = useState((node.requiredSections ?? []).join('\n'))
  const [sectionRule, setSectionRule] = useState<'warn' | 'error'>(node.sectionRule ?? 'warn')
  const [template, setTemplate] = useState(node.templateMd ?? '')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const sectionList = sections.split('\n').map((line) => line.replace(/^#+\s*/, '').trim()).filter(Boolean)
  const cycleValue = cycle.trim() ? Math.max(1, Math.min(3650, Math.floor(Number(cycle)) || 0)) || null : null
  const pages = node.totalPublished ?? node.published
  const empty = node.published + node.archived === 0 && node.children.length === 0
  const inheritedProtection = !!parent && parent.approval === 'always'
  const parentChanged = (parentId || null) !== (node.parentId ?? null)
  const movedPath = parentChanged ? (parentId ? `${topLevel.find((row) => row.id === parentId)?.key}/${node.key}` : node.key) : null

  return (
    <div className="px-3 py-2" data-testid="wiki-category-row">
      <div className="flex flex-wrap items-center gap-2">
        {controls}
        <span className="text-sm font-medium text-ink">{node.name}</span>
        <code className="text-xs text-ink-faint">{node.path}</code>
        <span className="text-xs text-ink-faint" data-testid="wiki-category-order">
          {node.sortOrder === null ? t('order.unset') : t('order.badge', { order: node.sortOrder })}
        </span>
        {node.collapsed ? <span className="rounded-full bg-ink/5 px-2 text-xs text-ink-soft">{t('menu.collapsedBadge')}</span> : null}
        {node.pageSort && node.pageSort !== 'title' ? (
          <span className="rounded-full bg-ink/5 px-2 text-xs text-ink-soft">{t(`menu.sortBadge.${node.pageSort}`)}</span>
        ) : null}
        {node.pinnedPages?.length ? (
          <span className="rounded-full bg-ink/5 px-2 text-xs text-ink-soft">{t('menu.pinnedBadge', { count: node.pinnedPages.length })}</span>
        ) : null}
        <span className="text-xs text-ink-soft">{t('pages', { count: pages })}</span>
        {node.archived ? <span className="text-xs text-ink-faint">{t('archivedPages', { count: node.archived })}</span> : null}
        {node.protected ? (
          <span className="rounded-full bg-amber-100 px-2 text-xs text-amber-800">
            {node.approval === 'always' ? t('ruleAlways') : t('ruleInherited')}
          </span>
        ) : null}
        {node.reviewCycleDays && requirable ? (
          <span className="rounded-full bg-ink/5 px-2 text-xs text-ink-soft">{t('rules.cycleBadge', { days: node.reviewCycleDays })}</span>
        ) : null}
        {node.requiredFields?.length && requirable ? (
          <span className="rounded-full bg-ink/5 px-2 text-xs text-ink-soft">{t('rules.fieldsBadge', { count: node.requiredFields.length })}</span>
        ) : null}
        {node.requiredSections?.length || node.templateMd ? (
          <span className="rounded-full bg-ink/5 px-2 text-xs text-ink-soft" data-testid="wiki-category-template-badge">
            {t('rules.templateBadge', { count: node.requiredSections?.length ?? 0 })}
          </span>
        ) : null}
        <span className="ml-auto flex gap-2 text-xs">
          <button type="button" onClick={onEdit} className="text-coral-deep hover:underline" data-testid="wiki-category-edit">
            {editing ? tw('common.close') : t('edit')}
          </button>
          {confirmDelete ? (
            <span className="flex gap-2">
              <button type="button" disabled={pending} onClick={onDelete} className="text-coral-deep">
                {t('deleteConfirm')}
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="text-ink-soft">
                {tw('common.cancel')}
              </button>
            </span>
          ) : (
            <button
              type="button"
              disabled={!empty}
              title={empty ? undefined : t('deleteBlocked')}
              onClick={() => setConfirmDelete(true)}
              className="text-ink-soft hover:text-coral-deep disabled:opacity-40"
            >
              {t('delete')}
            </button>
          )}
        </span>
      </div>
      {node.description ? <p className="mt-0.5 text-xs text-ink-soft">{node.description}</p> : null}

      {editing ? (
        <form
          className="mt-3 grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault()
            const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((item, i) => item === b[i])
            onSave({
              ...(name !== node.name ? { name } : {}),
              ...(description !== (node.description ?? '') ? { description: description || null } : {}),
              ...(parentChanged ? { parentId: parentId || null } : {}),
              ...(sortOrderValue !== node.sortOrder ? { sortOrder: sortOrderValue } : {}),
              ...(pageSort !== (node.pageSort ?? 'title') ? { pageSort } : {}),
              ...(collapsed !== !!node.collapsed ? { collapsed } : {}),
              ...(!sameList(pinned, node.pinnedPages ?? []) ? { pinnedPages: pinned } : {}),
              ...(pageSort === 'manual' && !sameList(manual, node.pageOrder ?? []) ? { pageOrder: manual } : {}),
              ...(approval !== node.approval ? { approval } : {}),
              ...(requirable && cycleValue !== (node.reviewCycleDays ?? null) ? { reviewCycleDays: cycleValue } : {}),
              ...(requirable && !sameList(required, node.requiredFields ?? []) ? { requiredFields: required } : {}),
              ...(!sameList(sectionList, node.requiredSections ?? []) ? { requiredSections: sectionList } : {}),
              ...(sectionRule !== (node.sectionRule ?? 'warn') ? { sectionRule } : {}),
              ...(template.trim() !== (node.templateMd ?? '') ? { templateMd: template.trim() || null } : {}),
            })
          }}
        >
          <label className="text-sm">
            <span className="mb-1 block text-ink">{t('nameLabel')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required className={inputClass} />
          </label>
          <label className="text-sm">
            <span className="mb-1 flex items-center text-ink">
              {t('parentLabel')}
              <HelpHint>{t('parentHelp')}</HelpHint>
            </span>
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              disabled={node.children.length > 0}
              className={inputClass}
            >
              <option value="">{t('topLevel')}</option>
              {topLevel
                .filter((row) => row.id !== node.id)
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 flex items-center text-ink">
              {t('descriptionLabel')}
              <HelpHint>{t('descriptionHelp')}</HelpHint>
            </span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} className={inputClass} />
          </label>
          <label className="text-sm">
            <span className="mb-1 flex items-center text-ink">
              {t('approvalLabel')}
              <HelpHint>{t('approvalHelp')}</HelpHint>
            </span>
            <select value={approval} onChange={(e) => setApproval(e.target.value as Approval)} className={inputClass}>
              <option value="inherit">{t('approvalInherit')}</option>
              <option value="always">{t('approvalAlways')}</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 flex items-center text-ink">
              {t('orderLabel')}
              <HelpHint>{t('orderHelp')}</HelpHint>
            </span>
            <input
              type="number"
              min={0}
              max={100000}
              step={1}
              value={sortOrder}
              placeholder={t('order.placeholder')}
              onChange={(e) => setSortOrder(e.target.value)}
              className={inputClass}
              data-testid="wiki-category-order-input"
            />
          </label>

          <fieldset className="space-y-3 rounded-lg border border-line/70 px-3 py-2 sm:col-span-2" data-testid="wiki-category-menu">
            <legend className="px-1 text-sm font-medium text-ink">{t('menu.title')}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1 flex items-center text-ink">
                  {t('menu.sortLabel')}
                  <HelpHint>{t('menu.sortHelp')}</HelpHint>
                </span>
                <select
                  value={pageSort}
                  onChange={(e) => setPageSort(e.target.value as WikiPageSort)}
                  className={inputClass}
                  data-testid="wiki-category-page-sort"
                >
                  {WIKI_PAGE_SORTS.map((sort) => (
                    <option key={sort} value={sort}>
                      {t(`menu.sort.${sort}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 self-end text-sm">
                <input type="checkbox" checked={collapsed} onChange={(e) => setCollapsed(e.target.checked)} data-testid="wiki-category-collapsed" />
                <span className="text-ink">{t('menu.collapsedLabel')}</span>
                <HelpHint>{t('menu.collapsedHelp')}</HelpHint>
              </label>
            </div>
            <div className="text-sm">
              <span className="mb-1 flex items-center text-ink">
                {t('menu.pinnedLabel', { max: WIKI_CATEGORY_MAX_PINNED })}
                <HelpHint>{t('menu.pinnedHelp')}</HelpHint>
              </span>
              {categoryPages.length === 0 ? (
                <p className="text-xs text-ink-faint">{t('menu.noPages')}</p>
              ) : (
                <div className="flex max-h-40 flex-col gap-1 overflow-y-auto" data-testid="wiki-category-pinned">
                  {categoryPages.map((page) => (
                    <label key={page.path} className="flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={pinned.includes(page.path)}
                        disabled={!pinned.includes(page.path) && pinned.length >= WIKI_CATEGORY_MAX_PINNED}
                        onChange={(e) =>
                          setPinned(e.target.checked ? [...pinned, page.path] : pinned.filter((path) => path !== page.path))
                        }
                      />
                      <span className="truncate">{page.title}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            {pageSort === 'manual' && categoryPages.length > 1 ? (
              <div className="text-sm">
                <span className="mb-1 block text-ink">{t('menu.manualLabel')}</span>
                <SortableList
                  items={manual.map((path) => ({ id: path }))}
                  onReorder={setManual}
                  className="max-h-60 divide-y divide-line/50 overflow-y-auto rounded-lg border border-line/70 bg-white"
                  testId="wiki-category-manual-order"
                  renderItem={(item, itemControls) => (
                    <div className="flex items-center gap-2 px-2 py-1 text-xs">
                      {itemControls}
                      <span className="truncate">{titleOf(item.id)}</span>
                      {pinned.includes(item.id) ? <span className="ml-auto text-ink-faint">{t('menu.pinnedShort')}</span> : null}
                    </div>
                  )}
                />
              </div>
            ) : null}
            <p className="rounded-lg bg-paper px-3 py-2 text-xs text-ink-soft" data-testid="wiki-category-menu-preview">
              {[
                sortOrderValue === null ? t('menu.previewNoOrder') : t('menu.previewOrder', { order: sortOrderValue }),
                pinned.length ? t('menu.previewPinned', { titles: pinned.map(titleOf).join(', ') }) : null,
                t(`menu.preview.${pageSort}`),
                collapsed ? t('menu.previewCollapsed') : null,
              ]
                .filter(Boolean)
                .join(' ')}
            </p>
          </fieldset>
          {approval === 'always' && node.approval !== 'always' ? (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 sm:col-span-2" data-testid="wiki-category-rule-preview">
              {t('rulePreview', { count: pages, name: node.name })}
            </p>
          ) : null}
          {approval === 'inherit' && node.approval === 'always' ? (
            <p className="rounded-lg bg-paper px-3 py-2 text-xs text-ink-soft sm:col-span-2">
              {inheritedProtection ? t('ruleRelaxParent') : t('ruleRelax')}
            </p>
          ) : null}
          {movedPath && node.published + node.archived > 0 ? (
            <p className="rounded-lg bg-paper px-3 py-2 text-xs text-ink-soft sm:col-span-2">
              {t('movePreview', { count: node.published + node.archived, path: movedPath })}
            </p>
          ) : null}

          <fieldset className="space-y-3 rounded-lg border border-line/70 px-3 py-2 sm:col-span-2" data-testid="wiki-category-rules">
            <legend className="px-1 text-sm font-medium text-ink">{t('rules.title')}</legend>
            <p className="text-xs text-ink-soft">{parent ? t('rules.introChild', { parent: parent.name }) : t('rules.intro')}</p>
            {requirable ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 flex items-center text-ink">
                    {t('rules.cycleLabel')}
                    <HelpHint>{t('rules.cycleHelp')}</HelpHint>
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={cycle}
                    placeholder={t('rules.cyclePlaceholder')}
                    onChange={(e) => setCycle(e.target.value)}
                    className={inputClass}
                    data-testid="wiki-category-cycle"
                  />
                </label>
                <div className="text-sm">
                  <span className="mb-1 flex items-center text-ink">
                    {t('rules.requiredLabel')}
                    <HelpHint>{t('rules.requiredHelp')}</HelpHint>
                  </span>
                  {requirable.length <= 1 ? <p className="text-xs text-ink-faint">{t('rules.requiredNoFields')}</p> : null}
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {requirable.map((field) => (
                      <label key={field.key} className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          checked={required.includes(field.key)}
                          onChange={(e) =>
                            setRequired(e.target.checked ? [...required, field.key] : required.filter((key) => key !== field.key))
                          }
                        />
                        {field.builtin ? t('rules.ownerField') : field.name}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-xs text-ink-faint">{t('rules.fieldsOff')}</p>
            )}
            <label className="block text-sm">
              <span className="mb-1 flex items-center text-ink">
                {t('rules.sectionsLabel')}
                <HelpHint>{t('rules.sectionsHelp')}</HelpHint>
              </span>
              <textarea
                value={sections}
                onChange={(e) => setSections(e.target.value)}
                rows={3}
                placeholder={t('rules.sectionsPlaceholder')}
                className={inputClass}
                data-testid="wiki-category-sections"
              />
            </label>
            {sectionList.length ? (
              <label className="block text-sm">
                <span className="mb-1 block text-ink">{t('rules.sectionRuleLabel')}</span>
                <select value={sectionRule} onChange={(e) => setSectionRule(e.target.value as 'warn' | 'error')} className={inputClass}>
                  <option value="warn">{t('rules.sectionRuleWarn')}</option>
                  <option value="error">{t('rules.sectionRuleError')}</option>
                </select>
              </label>
            ) : null}
            <label className="block text-sm">
              <span className="mb-1 flex items-center text-ink">
                {t('rules.templateLabel')}
                <HelpHint>{t('rules.templateHelp')}</HelpHint>
              </span>
              <textarea
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                rows={4}
                maxLength={5000}
                placeholder={sectionList.map((section) => `## ${section}`).join('\n\n') || t('rules.templatePlaceholder')}
                className={`${inputClass} font-mono text-xs`}
              />
            </label>
            {sectionList.length ? (
              <p className="rounded-lg bg-paper px-3 py-2 text-xs text-ink-soft" data-testid="wiki-category-sections-preview">
                {sectionRule === 'error'
                  ? t('rules.sectionsPreviewError', { count: pages, sections: sectionList.join(', ') })
                  : t('rules.sectionsPreviewWarn', { count: pages, sections: sectionList.join(', ') })}
              </p>
            ) : null}
            {requirable && required.some((key) => !(node.requiredFields ?? []).includes(key)) ? (
              <p className="rounded-lg bg-paper px-3 py-2 text-xs text-ink-soft">{t('rules.requiredPreview', { count: pages })}</p>
            ) : null}
          </fieldset>
          <div className="sm:col-span-2">
            <button type="submit" disabled={pending} className="rounded-lg bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-50">
              {pending ? tw('common.saving') : tw('common.save')}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  )
}

function NewCategoryForm({
  topLevel,
  pending,
  onCancel,
  onSubmit,
}: {
  topLevel: Node[]
  pending: boolean
  onCancel: () => void
  onSubmit: (input: { key: string; name: string; parentId: string | null; description: string | null; approval: Approval }) => void
}) {
  const t = useTranslations('ControlPlane.wiki.categories')
  const tw = useTranslations('ControlPlane.wiki')
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [parentId, setParentId] = useState('')
  const [description, setDescription] = useState('')
  const [approval, setApproval] = useState<Approval>('inherit')
  const effectiveKey = keyTouched ? key : slugifyCategory(name)
  const parentKey = topLevel.find((row) => row.id === parentId)?.key

  return (
    <form
      className="grid gap-3 rounded-lg border border-line/70 p-3 sm:grid-cols-2"
      data-testid="wiki-category-new"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit({ key: effectiveKey, name, parentId: parentId || null, description: description || null, approval })
      }}
    >
      <label className="text-sm">
        <span className="mb-1 block text-ink">{t('nameLabel')}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required className={inputClass} placeholder={t('namePlaceholder')} />
      </label>
      <label className="text-sm">
        <span className="mb-1 flex items-center text-ink">
          {t('keyLabel')}
          <HelpHint>{t('keyHelp')}</HelpHint>
        </span>
        <input
          value={effectiveKey}
          onChange={(e) => {
            setKeyTouched(true)
            setKey(e.target.value.toLowerCase())
          }}
          maxLength={60}
          required
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          className={`${inputClass} font-mono`}
        />
        {effectiveKey ? (
          <span className="mt-1 block text-xs text-ink-faint">{t('keyPreview', { path: parentKey ? `${parentKey}/${effectiveKey}` : effectiveKey })}</span>
        ) : null}
      </label>
      <label className="text-sm">
        <span className="mb-1 flex items-center text-ink">
          {t('parentLabel')}
          <HelpHint>{t('parentHelp')}</HelpHint>
        </span>
        <select value={parentId} onChange={(e) => setParentId(e.target.value)} className={inputClass}>
          <option value="">{t('topLevel')}</option>
          {topLevel.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        <span className="mb-1 flex items-center text-ink">
          {t('approvalLabel')}
          <HelpHint>{t('approvalHelp')}</HelpHint>
        </span>
        <select value={approval} onChange={(e) => setApproval(e.target.value as Approval)} className={inputClass}>
          <option value="inherit">{t('approvalInherit')}</option>
          <option value="always">{t('approvalAlways')}</option>
        </select>
      </label>
      <label className="text-sm sm:col-span-2">
        <span className="mb-1 flex items-center text-ink">
          {t('descriptionLabel')}
          <HelpHint>{t('descriptionHelp')}</HelpHint>
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
          rows={2}
          className={inputClass}
          placeholder={t('descriptionPlaceholder')}
        />
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" disabled={pending || !effectiveKey} className="rounded-lg bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-50">
          {pending ? tw('common.saving') : t('create')}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-ink-soft">
          {tw('common.cancel')}
        </button>
      </div>
    </form>
  )
}

/**
 * #1061 F2: „kapcsolt wiki” — menüpont, amely egy másik tudástárra mutat (pl. Szerződések).
 * Csak annak látszik, aki azt a wikit is látja; oldal nem kerül bele, az index.md-be sem.
 */
function LinkedWikisSection({
  data,
  topLevel,
  pending,
  onCreate,
  onDelete,
}: {
  data: WikiCategoriesData
  topLevel: Node[]
  pending: boolean
  onCreate: (input: { key: string; name: string; parentId: string | null; linkedConnectorId: string }) => void
  onDelete: (categoryId: string) => void
}) {
  const t = useTranslations('ControlPlane.wiki.categories.linked')
  const [target, setTarget] = useState('')
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState('')
  const chosen = data.linkableWikis.find((row) => row.connectorId === target)
  const label = name.trim() || chosen?.name || ''
  return (
    <div className="space-y-2 rounded-lg border border-line/70 p-3" data-testid="wiki-linked-wikis">
      <p className="text-sm font-medium text-ink">{t('title')}</p>
      <p className="text-xs text-ink-soft">{t('intro')}</p>
      {data.linkedWikis.length === 0 ? (
        <p className="text-xs text-ink-faint">{t('empty')}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {data.linkedWikis.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{item.name}</span>
              <span className="text-xs text-ink-faint">
                → {item.targetVisible ? item.targetName : t('hiddenTarget')}
                {item.parentKey ? ` · ${t('under', { parent: item.parentKey })}` : ''}
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() => onDelete(item.id)}
                className="ml-auto rounded-md border border-line px-2 py-0.5 text-xs disabled:opacity-50"
              >
                {t('remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {data.linkableWikis.length === 0 ? (
        <p className="text-xs text-ink-faint">{t('noTargets')}</p>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!target || !label) return
            onCreate({
              key: slugifyCategory(label) || 'linked-wiki',
              name: label,
              parentId: parentId || null,
              linkedConnectorId: target,
            })
            setTarget('')
            setName('')
            setParentId('')
          }}
        >
          <label className="text-xs text-ink-faint">
            {t('target')}
            <select value={target} onChange={(event) => setTarget(event.target.value)} className={inputClass} data-testid="wiki-linked-target">
              <option value="">{t('targetPlaceholder')}</option>
              {data.linkableWikis.map((row) => (
                <option key={row.connectorId} value={row.connectorId}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-ink-faint">
            {t('name')}
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder={chosen?.name ?? ''} className={inputClass} maxLength={120} />
          </label>
          <label className="text-xs text-ink-faint">
            {t('parent')}
            <select value={parentId} onChange={(event) => setParentId(event.target.value)} className={inputClass}>
              <option value="">{t('topLevel')}</option>
              {topLevel.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={pending || !target || !label}
            data-testid="wiki-linked-add"
            className="rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {t('add')}
          </button>
        </form>
      )}
    </div>
  )
}
