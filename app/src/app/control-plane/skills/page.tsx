import { getTranslations } from 'next-intl/server'
import { getAuthContext } from '@/auth/context'
import { hasMinimumRole } from '@/auth/types'
import { Card } from '@/components/ui/shell'
import { listConversationSkillProposalsAction } from '@/app/actions/conversation-skills'
import { listSkillCatalogAction } from '@/app/actions/skills'
import { ConversationSkillProposals } from '@/components/skills/conversation-skill-proposals'
import { SkillCatalogManager } from '@/components/skills/skill-catalog-manager'

async function CatalogLoadError({ error }: { error: string }) {
  const t = await getTranslations('ControlPlane.skills')
  return (
    <div className="space-y-8">
      <div className="animate-rise">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-[2.4rem] font-semibold leading-tight">{t('title')}</h1>
      </div>
      <Card>
        <p className="text-sm text-coral">{error}</p>
        <p className="mt-2 text-sm text-ink-soft">{t('migrateHint')}</p>
      </Card>
    </div>
  )
}

export default async function SkillCatalogPage() {
  let ctx: Awaited<ReturnType<typeof getAuthContext>>
  let res: Awaited<ReturnType<typeof listSkillCatalogAction>>
  try {
    ctx = await getAuthContext()
    res = await listSkillCatalogAction()
  } catch (err) {
    const t = await getTranslations('ControlPlane.skills')
    return (
      <CatalogLoadError
        error={err instanceof Error ? err.message : t('loadFailed')}
      />
    )
  }

  const isAdmin = hasMinimumRole(ctx?.activeTenantRole, 'admin')
  const isPlatformAdmin = Boolean(
    ctx?.platformRoles?.some((r) => r === 'superadmin' || r === 'platform_operator'),
  )
  const canView = hasMinimumRole(ctx?.activeTenantRole, 'operator')
  const t = await getTranslations('ControlPlane.skills')

  if (!canView) {
    return (
      <Card>
        <p className="text-sm text-ink-faint">{t('needOperator')}</p>
      </Card>
    )
  }

  if (!res.success) {
    return <CatalogLoadError error={res.error ?? t('loadFailed')} />
  }

  const proposals = isAdmin ? await listConversationSkillProposalsAction() : null

  return (
    <div className="space-y-8">
      <div className="animate-rise">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-[2.4rem] font-semibold leading-tight">{t('title')}</h1>
        <p className="mt-2 max-w-2xl text-ink-soft">{t('body')}</p>
        <p className="mt-2 max-w-2xl text-sm text-ink-faint">{t('hint')}</p>
      </div>

      {isAdmin && proposals?.success ? (
        <ConversationSkillProposals proposals={proposals.data} />
      ) : null}
      {isAdmin && proposals && !proposals.success ? (
        <Card>
          <p className="text-sm text-coral">{proposals.error}</p>
        </Card>
      ) : null}

      <SkillCatalogManager skills={res.data} isAdmin={isAdmin} isPlatformAdmin={isPlatformAdmin} />
    </div>
  )
}
