import { getTranslations } from 'next-intl/server'
import { getAuthContext } from '@/auth/context'
import { hasMinimumRole } from '@/auth/types'
import { Card } from '@/components/ui/shell'
import { listKnowledgeCatalog } from '@/app/actions/platform'
import { KnowledgeCatalogManager } from '@/components/knowledge/knowledge-catalog-manager'

export const dynamic = 'force-dynamic'

export default async function KnowledgeCatalogPage() {
  const ctx = await getAuthContext()
  const t = await getTranslations('ControlPlane.knowledge')
  const canView = hasMinimumRole(ctx?.activeTenantRole, 'operator')
  if (!canView) {
    return (
      <Card>
        <p className="text-sm text-ink-faint">{t('needOperator')}</p>
      </Card>
    )
  }
  const res = await listKnowledgeCatalog()
  const canManage = hasMinimumRole(ctx?.activeTenantRole, 'admin')

  return (
    <div className="space-y-8">
      <div className="animate-rise">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-[2.4rem] font-semibold leading-tight">{t('title')}</h1>
        <p className="mt-2 max-w-2xl text-ink-soft">{t('body')}</p>
      </div>

      {!res.success ? (
        <Card>
          <p className="text-sm text-coral">{res.error ?? t('loadFailed')}</p>
        </Card>
      ) : (
        <KnowledgeCatalogManager documents={res.data} canManage={canManage} />
      )}
    </div>
  )
}
