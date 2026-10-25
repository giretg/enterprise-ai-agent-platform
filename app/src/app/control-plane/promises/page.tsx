import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { requireTenantRole } from '@/auth/tenant-context'
import { listCustomerPromisesAction } from '@/app/actions/customer-promise'
import { parsePromisePage } from '@/lib/customer-promise-page'
import { PromisesPanel } from './promises-panel'

export default async function PromisesPage({ searchParams }: { searchParams: Promise<{ history?: string; promisePage?: string }> }) {
  const query = await searchParams
  const history = query.history === '1'
  const page = parsePromisePage(query.promisePage)
  await requireTenantRole('viewer')
  const [result, t] = await Promise.all([listCustomerPromisesAction(undefined, history, page), getTranslations('ControlPlane.promises')])
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-semibold">{t('title')}</h1>
        <p className="mt-2 max-w-2xl text-ink-soft">{t('body')}</p>
      </div>
      <nav aria-label={t('filterLabel')} className="flex gap-4 text-sm">
        <Link href="/control-plane/promises" aria-current={!history ? 'page' : undefined} className={!history ? 'font-semibold underline' : 'text-ink-soft'}>{t('active')}</Link>
        <Link href="/control-plane/promises?history=1" aria-current={history ? 'page' : undefined} className={history ? 'font-semibold underline' : 'text-ink-soft'}>{t('history')}</Link>
      </nav>
      {result.success ? <PromisesPanel promises={result.data.promises} pagination={{ page, hasMore: result.data.hasMore, pageHref: `/control-plane/promises?history=${history ? 1 : 0}&promisePage=` }} /> : <p role="alert" className="text-red-800">{t('error')}</p>}
    </div>
  )
}
