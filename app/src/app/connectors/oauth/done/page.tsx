import { getTranslations } from 'next-intl/server'
import { LocaleSwitcher } from '@/components/public-site/locale-switcher'

export default async function ConnectorOAuthDonePage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>
}) {
  const params = await searchParams
  const error = params.error?.trim()
  const failed = Boolean(error)
  const t = await getTranslations('OauthDone')

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
      <div className="mb-8">
        <LocaleSwitcher />
      </div>
      <h1 className="font-display text-3xl text-ink">{failed ? t('failTitle') : t('okTitle')}</h1>
      <p className="mt-3 text-base text-ink-soft">{failed ? t('failBody') : t('okBody')}</p>
      {failed && error ? (
        <p className="mt-6 font-mono text-sm text-ink-faint">{error}</p>
      ) : null}
    </main>
  )
}
