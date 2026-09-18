import { listWorkProjects } from '@/app/actions/work-projects'
import { getAuthContext } from '@/auth/context'
import { hasMinimumRole } from '@/auth/types'
import { WorkProjectCatalog } from '@/components/work-projects/work-project-catalog'
import {
  GENERAL_WORK_PROJECT_DESCRIPTION,
  GENERAL_WORK_PROJECT_KEY,
  GENERAL_WORK_PROJECT_NAME,
} from '@/lib/work-project'

const GENERAL_PROJECT = {
  id: null,
  key: GENERAL_WORK_PROJECT_KEY,
  name: GENERAL_WORK_PROJECT_NAME,
  description: GENERAL_WORK_PROJECT_DESCRIPTION,
  builtin: true,
  archived: false,
}

export default async function ProjectsPage() {
  const ctx = await getAuthContext()
  const canEdit = hasMinimumRole(ctx?.activeTenantRole, 'operator')
  const res = await listWorkProjects({ includeArchived: true })
  const projects = res.success ? res.data : [GENERAL_PROJECT]

  return (
    <div className="space-y-8">
      <div className="animate-rise">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Munka</p>
        <h1 className="mt-2 font-display text-[2.4rem] font-semibold leading-tight">Projektek</h1>
        <p className="mt-2 max-w-2xl text-ink-soft">
          A projekt egy nagyobb, összefüggő munka. Több beszélgetés és több AI-munkatárs tartozhat
          hozzá — az emlékek, a döntések és a „hol tartunk” ettől a kerettől függően különülnek el.
        </p>
      </div>

      {!res.success ? (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">
          A lista most nem töltődött be. Új projektet ettől még létrehozhatsz.
        </p>
      ) : null}

      <WorkProjectCatalog projects={projects} canEdit={canEdit} />
    </div>
  )
}
