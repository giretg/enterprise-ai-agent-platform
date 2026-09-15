import { getAuthContext } from '@/auth/context'
import { hasMinimumRole } from '@/auth/types'
import { Card } from '@/components/ui/shell'
import { listSkillCatalogAction } from '@/app/actions/skills'
import { SkillCatalogManager } from '@/components/skills/skill-catalog-manager'

function CatalogLoadError({ error }: { error: string }) {
  return (
    <div className="space-y-8">
      <div className="animate-rise">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">
          Jóváhagyott munkamenetek
        </p>
        <h1 className="mt-2 font-display text-[2.4rem] font-semibold leading-tight">
          Képességek (skill-ek)
        </h1>
      </div>
      <Card>
        <p className="text-sm text-coral">{error}</p>
        <p className="mt-2 text-sm text-ink-soft">
          Ha friss kódot húztál, futtasd a migrációt (<code>npx prisma migrate deploy</code>),
          majd indítsd újra a dev szervert.
        </p>
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
    return (
      <CatalogLoadError
        error={err instanceof Error ? err.message : 'A képességek betöltése sikertelen.'}
      />
    )
  }

  const isAdmin = hasMinimumRole(ctx?.activeTenantRole, 'admin')
  const isPlatformAdmin = Boolean(
    ctx?.platformRoles?.some((r) => r === 'superadmin' || r === 'platform_operator'),
  )
  const canView = hasMinimumRole(ctx?.activeTenantRole, 'operator')

  if (!canView) {
    return (
      <Card>
        <p className="text-sm text-ink-faint">
          A képességek megtekintéséhez legalább operátor jogosultság szükséges.
        </p>
      </Card>
    )
  }

  if (!res.success) {
    return <CatalogLoadError error={res.error ?? 'A képességek betöltése sikertelen.'} />
  }

  return (
    <div className="space-y-8">
      <div className="animate-rise">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">
          Jóváhagyott munkamenetek
        </p>
        <h1 className="mt-2 font-display text-[2.4rem] font-semibold leading-tight">
          Képességek (skill-ek)
        </h1>
        <p className="mt-2 max-w-2xl text-ink-soft">
          A képesség (skill) egy leírt munkamenet: elmondja az AI-munkatársnak, hogyan
          csináljon meg egy visszatérő feladatot. Önmagában tehetetlen — hogy mit tud{' '}
          <em>megtenni</em>, azt az agentnek adott jogosultságok döntik el.
        </p>
        <p className="mt-2 max-w-2xl text-sm text-ink-faint">
          Minden módosítás előbb javaslat (<em>proposed</em>), és csak jóváhagyás után lesz
          éles (<em>active</em>) — a korábbi verzióra bármikor visszaállhatsz.
        </p>
      </div>

      <SkillCatalogManager skills={res.data} isAdmin={isAdmin} isPlatformAdmin={isPlatformAdmin} />
    </div>
  )
}
