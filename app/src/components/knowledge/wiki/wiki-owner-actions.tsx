'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { purgePrivateKnowledgeBaseAction } from '@/app/actions/knowledge-wiki'
import { Card } from '@/components/ui/shell'
import { errorKey } from './knowledge-bases-list'

/** Letöltés (ZIP) és — privát tudásbázisnál — végleges törlés kétlépcsős megerősítéssel. */
export function WikiOwnerActions({
  connectorId,
  name,
  isPrivate,
}: {
  connectorId: string
  name: string
  isPrivate: boolean
}) {
  const t = useTranslations('ControlPlane.wiki')
  const router = useRouter()
  const [pending, start] = useTransition()
  const [step, setStep] = useState<0 | 1>(0)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="space-y-4">
      <Card title={t('owner.downloadTitle')}>
        <p className="mb-3 text-sm text-ink-soft">{t('owner.downloadBody')}</p>
        <a
          href={`/api/control-plane/knowledge/${connectorId}/export`}
          data-testid="wiki-download-zip"
          className="inline-flex rounded-lg bg-coral px-3 py-1.5 text-sm font-medium text-white"
        >
          {t('owner.download')}
        </a>
      </Card>

      {isPrivate ? (
        <Card title={t('owner.deleteTitle')}>
          <p className="mb-3 text-sm text-ink-soft">{t('owner.deleteBody')}</p>
          {step === 0 ? (
            <button
              type="button"
              data-testid="wiki-delete-start"
              onClick={() => setStep(1)}
              className="rounded-lg border border-coral/60 px-3 py-1.5 text-sm font-medium text-coral-deep"
            >
              {t('owner.deleteStart')}
            </button>
          ) : (
            <form
              className="space-y-3 rounded-lg border border-coral/40 bg-coral/5 p-3"
              onSubmit={(event) => {
                event.preventDefault()
                start(async () => {
                  setError(null)
                  const res = await purgePrivateKnowledgeBaseAction({ connectorId })
                  if (!res.success) {
                    setError(t(`errors.${errorKey(res.error)}`))
                    return
                  }
                  router.push('/control-plane/knowledge')
                })
              }}
            >
              <p className="text-sm font-semibold text-coral-deep">{t('owner.irreversible')}</p>
              <label className="block text-sm">
                <span className="mb-1 block text-xs text-ink-soft">{t('owner.typeName', { name })}</span>
                <input
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  data-testid="wiki-delete-confirm-name"
                  className="w-full rounded-lg border border-line/70 px-3 py-1.5 text-sm"
                />
              </label>
              {error ? <p className="text-sm text-coral-deep">{error}</p> : null}
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={pending || typed.trim() !== name.trim()}
                  data-testid="wiki-delete-confirm"
                  className="rounded-lg bg-coral-deep px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  {pending ? t('owner.deleting') : t('owner.deleteConfirm')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setStep(0)
                    setTyped('')
                  }}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </form>
          )}
        </Card>
      ) : null}
    </div>
  )
}
