'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  applyWikiTemplateAction,
  changeKnowledgeBaseVisibilityAction,
  getKnowledgeBaseMembersAction,
  previewKnowledgeBaseVisibilityAction,
  setKnowledgeBaseMemberAction,
  updateWikiSchemaAction,
} from '@/app/actions/knowledge-wiki'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { Card } from '@/components/ui/shell'
import { errorKey } from './knowledge-bases-list'

type Template = 'general' | 'health-journal'

export type WikiSettings = {
  kind: 'catalog' | 'agent' | 'shared' | 'private' | 'members' | 'public'
  template: Template
  schemaMd: string
  schemaCustomized: boolean
  visibility: 'private' | 'shared' | 'members'
  canMakePrivate: boolean
  canMakeShared: boolean
  canMakeMembers: boolean
}

/** #965: láthatóság váltása és a wiki szabályfájlja (WIKI.md) / sablonja. */
export function WikiSettingsPanel({ connectorId, settings }: { connectorId: string; settings: WikiSettings }) {
  const [message, setMessage] = useState<Message>(null)
  return (
    <div className="space-y-4">
      <VisibilityCard connectorId={connectorId} settings={settings} />
      {settings.kind === 'members' ? <MembersCard connectorId={connectorId} /> : null}
      {/* Mentés / sablonváltás után a friss szabályfájllal újraindul a szerkesztő. */}
      <RulesCard key={settings.schemaMd} connectorId={connectorId} settings={settings} message={message} setMessage={setMessage} />
    </div>
  )
}

type Message = { kind: 'ok' | 'error'; text: string } | null

type VisibilityTarget = 'private' | 'shared' | 'members'

type VisibilityPreview = {
  to: VisibilityTarget
  losingAccess: { count: number; sample: string[] }
  restrictedAgents: string[]
  rejectedChangeSets: number
}

const CONSEQUENCES = {
  private: ['private1', 'private2', 'private3'],
  shared: ['shared1', 'shared2', 'shared3'],
  members: ['members1', 'members2', 'members3'],
} as const

function VisibilityCard({ connectorId, settings }: { connectorId: string; settings: WikiSettings }) {
  const t = useTranslations('ControlPlane.wiki.settings')
  const tw = useTranslations('ControlPlane.wiki')
  const router = useRouter()
  const [pending, start] = useTransition()
  const [to, setTo] = useState<VisibilityTarget | null>(null)
  const [preview, setPreview] = useState<VisibilityPreview | null>(null)
  const [understood, setUnderstood] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const targets: VisibilityTarget[] = [
    ...(settings.canMakeMembers ? (['members'] as const) : []),
    ...(settings.canMakePrivate ? (['private'] as const) : []),
    ...(settings.canMakeShared ? (['shared'] as const) : []),
  ]
  const reset = () => {
    setTo(null)
    setPreview(null)
    setUnderstood(false)
    setError(null)
  }
  // NFR-1: a váltás előtt megmutatjuk, ki veszti el a hozzáférést és mely munkatársakat érinti.
  const choose = (target: VisibilityTarget) =>
    start(async () => {
      setTo(target)
      setPreview(null)
      setError(null)
      const res = await previewKnowledgeBaseVisibilityAction({ connectorId, to: target })
      if (!res.success) {
        setError(tw(`errors.${errorKey(res.error)}`))
        return
      }
      setPreview(res.data as VisibilityPreview)
    })

  return (
    <Card title={t('visibilityTitle')}>
      <p className="mb-3 text-sm text-ink-soft" data-testid="wiki-visibility-now">
        {settings.kind === 'private' ? t('nowPrivate') : settings.kind === 'members' ? t('nowMembers') : t(`nowShared.${settings.kind}`)}
      </p>
      {targets.length === 0 ? (
        <p className="text-xs text-ink-faint">{settings.kind === 'private' ? t('makeSharedAdminOnly') : t('notChangeable')}</p>
      ) : to === null ? (
        <div className="flex flex-wrap gap-2">
          {targets.map((target) => (
            <button
              key={target}
              type="button"
              onClick={() => choose(target)}
              data-testid={`wiki-visibility-start-${target}`}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink hover:border-coral/60"
            >
              {t(target === 'private' ? 'makePrivate' : target === 'shared' ? 'makeShared' : 'makeMembers')}
            </button>
          ))}
        </div>
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
              reset()
              router.refresh()
            })
          }}
        >
          <ul className="list-disc space-y-1 pl-5 text-sm text-amber-900">
            {CONSEQUENCES[to].map((key) => (
              <li key={key}>{t(`consequences.${key}`)}</li>
            ))}
          </ul>
          <div className="rounded-md border border-amber-300/60 bg-white/60 p-2 text-sm text-amber-900" data-testid="wiki-visibility-preview">
            {!preview ? (
              <p className="text-xs">{t('preview.loading')}</p>
            ) : (
              <ul className="space-y-1">
                <li>
                  {preview.losingAccess.count === 0
                    ? t('preview.losingNone')
                    : t('preview.losing', { count: preview.losingAccess.count, names: preview.losingAccess.sample.join(', ') })}
                </li>
                {preview.restrictedAgents.length ? (
                  <li>{t('preview.agents', { names: preview.restrictedAgents.join(', ') })}</li>
                ) : null}
                {preview.rejectedChangeSets ? <li>{t('preview.rejected', { count: preview.rejectedChangeSets })}</li> : null}
              </ul>
            )}
          </div>
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
              disabled={pending || !understood || !preview}
              data-testid="wiki-visibility-confirm"
              className="rounded-lg bg-coral px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? tw('common.saving') : t(to === 'private' ? 'confirmPrivate' : to === 'shared' ? 'confirmShared' : 'confirmMembers')}
            </button>
            <button type="button" onClick={reset} className="rounded-lg border border-line px-3 py-1.5 text-sm">
              {tw('common.cancel')}
            </button>
          </div>
        </form>
      )}
    </Card>
  )
}

