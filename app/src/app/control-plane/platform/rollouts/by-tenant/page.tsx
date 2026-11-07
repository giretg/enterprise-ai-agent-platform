import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { getRolloutTenantViewAction } from '@/app/actions/feature-flags'
import { Badge } from '@/components/ui/shell'

export default async function PlatformRolloutsByTenantPage({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string | string[] }>
}) {
  const { tenant } = await searchParams
  const [res, t, locale] = await Promise.all([
    getRolloutTenantViewAction(typeof tenant === 'string' && tenant ? tenant : null),
    getTranslations('PlatformRollouts'),
    getLocale(),
  ])
  const lang = locale === 'en' ? 'en' : 'hu'

  return (
    <div className="space-y-6">
      <Link href="/control-plane/platform/rollouts" className="text-sm font-medium text-ink-soft underline-offset-2 hover:underline">
        {t('backToList')}
      </Link>
      <header>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">{t('byTenant.title')}</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">{t('byTenant.body')}</p>
      </header>
      {!res.success ? (
        <div className="rounded-xl border border-rose/30 bg-rose/5 p-4 text-sm text-rose">{t('loadError')}</div>
      ) : (
        <>
          <form method="get" className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm font-medium">
              {t('byTenant.select')}
              <select
                name="tenant"
                defaultValue={res.data.selected?.id ?? ''}
                className="min-w-[16rem] rounded-lg border border-line bg-transparent px-3 py-2 text-sm font-normal"
              >
                <option value="">—</option>
                {res.data.tenants.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.displayName}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="rounded-lg border border-line px-4 py-2 text-sm font-medium hover:bg-ink/5">
              {t('byTenant.show')}
            </button>
          </form>
          {!res.data.selected ? (
            <p className="text-sm text-ink-soft">{t('byTenant.choose')}</p>
          ) : res.data.items.length === 0 ? (
            <div className="atelier-card p-6 text-sm text-ink-soft">{t('empty')}</div>
          ) : (
            <div className="atelier-card overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                    <th className="px-4 py-3 font-medium">{t('byTenant.feature')}</th>
                    <th className="px-4 py-3 font-medium">{t('byTenant.result')}</th>
                    <th className="px-4 py-3 font-medium">{t('byTenant.why')}</th>
                  </tr>
                </thead>
                <tbody>
                  {res.data.items.map((item) => (
                    <tr key={item.key} className="border-b border-line/60 last:border-0">
                      <td className="px-4 py-3">
                        <Link
                          href={`/control-plane/platform/rollouts/flag?key=${encodeURIComponent(item.key)}`}
                          className="font-medium underline-offset-2 hover:underline"
                        >
                          {item.definition.title[lang]}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={item.decision.active ? 'success' : 'neutral'}>
                          {item.decision.active ? t('tenants.active') : t('tenants.inactive')}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-ink-soft">{t(`reason.${item.decision.reason}`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
