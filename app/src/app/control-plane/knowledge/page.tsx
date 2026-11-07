import { getTranslations } from 'next-intl/server'
import { getAuthContext } from '@/auth/context'
import { hasMinimumRole } from '@/auth/types'
import { Card } from '@/components/ui/shell'
import { ensureKnowledgeCatalogAction, listKnowledgeBasesAction } from '@/app/actions/knowledge-wiki'
import { KnowledgeBasesList } from '@/components/knowledge/wiki/knowledge-bases-list'

export const dynamic = 'force-dynamic'

export default async function KnowledgeCatalogPage() {
  const ctx = await getAuthContext()
  const t = await getTranslations('ControlPlane.knowledge')
  const canView = hasMinimumRole(ctx?.activeTenantRole, 'operator')
  const canManage = hasMinimumRole(ctx?.activeTenantRole, 'admin')
  // #1139: a közös tudásbázis lazán jön létre, de a feltöltője már a saját Fájlok fülén van.
  if (canManage) await ensureKnowledgeCatalogAction()
  // #946: a tudásbázis-lista (benne a saját privát tudásbázisok) mindenkinek látszik.
  const bases = await listKnowledgeBasesAction()
  const basesCard = bases.success ? <KnowledgeBasesList rows={bases.data} canCreateShared={canManage} /> : null
  if (!canView) {
    return (
      <div className="space-y-6">
        {basesCard}
        <Card>
          <p className="text-sm text-ink-faint">{t('needOperator')}</p>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div className="animate-rise">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-[2.4rem] font-semibold leading-tight">{t('title')}</h1>
        <p className="mt-2 max-w-2xl text-ink-soft">{t('body')}</p>
      </div>

      {basesCard ?? (
        <Card>
          <p className="text-sm text-coral">{t('loadFailed')}</p>
        </Card>
      )}
    </div>
  )
}
