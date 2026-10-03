import { notFound } from 'next/navigation'
import { asTranslate } from '@/i18n/translate'
import { getTranslations } from 'next-intl/server'
import { requireTenantRole, TenantAuthError } from '@/auth/tenant-context'
import { adminPolicyView } from '@/domain/client-policy/admin-policy'
import { prisma } from '@/lib/db'
import { Card } from '@/components/ui/shell'
import { ClientPolicyForm } from '@/components/client-policy/client-policy-form'

export const dynamic = 'force-dynamic'

export default async function AiClientPolicyPage() {
  let ctx
  try { ctx = await requireTenantRole('admin') }
  catch (error) { if (error instanceof TenantAuthError) notFound(); throw error }
  const tenantId = ctx.activeTenantId
  const [policies, memberships] = await Promise.all([
    prisma.clientPolicy.findMany({ where: { tenantId, scope: { in: ['tenant', 'user'] } } }),
    prisma.tenantMembership.findMany({ where: { tenantId, status: 'active', user: { status: 'active' } }, include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { user: { name: 'asc' } } }),
  ])
  const tenantPolicy = policies.find(p => p.scope === 'tenant' && p.scopeId === tenantId) ?? null
  const tenantView = adminPolicyView(tenantPolicy)
  const hasUserOverrides = memberships.some(({ user }) => {
    const policy = adminPolicyView(policies.find(p => p.scope === 'user' && p.scopeId === user.id) ?? null)
    return policy && (policy.preset || Object.keys(policy.capabilities).length)
  })
  const t = asTranslate(await getTranslations('ClientPolicy'))
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header><h1 className="font-display text-3xl font-semibold">{t('title')}</h1><p className="mt-2 text-ink-soft">{t('body')}</p></header>
      <Card title={t('tenantTitle')}>
        <ClientPolicyForm key="tenant" scope="tenant" scopeId={tenantId} policy={adminPolicyView(tenantPolicy)} tenantPolicy={adminPolicyView(tenantPolicy)} />
      </Card>
      <section className="space-y-3" aria-labelledby="users-title">
        <h2 id="users-title" className="font-display text-2xl font-semibold">{t('usersTitle')}</h2>
        {!hasUserOverrides ? <p className="rounded-xl border border-line p-4 text-sm text-ink-soft">{t('empty', { preset: t(`presets.${tenantView?.preset ?? 'bound'}`) })}</p> : null}
        {memberships.map(({ user }) => {
          const policy = policies.find(p => p.scope === 'user' && p.scopeId === user.id) ?? null
          return <details key={user.id} className="rounded-xl border border-line bg-card p-4">
            <summary className="cursor-pointer font-semibold">{user.name} <span className="break-all text-sm font-normal text-ink-soft">({user.email})</span></summary>
            <div className="mt-4"><ClientPolicyForm key={`${user.id}-${tenantPolicy?.version ?? 0}`} scope="user" scopeId={user.id} policy={adminPolicyView(policy)} tenantPolicy={adminPolicyView(tenantPolicy)} /></div>
          </details>
        })}
      </section>
    </div>
  )
}
