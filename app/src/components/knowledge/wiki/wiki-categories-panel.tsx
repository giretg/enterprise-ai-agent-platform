'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  createWikiCategoryAction,
  deleteWikiCategoryAction,
  setWikiCategoriesManagedAction,
  updateWikiCategoryAction,
} from '@/app/actions/knowledge-wiki'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { Card } from '@/components/ui/shell'
import { slugifyCategory } from '@/lib/wiki-categories'

type Approval = 'inherit' | 'always'
type Node = {
  id: string
  key: string
  path: string
  parentId: string | null
  name: string
  description: string | null
  sortOrder: number
  approval: Approval
  protected: boolean
  published: number
  archived: number
  totalPublished?: number
  children: Node[]
}

export type WikiCategoriesData = {
  managed: boolean
  maxCategories: number
  categories: Node[]
  outsideTree: number
  importPreview: Array<{ key: string; name: string; pageCount: number; exists: boolean }>
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
              <ul className="divide-y divide-line/60 rounded-lg border border-line/70" data-testid="wiki-categories-tree">
                {data.categories.map((node) => (
                  <li key={node.id}>
                    <CategoryRow
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
                      <ul className="border-t border-line/40 bg-paper/40">
                        {node.children.map((child) => (
                          <li key={child.id} className="pl-6">
                            <CategoryRow
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
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

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
  node,
  parent,
  topLevel,
  editing,
  onEdit,
  pending,
  onSave,
  onDelete,
}: {
  node: Node
  parent: Node | null
  topLevel: Node[]
  editing: boolean
  onEdit: () => void
  pending: boolean
  onSave: (patch: { name?: string; description?: string | null; parentId?: string | null; sortOrder?: number; approval?: Approval }) => void
  onDelete: () => void
}) {
  const t = useTranslations('ControlPlane.wiki.categories')
  const tw = useTranslations('ControlPlane.wiki')
  const [name, setName] = useState(node.name)
  const [description, setDescription] = useState(node.description ?? '')
  const [parentId, setParentId] = useState(node.parentId ?? '')
  const [sortOrder, setSortOrder] = useState(node.sortOrder)
  const [approval, setApproval] = useState<Approval>(node.approval)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const pages = node.totalPublished ?? node.published
  const empty = node.published + node.archived === 0 && node.children.length === 0
  const inheritedProtection = !!parent && parent.approval === 'always'
  const parentChanged = (parentId || null) !== (node.parentId ?? null)
  const movedPath = parentChanged ? (parentId ? `${topLevel.find((row) => row.id === parentId)?.key}/${node.key}` : node.key) : null

  return (
    <div className="px-3 py-2" data-testid="wiki-category-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink">{node.name}</span>
        <code className="text-xs text-ink-faint">{node.path}</code>
        <span className="text-xs text-ink-soft">{t('pages', { count: pages })}</span>
        {node.archived ? <span className="text-xs text-ink-faint">{t('archivedPages', { count: node.archived })}</span> : null}
        {node.protected ? (
          <span className="rounded-full bg-amber-100 px-2 text-xs text-amber-800">
            {node.approval === 'always' ? t('ruleAlways') : t('ruleInherited')}
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
            onSave({
              ...(name !== node.name ? { name } : {}),
              ...(description !== (node.description ?? '') ? { description: description || null } : {}),
              ...(parentChanged ? { parentId: parentId || null } : {}),
              ...(sortOrder !== node.sortOrder ? { sortOrder } : {}),
              ...(approval !== node.approval ? { approval } : {}),
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
              step={10}
              value={sortOrder}
              onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
              className={inputClass}
            />
          </label>
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
