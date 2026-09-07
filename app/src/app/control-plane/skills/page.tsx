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
          Governance alá vont skillek
        </p>
        <h1 className="mt-2 font-display text-[2.4rem] font-semibold leading-tight">
          Skill-katalógus
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
  try {
    const ctx = await getAuthContext()
    const isAdmin = hasMinimumRole(ctx?.activeTenantRole, 'admin')
    const isPlatformAdmin = Boolean(
      ctx?.platformRoles?.some((r) => r === 'superadmin' || r === 'platform_operator'),
    )
    const canView = hasMinimumRole(ctx?.activeTenantRole, 'operator')

    if (!canView) {
      return (
        <Card>
          <p className="text-sm text-ink-faint">
            A skill-katalógus megtekintéséhez legalább operátor jogosultság szükséges.
          </p>
        </Card>
      )
    }

    const res = await listSkillCatalogAction()
    if (!res.success) {
      return <CatalogLoadError error={res.error ?? 'A skill-katalógus betöltése sikertelen.'} />
    }

    return (
      <div className="space-y-8">
        <div className="animate-rise">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">
            Governance alá vont skillek
          </p>
          <h1 className="mt-2 font-display text-[2.4rem] font-semibold leading-tight">
            Skill-katalógus
          </h1>
          <p className="mt-2 max-w-2xl text-ink-soft">
            Importálható (<code>SKILL.md</code>) vagy appon belül szerzett, verziózott,
            aláírt agent-skillek. A skill „ereje” mindig annyi, amennyi capability-t az
            admin melléad — a szöveg maga tehetetlen. Minden verzió a write-gate kapun megy
            át: <em>proposed → approved → active</em>, rollbackkel.
          </p>
        </div>

        <SkillCatalogManager
          skills={res.data}
          isAdmin={isAdmin}
          isPlatformAdmin={isPlatformAdmin}
        />
      </div>
    )
  } catch (err) {
    return (
      <CatalogLoadError
        error={err instanceof Error ? err.message : 'A skill-katalógus betöltése sikertelen.'}
      />
    )
  }
}
