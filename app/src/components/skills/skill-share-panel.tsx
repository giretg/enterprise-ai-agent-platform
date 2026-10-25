'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useId, useState, useTransition } from 'react'
import {
  listSkillShareTenantsAction,
  shareSkillAction,
  type SkillCatalogEntry,
  type SkillShareTenant,
} from '@/app/actions/skills'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import { skillDisplayLabel } from '@/lib/skill/skill-name'

/**
 * Superadmin-felület: a skill aktív verziójának megosztása platform-szintre
 * (kiadott skill) vagy egy másik tenantba (a tenant saját skillje). A szerver
 * független másolatot készít, az eredeti skill érintetlen marad.
 */
export function SkillSharePanel({
  skill,
  onDone,
  onError,
}: {
  skill: SkillCatalogEntry
  onDone: (message: string) => void
  onError: (message: string) => void
}) {
  const t = useTranslations('SkillCatalog.share')
  const selectId = useId()
  const [pending, startTransition] = useTransition()
  const [tenants, setTenants] = useState<SkillShareTenant[] | null>(null)
  const [tenantId, setTenantId] = useState('')
  const name = skillDisplayLabel(skill)
  const hasActive = skill.versions.some((v) => v.status === 'active')
  const isGlobal = skill.catalogScope === 'global'

  useEffect(() => {
    let cancelled = false
    void listSkillShareTenantsAction().then((res) => {
      if (cancelled) return
      if (res.success) setTenants(res.data)
      else {
        setTenants([])
        onError(res.error)
      }
    })
    return () => {
      cancelled = true
    }
  }, [onError])

  function share(target: { kind: 'platform' } | { kind: 'tenant'; tenantId: string }) {
    const tenantName = target.kind === 'tenant' ? tenants?.find((x) => x.id === target.tenantId)?.name ?? '' : ''
    startTransition(async () => {
      const confirmed = await confirmDialog(
        target.kind === 'platform'
          ? {
              title: t('confirmPlatformTitle'),
              description: t('confirmPlatformBody', { name }),
              confirmLabel: t('platformAction'),
            }
          : {
              title: t('confirmTenantTitle'),
              description: t('confirmTenantBody', { name, tenant: tenantName }),
              confirmLabel: t('tenantAction'),
            },
      )
      if (!confirmed) return
      const res = await shareSkillAction({ skillId: skill.id, target })
      if (!res.success) {
        onError(res.error)
        return
      }
      onDone(target.kind === 'platform' ? t('donePlatform') : t('doneTenant', { tenant: tenantName }))
    })
  }

  if (!hasActive) {
    return <p className="text-sm text-ink-soft">{t('noActive')}</p>
  }

  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-ink-soft">{t('intro')}</p>

      <section className="atelier-soft space-y-2 p-4">
        <h3 className="font-display text-base font-semibold text-ink">{t('platformTitle')}</h3>
        {isGlobal ? (
          <p className="text-sm text-ink-soft">{t('platformAlready')}</p>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-ink-soft">{t('platformBody')}</p>
            <button
              type="button"
              disabled={pending}
              onClick={() => share({ kind: 'platform' })}
              className="rounded-full border border-coral/35 bg-coral/8 px-3 py-1.5 text-xs font-semibold text-coral hover:bg-coral/15 disabled:opacity-50"
            >
              {t('platformAction')}
            </button>
          </>
        )}
      </section>

      <section className="atelier-soft space-y-2 p-4">
        <h3 className="font-display text-base font-semibold text-ink">{t('tenantTitle')}</h3>
        <p className="text-sm leading-relaxed text-ink-soft">{t('tenantBody')}</p>
        {tenants === null ? (
          <p className="text-xs text-ink-faint">{t('tenantsLoading')}</p>
        ) : tenants.length === 0 ? (
          <p className="text-xs text-ink-faint">{t('noTenants')}</p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <label htmlFor={selectId} className="sr-only">
              {t('tenantSelect')}
            </label>
            <select
              id={selectId}
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              className="min-w-56 rounded-lg border border-line bg-card px-3 py-1.5 text-sm text-ink"
            >
              <option value="">{t('tenantPlaceholder')}</option>
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={pending || !tenantId}
              onClick={() => share({ kind: 'tenant', tenantId })}
              className="rounded-full border border-coral/35 bg-coral/8 px-3 py-1.5 text-xs font-semibold text-coral hover:bg-coral/15 disabled:opacity-50"
            >
              {t('tenantAction')}
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
