import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { getWikiOverviewAction } from '@/app/actions/knowledge-wiki'
import { ChangeSetView } from '@/components/knowledge/wiki/wiki-history-views'
import { wikiHref } from '@/components/knowledge/wiki/wiki-format'

export const dynamic = 'force-dynamic'

/** #978 §5.1: egy alkalmazott módosítás (change-set) olvasó nézete, innen indítható a visszavonás. */
export default async function WikiChangeSetPage({ params }: { params: Promise<{ connectorId: string; seq: string }> }) {
  const { connectorId, seq } = await params
  if (!/^\d+$/.test(seq)) notFound()
  const t = await getTranslations('ControlPlane.wiki')
  const locale = await getLocale()
  const overview = await getWikiOverviewAction({ connectorId })
  if (!overview.success) notFound()
  return (
    <div className="space-y-6">
      <Link href={wikiHref(connectorId, { tab: 'changes' })} className="inline-flex items-center gap-1 text-sm font-medium text-ink-soft hover:text-ink">
        {t('history.changeSet.back', { name: overview.data.name })}
      </Link>
      <ChangeSetView connectorId={connectorId} seq={seq} locale={locale} />
    </div>
  )
}
