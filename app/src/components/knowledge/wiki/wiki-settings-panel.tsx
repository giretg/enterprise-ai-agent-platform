'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  applyWikiTemplateAction,
  changeKnowledgeBaseVisibilityAction,
  updateWikiSchemaAction,
} from '@/app/actions/knowledge-wiki'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { Card } from '@/components/ui/shell'
import { errorKey } from './knowledge-bases-list'

type Template = 'general' | 'health-journal'

export type WikiSettings = {
  kind: 'catalog' | 'agent' | 'shared' | 'private'
  template: Template
  schemaMd: string
  schemaCustomized: boolean
  visibility: 'private' | 'shared'
  canMakePrivate: boolean
  canMakeShared: boolean
}

/** #965: láthatóság váltása és a wiki szabályfájlja (WIKI.md) / sablonja. */
export function WikiSettingsPanel({ connectorId, settings }: { connectorId: string; settings: WikiSettings }) {
  const [message, setMessage] = useState<Message>(null)
  return (
    <div className="space-y-4">
      <VisibilityCard connectorId={connectorId} settings={settings} />
      {/* Mentés / sablonváltás után a friss szabályfájllal újraindul a szerkesztő. */}
      <RulesCard key={settings.schemaMd} connectorId={connectorId} settings={settings} message={message} setMessage={setMessage} />
    </div>
  )
}

type Message = { kind: 'ok' | 'error'; text: string } | null

function VisibilityCard({ connectorId, settings }: { connectorId: string; settings: WikiSettings }) {
  const t = useTranslations('ControlPlane.wiki.settings')
  const tw = useTranslations('ControlPlane.wiki')
  const router = useRouter()
  const [pending, start] = useTransition()
  const [confirming, setConfirming] = useState(false)
  const [understood, setUnderstood] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const to = settings.canMakePrivate ? 'private' : settings.canMakeShared ? 'shared' : null

  return (
    <Card title={t('visibilityTitle')}>
      <p className="mb-3 text-sm text-ink-soft" data-testid="wiki-visibility-now">
        {settings.kind === 'private' ? t('nowPrivate') : t(`nowShared.${settings.kind}`)}
      </p>
      {to === null ? (
        <p className="text-xs text-ink-faint">{settings.kind === 'private' ? t('makeSharedAdminOnly') : t('notChangeable')}</p>
      ) : !confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          data-testid="wiki-visibility-start"
          className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink hover:border-coral/60"
        >
          {to === 'private' ? t('makePrivate') : t('makeShared')}
        </button>
      ) : (
        <form
          className="space-y-3 rounded-lg border border-amber-300/60 bg-amber-50 p-3"
          onSubmit={(event) => {
            event.preventDefault()
            start(async () => {
              setError(null)
              const res = await changeKnowledgeBaseVisibilityAction({ connectorId, to })
              if (!res.success) {
                setError(tw(`errors.${errorKey(res.error)}`))
                return
              }
              setConfirming(false)
              setUnderstood(false)
              router.refresh()
            })
          }}
        >
          <ul className="list-disc space-y-1 pl-5 text-sm text-amber-900">
            {(to === 'private' ? (['private1', 'private2', 'private3'] as const) : (['shared1', 'shared2', 'shared3'] as const)).map((key) => (
              <li key={key}>{t(`consequences.${key}`)}</li>
            ))}
          </ul>
          <label className="flex items-start gap-2 text-sm text-amber-900">
            <input
              type="checkbox"
              checked={understood}
              onChange={(event) => setUnderstood(event.target.checked)}
              data-testid="wiki-visibility-understood"
            />
            <span>{t('understood')}</span>
          </label>
          {error ? <p className="text-sm text-coral-deep">{error}</p> : null}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={pending || !understood}
              data-testid="wiki-visibility-confirm"
              className="rounded-lg bg-coral px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? tw('common.saving') : to === 'private' ? t('confirmPrivate') : t('confirmShared')}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false)
                setUnderstood(false)
              }}
              className="rounded-lg border border-line px-3 py-1.5 text-sm"
            >
              {tw('common.cancel')}
            </button>
          </div>
        </form>
      )}
    </Card>
  )
}

function RulesCard({
  connectorId,
  settings,
  message,
  setMessage,
}: {
  connectorId: string
  settings: WikiSettings
  message: Message
  setMessage: (message: Message) => void
}) {
  const t = useTranslations('ControlPlane.wiki.settings')
  const tw = useTranslations('ControlPlane.wiki')
  const router = useRouter()
  const [pending, start] = useTransition()
  const [template, setTemplate] = useState<Template>(settings.template)
  const [schema, setSchema] = useState(settings.schemaMd)
  const dirty = schema.trim() !== settings.schemaMd.trim()

  const run = (action: () => Promise<{ success: boolean; error?: string }>, okText: string) =>
    start(async () => {
      setMessage(null)
      const res = await action()
      if (!res.success) {
        setMessage({ kind: 'error', text: tw(`errors.${errorKey(res.error ?? '')}`) })
        return
      }
      setMessage({ kind: 'ok', text: okText })
      router.refresh()
    })

  return (
    <Card>
      <div className="mb-2 flex items-center">
        <h2 className="font-display text-lg font-semibold">{t('rulesTitle')}</h2>
        <HelpHint>{t('rulesHelp')}</HelpHint>
      </div>
      <p className="mb-4 max-w-2xl text-sm text-ink-soft">{t('rulesIntro')}</p>

      <fieldset className="mb-4 space-y-1">
        <legend className="mb-1 text-xs text-ink-faint">{t('templateLabel')}</legend>
        {(['general', 'health-journal'] as const).map((id) => (
          <label key={id} className="flex gap-2 text-sm">
            <input type="radio" name="wiki-template" checked={template === id} onChange={() => setTemplate(id)} />
            <span>
              <span className="font-medium">{tw(`templates.${id}.name`)}</span>
              {id === settings.template ? <span className="ml-1 text-xs text-ink-faint">({t('current')})</span> : null}
              <span className="block text-xs text-ink-faint">{tw(`templates.${id}.description`)}</span>
            </span>
          </label>
        ))}
        {template !== settings.template || settings.schemaCustomized ? (
          <div className="mt-2 space-y-2">
            <p className="text-xs text-amber-900">{t('applyWarning')}</p>
            <button
              type="button"
              disabled={pending}
              data-testid="wiki-template-apply"
              onClick={() =>
                run(() => applyWikiTemplateAction({ connectorId, template }), t('templateApplied'))
              }
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              {template === settings.template ? t('resetToTemplate') : t('applyTemplate')}
            </button>
          </div>
        ) : null}
      </fieldset>

      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault()
          run(() => updateWikiSchemaAction({ connectorId, schemaMd: schema }), t('rulesSaved'))
        }}
      >
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-ink-faint">
            {t('editorLabel')}
            {settings.schemaCustomized ? ` · ${t('customized')}` : ''}
          </span>
          <textarea
            value={schema}
            onChange={(event) => setSchema(event.target.value)}
            rows={16}
            maxLength={20_000}
            data-testid="wiki-schema-editor"
            className="w-full rounded-lg border border-line/70 px-3 py-2 font-mono text-xs"
          />
        </label>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending || !dirty || !schema.trim()}
            data-testid="wiki-schema-save"
            className="rounded-lg bg-coral px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? tw('common.saving') : tw('common.save')}
          </button>
          {message ? (
            <span className={`text-xs ${message.kind === 'ok' ? 'text-sage' : 'text-coral-deep'}`}>{message.text}</span>
          ) : null}
        </div>
      </form>
    </Card>
  )
}
