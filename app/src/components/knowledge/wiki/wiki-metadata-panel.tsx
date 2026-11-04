'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  createWikiFieldAction,
  deleteWikiFieldAction,
  setWikiMetadataManagedAction,
  updateWikiFieldAction,
} from '@/app/actions/knowledge-wiki'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { Card } from '@/components/ui/shell'

type FieldType = 'text' | 'select' | 'multi_select' | 'date'
type Field = { id: string; key: string; name: string; type: FieldType; options: string[]; help: string | null; sortOrder: number }

export type WikiMetadataData = {
  managed: boolean
  maxFields: number
  fields: Field[]
  importPreview: {
    pages: number
    docStatus: number
    owner: number
    ownerUnmatched: number
    reviewedAt: number
    samples: Array<{ path: string; title: string; docStatus: 'draft' | 'approved' | null; owner: string | null; reviewedAt: string | null }>
  } | null
}

const METADATA_ERRORS = ['not_found', 'forbidden', 'invalid_args', 'key_taken', 'invalid_key', 'too_many', 'conflict'] as const

function errorKey(code: string): (typeof METADATA_ERRORS)[number] | 'generic' {
  return (METADATA_ERRORS as readonly string[]).includes(code) ? (code as (typeof METADATA_ERRORS)[number]) : 'generic'
}

const inputClass = 'w-full rounded-lg border border-line/70 px-3 py-1.5 text-sm'
const FIELD_TYPES: FieldType[] = ['text', 'select', 'multi_select', 'date']

/** „Ország” → `orszag` (az agent ezzel a kulccsal írja a frontmatterbe). */
function keyFromName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 40)
}

function splitOptions(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
}

/**
 * #1061 F3: „Metaadat-mezők” — állapot, gazda, átnézés (beépített) és wikinként
 * egyedi mezők. Bekapcsolás előtt megmutatja, mi lesz a régi frontmatter-értékekből (NFR-1).
 */