type MembersView = {
  canEdit: boolean
  isMember: boolean
  members: Array<{ userId: string; label: string | null; owner: boolean }>
  candidates: Array<{ id: string; label: string }>
}

/** #1061 F2: „csak a kijelöltek” névsor — a tulajdonos és az admin szerkeszti. */
function MembersCard({ connectorId }: { connectorId: string }) {
  const t = useTranslations('ControlPlane.wiki.settings.members')
  const tw = useTranslations('ControlPlane.wiki')
  const router = useRouter()
  const [pending, start] = useTransition()
  const [view, setView] = useState<MembersView | null>(null)
  const [pick, setPick] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = () =>
    start(async () => {
      const res = await getKnowledgeBaseMembersAction({ connectorId })
      if (!res.success) {
        setError(tw(`errors.${errorKey(res.error)}`))
        return
      }
      setView(res.data as MembersView)
    })
  useEffect(load, [connectorId]) // eslint-disable-line react-hooks/exhaustive-deps

  const change = (userId: string, member: boolean) =>
    start(async () => {
      setError(null)
      const res = await setKnowledgeBaseMemberAction({ connectorId, userId, member })
      if (!res.success) {
        setError(tw(`errors.${errorKey(res.error)}`))
        return
      }
      setPick('')
      const next = await getKnowledgeBaseMembersAction({ connectorId })
      if (next.success) setView(next.data as MembersView)
      router.refresh()
    })

  return (
    <Card title={t('title')}>
      <p className="mb-3 max-w-2xl text-sm text-ink-soft">{t('intro')}</p>
      {!view ? (
        <p className="text-xs text-ink-faint">{error ?? t('loading')}</p>
      ) : (
        <div className="space-y-3">
          <ul className="space-y-1" data-testid="kb-members">
            {view.members.map((member) => (
              <li key={member.userId} className="flex items-center gap-2 text-sm">
                <span>{member.label ?? t('unknownUser')}</span>
                {member.owner ? <span className="text-xs text-ink-faint">({t('owner')})</span> : null}
                {view.canEdit && !member.owner ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => change(member.userId, false)}
                    className="ml-auto rounded-md border border-line px-2 py-0.5 text-xs disabled:opacity-50"
                  >
                    {t('remove')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {view.canEdit ? (
            view.candidates.length === 0 ? (
              <p className="text-xs text-ink-faint">{t('noCandidates')}</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={pick}
                  onChange={(event) => setPick(event.target.value)}
                  data-testid="kb-members-pick"
                  className="rounded-lg border border-line/70 px-2 py-1.5 text-sm"
                >
                  <option value="">{t('pickPlaceholder')}</option>
                  {view.candidates.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={pending || !pick}
                  data-testid="kb-members-add"
                  onClick={() => change(pick, true)}
                  className="rounded-lg bg-coral px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  {t('add')}
                </button>
              </div>
            )
          ) : (
            <p className="text-xs text-ink-faint">{t('readOnly')}</p>
          )}
          {error ? <p className="text-sm text-coral-deep">{error}</p> : null}
        </div>
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
