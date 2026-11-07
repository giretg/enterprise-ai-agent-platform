import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { listRolloutsAction } from '@/app/actions/feature-flags'
import { RolloutStateBadge } from '@/components/feature-flags/rollout-state-badge'
import { formatCalendarDate } from '@/i18n/format'

export default async function PlatformRolloutsPage() {
  const [res, t, locale] = await Promise.all([listRolloutsAction(), getTranslations('PlatformRollouts'), getLocale()])
  const lang = locale === 'en' ? 'en' : 'hu'

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">{t('title')}</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">{t('body')}</p>
      </header>
      {!res.success ? (
        <div className="rounded-xl border border-rose/30 bg-rose/5 p-4 text-sm text-rose">{t('loadError')}</div>
      ) : res.data.length === 0 ? (
        <div className="atelier-card p-6 text-sm text-ink-soft">{t('empty')}</div>
      ) : (
        <>
          <div className="atelier-card overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                  <th className="px-4 py-3 font-medium">{t('columns.name')}</th>
                  <th className="px-4 py-3 font-medium">{t('columns.state')}</th>
                  <th className="px-4 py-3 font-medium">{t('columns.owner')}</th>
                  <th className="px-4 py-3 font-medium">{t('columns.issue')}</th>
                  <th className="px-4 py-3 font-medium">{t('columns.deadline')}</th>
                </tr>
              </thead>
              <tbody>
                {res.data.map((flag) => (
                  <tr key={flag.key} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-3">
                      {/* A kulcs pontot tartalmaz, ezért query paraméterben megy, nem útvonal-szakaszban. */}
                      <Link
                        href={`/control-plane/platform/rollouts/flag?key=${encodeURIComponent(flag.key)}`}
                        className="font-medium text-ink underline-offset-2 hover:underline"
                      >
                        {flag.definition.title[lang]}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <RolloutStateBadge mode={flag.mode} includedCount={flag.includedCount} excludedCount={flag.excludedCount} />
                    </td>
                    <td className="px-4 py-3 text-ink-soft">{flag.definition.owner}</td>
                    <td className="px-4 py-3 text-ink-soft">
                      <a
                        href={`https://github.com/giretg/enterprise-ai-agent-platform/issues/${flag.definition.issue}`}
                        target="_blank"
                        rel="noreferrer"
                        className="underline-offset-2 hover:underline"
                      >
                        #{flag.definition.issue}
                      </a>
                    </td>
                    <td className={`px-4 py-3 ${flag.deadline.expired ? 'font-semibold text-rose' : 'text-ink-soft'}`}>
                      {t(`deadline.${flag.deadline.kind}`, { date: formatCalendarDate(flag.deadline.date, locale) })}
                      {flag.deadline.expired ? ` (${t('deadline.expired')})` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Link href="/control-plane/platform/rollouts/by-tenant" className="inline-block text-sm font-medium text-ink underline-offset-2 hover:underline">
            {t('byTenantLink')}
          </Link>
        </>
      )}
    </div>
  )
}