export function WikiMetadataPanel({ connectorId, data }: { connectorId: string; data: WikiMetadataData }) {
  const t = useTranslations('ControlPlane.wiki.metadata')
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
        setMessage({ kind: 'error', text: t(`errors.${errorKey(res.error ?? '')}`) })
        return
      }
      setMessage({ kind: 'ok', text: okText })
      after?.()
      router.refresh()
    })

  const preview = data.importPreview
  return (
    <Card title={t('title')}>
      <div className="space-y-4" data-testid="wiki-metadata">
        <div className="rounded-lg border border-line/70 bg-paper/60 px-3 py-2 text-sm text-ink-soft">
          <p>{t('intro')}</p>
          <p className="mt-1">{t('introBuiltins')}</p>
        </div>

        {!data.managed ? (
          <div className="space-y-3">
            <p className="text-sm font-medium text-ink" data-testid="wiki-metadata-off">{t('off')}</p>
            {confirmToggle ? (
              <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm" data-testid="wiki-metadata-preview">
                {!preview || preview.pages === 0 ? (
                  <p>{t('previewNone')}</p>
                ) : (
                  <>
                    <p>{t('previewTitle', { count: preview.pages })}</p>
                    <ul className="list-disc space-y-0.5 pl-5">
                      {preview.docStatus ? <li>{t('previewStatus', { count: preview.docStatus })}</li> : null}
                      {preview.owner ? <li>{t('previewOwner', { count: preview.owner })}</li> : null}
                      {preview.reviewedAt ? <li>{t('previewReviewed', { count: preview.reviewedAt })}</li> : null}
                    </ul>
                    {preview.samples.length ? (
                      <ul className="space-y-0.5 text-xs text-ink-soft">
                        {preview.samples.map((row) => (
                          <li key={row.path}>
                            <span className="font-medium text-ink">{row.title}</span>
                            {row.docStatus ? ` · ${t(`status.${row.docStatus}`)}` : ''}
                            {row.owner ? ` · ${row.owner}` : ''}
                            {row.reviewedAt ? ` · ${t('reviewedOn', { date: row.reviewedAt.slice(0, 10) })}` : ''}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                )}
                {preview?.ownerUnmatched ? <p className="text-xs">{t('previewUnmatched', { count: preview.ownerUnmatched })}</p> : null}
                <p>{t('previewAfter')}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    data-testid="wiki-metadata-enable-confirm"
                    onClick={() =>
                      run(() => setWikiMetadataManagedAction({ connectorId, managed: true }), t('enabled'), () => setConfirmToggle(false))
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
                data-testid="wiki-metadata-enable"
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
              <p className="text-sm font-medium text-ink" data-testid="wiki-metadata-on">{t('on')}</p>
              {confirmToggle ? (
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-ink-soft">{t('disableWarning')}</span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      run(() => setWikiMetadataManagedAction({ connectorId, managed: false }), t('disabled'), () => setConfirmToggle(false))
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
            <p className="text-xs text-ink-faint">{t('rulesHint')}</p>

            <div>
              <p className="mb-1 flex items-center text-sm font-medium text-ink">
                {t('fieldsTitle')}
                <HelpHint>{t('fieldsHelp')}</HelpHint>
              </p>
              {data.fields.length === 0 ? (
                <p className="text-sm text-ink-soft" data-testid="wiki-fields-empty">{t('fieldsEmpty')}</p>
              ) : (
                <ul className="divide-y divide-line/60 rounded-lg border border-line/70" data-testid="wiki-fields">
                  {data.fields.map((field) => (
                    <li key={field.id}>
                      <FieldRow
                        field={field}
                        editing={editing === field.id}
                        pending={pending}
                        onEdit={() => setEditing(editing === field.id ? null : field.id)}
                        onSave={(patch) =>
                          run(() => updateWikiFieldAction({ connectorId, fieldId: field.id, ...patch }), t('saved'), () => setEditing(null))
                        }
                        onDelete={() => run(() => deleteWikiFieldAction({ connectorId, fieldId: field.id }), t('deleted'))}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {adding ? (
              <NewFieldForm
                pending={pending}
                onCancel={() => setAdding(false)}
                onSubmit={(input) => run(() => createWikiFieldAction({ connectorId, ...input }), t('created'), () => setAdding(false))}
              />
            ) : (
              <button
                type="button"
                disabled={data.fields.length >= data.maxFields}
                data-testid="wiki-field-add"
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

function FieldRow({
  field,
  editing,
  pending,
  onEdit,
  onSave,
  onDelete,
}: {
  field: Field
  editing: boolean
  pending: boolean
  onEdit: () => void
  onSave: (patch: { name?: string; options?: string[]; help?: string | null }) => void
  onDelete: () => void
}) {
  const t = useTranslations('ControlPlane.wiki.metadata')
  const tw = useTranslations('ControlPlane.wiki')
  const [name, setName] = useState(field.name)
  const [options, setOptions] = useState(field.options.join('\n'))
  const [help, setHelp] = useState(field.help ?? '')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const choice = field.type === 'select' || field.type === 'multi_select'
  const removed = field.options.filter((option) => !splitOptions(options).includes(option))

  return (
    <div className="px-3 py-2" data-testid="wiki-field-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink">{field.name}</span>
        <code className="text-xs text-ink-faint">{field.key}</code>
        <span className="rounded-full bg-ink/5 px-2 text-xs text-ink-soft">{t(`types.${field.type}`)}</span>
        {choice ? <span className="truncate text-xs text-ink-soft">{field.options.join(', ')}</span> : null}
        <span className="ml-auto flex gap-2 text-xs">
          <button type="button" onClick={onEdit} className="text-coral-deep hover:underline">
            {editing ? tw('common.close') : t('edit')}
          </button>
          {confirmDelete ? (
            <span className="flex flex-wrap gap-2">
              <span className="text-ink-soft">{t('deleteWarning')}</span>
              <button type="button" disabled={pending} onClick={onDelete} className="text-coral-deep">
                {t('deleteConfirm')}
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="text-ink-soft">
                {tw('common.cancel')}
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className="text-ink-soft hover:text-coral-deep">
              {t('delete')}
            </button>
          )}
        </span>
      </div>
      {field.help ? <p className="mt-0.5 text-xs text-ink-soft">{field.help}</p> : null}
      {editing ? (
        <form
          className="mt-3 grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault()
            onSave({
              ...(name !== field.name ? { name } : {}),
              ...(choice && options !== field.options.join('\n') ? { options: splitOptions(options) } : {}),
              ...(help !== (field.help ?? '') ? { help: help || null } : {}),
            })
          }}
        >
          <label className="text-sm">
            <span className="mb-1 block text-ink">{t('nameLabel')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required className={inputClass} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-ink">{t('helpLabel')}</span>
            <input value={help} onChange={(e) => setHelp(e.target.value)} maxLength={300} className={inputClass} />
          </label>
          {choice ? (
            <label className="text-sm sm:col-span-2">
              <span className="mb-1 flex items-center text-ink">
                {t('optionsLabel')}
                <HelpHint>{t('optionsHelp')}</HelpHint>
              </span>
              <textarea value={options} onChange={(e) => setOptions(e.target.value)} rows={4} className={inputClass} />
            </label>
          ) : null}
          {removed.length ? (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 sm:col-span-2">
              {t('optionsRemovedPreview', { values: removed.join(', ') })}
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

function NewFieldForm({
  pending,
  onCancel,
  onSubmit,
}: {
  pending: boolean
  onCancel: () => void
  onSubmit: (input: { key: string; name: string; type: FieldType; options?: string[]; help?: string | null }) => void
}) {
  const t = useTranslations('ControlPlane.wiki.metadata')
  const tw = useTranslations('ControlPlane.wiki')
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [type, setType] = useState<FieldType>('select')
  const [options, setOptions] = useState('')
  const [help, setHelp] = useState('')
  const choice = type === 'select' || type === 'multi_select'
  const effectiveKey = keyTouched ? key : keyFromName(name)

  return (
    <form
      className="grid gap-3 rounded-lg border border-line/70 px-3 py-3 sm:grid-cols-2"
      data-testid="wiki-field-new"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit({ key: effectiveKey, name, type, ...(choice ? { options: splitOptions(options) } : {}), help: help || null })
      }}
    >
      <label className="text-sm">
        <span className="mb-1 block text-ink">{t('nameLabel')}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required placeholder={t('namePlaceholder')} className={inputClass} />
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
            setKey(e.target.value)
          }}
          maxLength={40}
          required
          pattern="[a-z][a-z0-9_]*"
          className={`${inputClass} font-mono`}
        />
      </label>
      <label className="text-sm">
        <span className="mb-1 flex items-center text-ink">
          {t('typeLabel')}
          <HelpHint>{t('typeHelp')}</HelpHint>
        </span>
        <select value={type} onChange={(e) => setType(e.target.value as FieldType)} className={inputClass}>
          {FIELD_TYPES.map((value) => (
            <option key={value} value={value}>
              {t(`types.${value}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-ink">{t('helpLabel')}</span>
        <input value={help} onChange={(e) => setHelp(e.target.value)} maxLength={300} placeholder={t('helpPlaceholder')} className={inputClass} />
      </label>
      {choice ? (
        <label className="text-sm sm:col-span-2">
          <span className="mb-1 flex items-center text-ink">
            {t('optionsLabel')}
            <HelpHint>{t('optionsHelp')}</HelpHint>
          </span>
          <textarea value={options} onChange={(e) => setOptions(e.target.value)} rows={4} required placeholder={t('optionsPlaceholder')} className={inputClass} />
        </label>
      ) : null}
      <p className="text-xs text-ink-soft sm:col-span-2">{t('newPreview', { key: effectiveKey || '…' })}</p>
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
