import { getTranslations } from 'next-intl/server'
import { requireTenantRole } from '@/auth/tenant-context'
import { hasMinimumRole } from '@/lib/iam-policy'
import { listAgents } from '@/app/actions/platform'
import { listWorkProjectsAction } from '@/app/actions/project-work'
import { ProjectsPanel } from './projects-panel'

export const dynamic = 'force-dynamic'

export default async function ProjectsPage() {
  const ctx = await requireTenantRole('viewer')
  const [projectsRes, agentsRes] = await Promise.all([
    listWorkProjectsAction(),
    listAgents({ limit: 100 }),
  ])

  const projects = projectsRes.success ? projectsRes.data.projects : []
  const agents = agentsRes.success
    ? agentsRes.data.map((agent) => ({ id: agent.id, name: agent.name }))
    : []
  const error = projectsRes.success ? null : projectsRes.error
  const canEdit = hasMinimumRole(ctx.activeTenantRole, 'approver')

  const t = await getTranslations('ControlPlane.projects')
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">{t('title')}</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">{t('body')}</p>
      </div>
      <ProjectsPanel
        initialProjects={projects}
        agents={agents}
        canEdit={canEdit}
        initialError={error}
      />
    </div>
  )
}
