import Link from 'next/link'
import { getCurrentUser } from '@/auth'
import { hasMinimumRole } from '@/auth/types'
import { listProcessDefinitions, listProcesses } from '@/app/actions/process'
import {
  listPlaybookVersionsForProcessDefinitionEditing,
  listPublishedPlaybookVersionsForProcessBuilder,
  listStartablePlaybooks,
} from '@/app/actions/playbook'
import {
  ProcessDefinitionBuilder,
  type ProcessBuilderPlaybookVersion,
} from '@/components/processes/process-definition-builder'
import {
  StartProcessForm,
  type StartablePlaybook,
  type StartableProcessDefinition,
} from '@/components/processes/start-process-form'
import { ProcessDefinitionList } from '@/components/processes/process-definition-list'
import { PROCESS_STATUS_CLASS } from '@/lib/process-labels'

export default async function ProcessesPage() {
  const [user, processesRes, definitionsRes, startableRes] = await Promise.all([
    getCurrentUser(),
    listProcesses(),
    listProcessDefinitions({}),
    listStartablePlaybooks(),
  ])
  const canStart = user ? hasMinimumRole(user.role, 'operator') : false
  const canEditDraft = user ? hasMinimumRole(user.role, 'operator') : false
  const canArchive = user ? hasMinimumRole(user.role, 'admin') : false
  const allDefinitions = definitionsRes.success ? definitionsRes.data : []
  const pinnedVersionIds = [...new Set(allDefinitions.map((d) => d.playbookVersionId))]
  const [builderVersionsRes, pinnedVersionsRes] = await Promise.all([
    canUseBuilder(user)
      ? listPublishedPlaybookVersionsForProcessBuilder()
      : Promise.resolve({ success: true as const, data: [] as ProcessBuilderPlaybookVersion[] }),
    canEditDraft && pinnedVersionIds.length > 0
      ? listPlaybookVersionsForProcessDefinitionEditing(pinnedVersionIds)
      : Promise.resolve({ success: true as const, data: [] as ProcessBuilderPlaybookVersion[] }),
  ])
  const startable: StartablePlaybook[] = startableRes.success ? startableRes.data : []
  const builderVersions: ProcessBuilderPlaybookVersion[] = builderVersionsRes.success
    ? builderVersionsRes.data
    : []
  const playbookVersionsById = new Map<string, ProcessBuilderPlaybookVersion>()
  for (const version of builderVersions) {
    playbookVersionsById.set(version.playbookVersionId, version)
  }
  if (pinnedVersionsRes.success) {
    for (const version of pinnedVersionsRes.data) {
      playbookVersionsById.set(version.playbookVersionId, version)
    }
  }
  const playbookVersionsForList = [...playbookVersionsById.values()]
  const definitions: StartableProcessDefinition[] = allDefinitions
    .filter((d) => d.status === 'active')
    .map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      playbookVersionId: d.playbookVersionId,
      triggers: d.triggers.map((t) => ({ id: t.id, type: t.type, enabled: t.enabled })),
    }))
  const processes = processesRes.success ? processesRes.data : []

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Playbook</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Folyamatok és Futások</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          A Folyamat a publikált Playbook-verzióra PIN-elt, agentekhez kötött konfiguráció. A Futás
          egyetlen lefutás ebből a konfigurációból, kézi, ticket, chat vagy monitor triggerrel.
        </p>
      </div>

      {canStart && (
        <section className="atelier-card p-5">
          <h2 className="mb-4 font-display text-lg font-semibold">Új Folyamat összeállítása</h2>
          {!builderVersionsRes.success && (
            <p className="mb-3 text-sm text-coral">
              Nem sikerült betölteni a publikált Playbook-verziókat: {builderVersionsRes.error}
            </p>
          )}
          <ProcessDefinitionBuilder playbookVersions={builderVersions} />
        </section>
      )}

      {canStart && (
        <section className="atelier-card p-5">
          <h2 className="mb-4 font-display text-lg font-semibold">Új Futás indítása</h2>
          {!definitionsRes.success && (
            <p className="mb-3 text-sm text-coral">
              Nem sikerült betölteni az aktív Folyamatokat: {definitionsRes.error}
            </p>
          )}
          <StartProcessForm definitions={definitions} playbooks={startable} />
        </section>
      )}

      <section className="atelier-card p-5">
        <h2 className="mb-4 font-display text-lg font-semibold">Folyamatok</h2>
        {!definitionsRes.success && (
          <p className="text-sm text-coral">Nem sikerült betölteni: {definitionsRes.error}</p>
        )}
        <ProcessDefinitionList
          definitions={allDefinitions}
          playbookVersions={playbookVersionsForList}
          canEditDraft={canEditDraft}
          canArchive={canArchive}
        />
      </section>

      <section className="atelier-card p-5">
        <h2 className="mb-4 font-display text-lg font-semibold">Aktív és lezárt Futások</h2>
        {!processesRes.success && (
          <p className="text-sm text-coral">Nem sikerült betölteni: {processesRes.error}</p>
        )}
        <ul className="divide-y divide-ink/8">
          {processes.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <Link href={`/control-plane/processes/${p.id}`} className="group">
                <span className="font-medium group-hover:text-accent">{p.processType}</span>
                <span className="ml-2 font-mono text-xs text-ink-soft">{p.playbookRef}</span>
              </Link>
              <div className="flex items-center gap-3">
                <span className="text-xs text-ink-soft">
                  {new Date(p.startedAt).toLocaleString('hu-HU')}
                </span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    PROCESS_STATUS_CLASS[p.status as keyof typeof PROCESS_STATUS_CLASS] ?? 'bg-ink/8 text-ink-soft'
                  }`}
                >
                  {p.status}
                </span>
              </div>
            </li>
          ))}
          {processes.length === 0 && <li className="py-3 text-sm text-ink-soft">Még nincs Futás.</li>}
        </ul>
      </section>
    </div>
  )
}

function canUseBuilder(user: Awaited<ReturnType<typeof getCurrentUser>>) {
  return user ? hasMinimumRole(user.role, 'operator') : false
}
