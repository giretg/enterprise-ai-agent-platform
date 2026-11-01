'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { executeWikiErasureAction, previewWikiErasureAction } from '@/app/actions/knowledge-wiki'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { Card } from '@/components/ui/shell'
import { errorKey } from './knowledge-bases-list'

type Kind = 'text' | 'pages' | 'revision'
type Mode = 'redact' | 'erase'
type Preview = Extract<Awaited<ReturnType<typeof previewWikiErasureAction>>, { success: true }>['data']

const LOCATIONS = ['page', 'revision', 'changeSet', 'log', 'document', 'sourceFile', 'chunk', 'gatewayOperation'] as const

/**
 * #978 §7 (D9, D10): adatvédelmi törlés. Lépések: mit keresünk → előnézet
 * (helyenként) → mód → indoklás + a wiki nevének begépelése → végrehajtás.
 */
export function WikiErasurePanel({ connectorId, name, isPrivate }: { connectorId: string; name: string; isPrivate: boolean }) {
  const t = useTranslations('ControlPlane.wiki.history.erasure')
  const tw = useTranslations('ControlPlane.wiki')
  const router = useRouter()
  const [kind, setKind] = useState<Kind>('text')
  const [mode, setMode] = useState<Mode>('redact')
  const [phrase, setPhrase] = useState('')
  const [paths, setPaths] = useState('')
  const [revisionPath, setRevisionPath] = useState('')
  const [revisionVersion, setRevisionVersion] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const scope = () =>
    kind === 'text'
      ? { kind, phrase: phrase.trim(), mode }
      : kind === 'pages'
        ? { kind, paths: paths.split(/[\n,]/).map((item) => item.trim()).filter(Boolean) }
        : { kind, path: revisionPath.trim(), version: Number(revisionVersion) }

  const reset = () => {
    setPreview(null)
    setTyped('')
    setError(null)
  }

  return (
    <Card title={t('title')}>
      <p className="mb-1 text-sm text-ink-soft">{isPrivate ? t('introPrivate') : t('intro')}</p>
      <p className="mb-3 text-xs text-ink-faint">{t('exportsNote')}</p>
      {done ? (
        <p className="mb-3 rounded-lg border border-sage/40 bg-sage/10 px-3 py-2 text-sm text-ink" data-testid="wiki-erasure-done">
          {done}
        </p>
      ) : null}
      <form
        className="space-y-3"
        data-testid="wiki-erasure-form"
        onSubmit={(event) => {
          event.preventDefault()
          start(async () => {
            setError(null)
            setDone(null)
            const res = await previewWikiErasureAction({ connectorId, scope: scope() })
            if (!res.success) {
              setError(res.error === 'not_found' ? t('nothingFound') : tw(`errors.${errorKey(res.error)}`))
              setPreview(null)
              return
            }
            setPreview(res.data)
          })
        }}
      >
        <fieldset className="space-y-1 text-sm">
          <legend className="mb-1 font-medium text-ink">{t('step1')}</legend>
          {(['text', 'pages', 'revision'] as const).map((value) => (
            <label key={value} className="flex items-start gap-2">
              <input
                type="radio"
                name="erasure-kind"
                checked={kind === value}
                onChange={() => {
                  setKind(value)
                  reset()
                }}
                className="mt-1"
              />
              <span>
                <span className="text-ink">{t(`kinds.${value}`)}</span>
                <span className="block text-xs text-ink-faint">{t(`kindsHelp.${value}`)}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {kind === 'text' ? (
          <div className="space-y-2">
            <label className="block text-sm">
              <span className="mb-1 block text-ink-soft">{t('phrase')}</span>
              <input
                value={phrase}
                onChange={(event) => {
                  setPhrase(event.target.value)
                  reset()
                }}
                data-testid="wiki-erasure-phrase"
                minLength={3}
                maxLength={200}
                className="w-full rounded-lg border border-line/70 px-3 py-1.5 text-sm"
              />
            </label>
            <fieldset className="text-sm">
              <legend className="mb-1 flex items-center text-ink-soft">
                {t('mode')}
                <HelpHint>{t('modeHelp')}</HelpHint>
              </legend>
              {(['redact', 'erase'] as const).map((value) => (
                <label key={value} className="mr-4 inline-flex items-center gap-1">
                  <input type="radio" name="erasure-mode" checked={mode === value} onChange={() => setMode(value)} />
                  {t(`modes.${value}`)}
                </label>
              ))}
            </fieldset>
          </div>
        ) : kind === 'pages' ? (
          <label className="block text-sm">
            <span className="mb-1 block text-ink-soft">{t('paths')}</span>
            <textarea
              value={paths}
              onChange={(event) => {
                setPaths(event.target.value)
                reset()
              }}
              rows={3}
              placeholder="entities/pelda-janos.md"
              className="w-full rounded-lg border border-line/70 px-3 py-1.5 font-mono text-xs"
            />
          </label>
        ) : (
          <div className="flex flex-wrap gap-2">
            <label className="text-sm">
              <span className="mb-1 block text-ink-soft">{t('revisionPath')}</span>
              <input value={revisionPath} onChange={(event) => { setRevisionPath(event.target.value); reset() }} className="rounded-lg border border-line/70 px-3 py-1.5 font-mono text-xs" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-ink-soft">{t('revisionVersion')}</span>
              <input value={revisionVersion} inputMode="numeric" onChange={(event) => { setRevisionVersion(event.target.value); reset() }} className="w-24 rounded-lg border border-line/70 px-3 py-1.5 text-sm" />
            </label>
            <p className="w-full text-xs text-ink-faint">{t('revisionHelp')}</p>
          </div>
        )}
        <button
          type="submit"
          disabled={pending}
          data-testid="wiki-erasure-preview"
          className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink hover:border-coral/60 disabled:opacity-50"
        >
          {t('previewButton')}
        </button>
      </form>

      {preview ? (
        <div className="mt-4 space-y-3 rounded-lg border border-coral/40 bg-coral/5 p-3" data-testid="wiki-erasure-preview-result">
          <p className="text-sm font-semibold text-coral-deep">{t('previewTitle', { count: preview.total })}</p>
          <ul className="grid gap-1 text-sm sm:grid-cols-2">
            {LOCATIONS.filter((where) => preview.counts[where] > 0).map((where) => (
              <li key={where} className="text-ink">
                {t(`locations.${where}`)}: <span className="font-medium">{preview.counts[where]}</span>
              </li>
            ))}
          </ul>
          {preview.locations.some((row) => row.snippet) ? (
            <ul className="max-h-48 space-y-1 overflow-auto rounded bg-card px-2 py-1 text-xs text-ink-soft">
              {preview.locations
                .filter((row) => row.snippet)
                .slice(0, 30)
                .map((row, index) => (
                  <li key={index}>
                    <span className="font-medium text-ink">{t(`locations.${row.where}`)} · {row.label}</span>: {row.snippet}
                  </li>
                ))}
            </ul>
          ) : null}
          {preview.total > 0 ? (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault()
                start(async () => {
                  setError(null)
                  const res = await executeWikiErasureAction({ connectorId, scope: scope(), reason, confirmName: typed })
                  if (!res.success) {
                    setError(tw(`errors.${errorKey(res.error)}`))
                    return
                  }
                  if (!res.data.ok) {
                    setError(t('conflict'))
                    return
                  }
                  setPreview(null)
                  setReason('')
                  setTyped('')
                  setDone(t('done'))
                  router.refresh()
                })
              }}
            >
              <p className="text-sm font-semibold text-coral-deep">{t('irreversible')}</p>
              <label className="block text-sm">
                <span className="mb-1 block text-xs text-ink-soft">{t('reason')}</span>
                <input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  data-testid="wiki-erasure-reason"
                  placeholder={t('reasonPlaceholder')}
                  maxLength={500}
                  className="w-full rounded-lg border border-line/70 px-3 py-1.5 text-sm"
                />
                <span className="mt-0.5 block text-xs text-ink-faint">{t('reasonHelp')}</span>
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-xs text-ink-soft">{tw('owner.typeName', { name })}</span>
                <input
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  data-testid="wiki-erasure-confirm-name"
                  className="w-full rounded-lg border border-line/70 px-3 py-1.5 text-sm"
                />
              </label>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={pending || reason.trim().length < 3 || typed.trim().toLowerCase() !== name.trim().toLowerCase()}
                  data-testid="wiki-erasure-execute"
                  className="rounded-lg bg-coral-deep px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  {pending ? t('working') : t('execute')}
                </button>
                <button type="button" onClick={reset} className="rounded-lg border border-line px-3 py-1.5 text-sm">
                  {tw('common.cancel')}
                </button>
              </div>
            </form>
          ) : (
            <p className="text-sm text-ink-soft">{t('nothingFound')}</p>
          )}
        </div>
      ) : null}
      {error ? <p className="mt-2 text-sm text-coral-deep">{error}</p> : null}
    </Card>
  )
}
