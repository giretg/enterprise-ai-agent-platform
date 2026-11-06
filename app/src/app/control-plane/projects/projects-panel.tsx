'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { createWorkProjectAction } from '@/app/actions/project-work'
import type { ProjectListItem } from '@/domain/project-work/project-work-service'
import { asTranslate } from '@/i18n/translate'
import { projectWorkErrorLabel } from './labels'
import {
  ProjectMemoryPanel,
  ProjectPickerNav,
  projectWorkFieldClass,
  projectWorkGhostBtnClass,
  projectWorkPrimaryBtnClass,
} from './project-memory-panel'
import { WorkFilesPanel } from './work-files-panel'

type AgentOption = { id: string; name: string }
type Tab = 'memory' | 'files'

export function ProjectsPanel({
  initialProjects,
  agents,
  canEdit,
  canDeleteMemory = false,
  initialError,
  initialProjectKey = null,
  initialTab = null,
  initialFile = null,
}: {
  initialProjects: ProjectListItem[]
  agents: AgentOption[]
  canEdit: boolean
  canDeleteMemory?: boolean
  initialError: string | null
  /** Mélylink: az agent által adott linkről érkezve ez a projekt / fül / fájl nyílik meg. */
  initialProjectKey?: string | null
  initialTab?: Tab | null
  initialFile?: string | null
}) {
  const t = asTranslate(useTranslations('ControlPlane.projects'))
  const [projects, setProjects] = useState(initialProjects)
  const [projectKey, setProjectKey] = useState(
    initialProjectKey && initialProjects.some((p) => p.key === initialProjectKey)
      ? initialProjectKey
      : (initialProjects[0]?.key ?? '__general__'),
  )
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '')
  const [tab, setTab] = useState<Tab>(initialTab ?? 'memory')
  // A mélylinkes fájl csak a link szerinti projektben nyílik meg magától.
  const deepLinkFile = initialFile && projectKey === initialProjectKey ? initialFile : null

  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(initialError ? projectWorkErrorLabel(initialError, (key) => t(key)) : null)

  const [showNewProject, setShowNewProject] = useState(false)
  const [newProject, setNewProject] = useState({ name: '', key: '', description: '' })
  const [savingProject, setSavingProject] = useState(false)

  const selectedProject = projects.find((p) => p.key === projectKey)
  const selectedAgent = agents.find((a) => a.id === agentId)

  async function onCreateProject() {
    if (!newProject.name.trim()) return
    setSavingProject(true)
    setError(null)
    const res = await createWorkProjectAction({
      name: newProject.name.trim(),
      key: newProject.key.trim() || undefined,
      description: newProject.description.trim() || undefined,
    })
    setSavingProject(false)
    if (!res.success) {
      setError(projectWorkErrorLabel(res.error, (key) => t(key)))
      return
    }
    setProjects((current) => [...current, res.data.project])
    setProjectKey(res.data.project.key)
    setNewProject({ name: '', key: '', description: '' })
    setShowNewProject(false)
    setNotice(t('projectCreated'))
  }

  return (
    <div className="space-y-4">
      {notice ? (
        <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-sm text-sage">{notice}</p>
      ) : null}
      {error ? (
        <p className="rounded-lg border border-coral/35 bg-coral/10 px-3 py-2 text-sm text-coral-deep">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <ProjectPickerNav
          projects={projects}
          projectKey={projectKey}
          onSelect={setProjectKey}
        >
          {canEdit ? (
            <div className="mt-2 border-t border-line/60 p-2">
              {showNewProject ? (
                <div className="space-y-2">
                  <input
                    className={projectWorkFieldClass}
                    placeholder={t('projectName')}
                    value={newProject.name}
                    onChange={(e) => setNewProject({ ...newProject, name: e.target.value })}
                  />
                  <input
                    className={projectWorkFieldClass}
                    placeholder={t('projectKey')}
                    value={newProject.key}
                    onChange={(e) => setNewProject({ ...newProject, key: e.target.value })}
                  />
                  <input
                    className={projectWorkFieldClass}
                    placeholder={t('projectDesc')}
                    value={newProject.description}
                    onChange={(e) => setNewProject({ ...newProject, description: e.target.value })}
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={savingProject}
                      onClick={() => void onCreateProject()}
                      className={projectWorkPrimaryBtnClass}
                    >
                      {savingProject ? t('saving') : t('create')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowNewProject(false)}
                      className={projectWorkGhostBtnClass}
                    >
                      {t('cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowNewProject(true)}
                  className="w-full rounded-lg px-3 py-2 text-left text-sm text-ink-soft hover:bg-night/30 hover:text-ink"
                >
                  {t('newProject')}
                </button>
              )}
            </div>
          ) : null}
        </ProjectPickerNav>

        <div className="min-w-0 flex-1 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label
              className="min-w-52 flex-1 text-xs text-ink-soft"
              title={t('teammateHint')}
            >
              {t('teammate')}
              <select
                className={projectWorkFieldClass + ' mt-1'}
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-1 rounded-full border border-line/60 bg-panel/40 p-1" role="tablist">
              {(
                [
                  { id: 'memory' as const, label: t('tabMemory') },
                  { id: 'files' as const, label: t('tabFiles') },
                ]
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  onClick={() => setTab(item.id)}
                  className={`rounded-full px-4 py-1.5 text-sm transition-colors ${
                    tab === item.id
                      ? 'bg-coral/15 font-medium text-coral-deep'
                      : 'text-ink-soft hover:text-ink'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {!canEdit ? (
            <p className="rounded-lg border border-ink/10 bg-white/40 px-3 py-2 text-sm text-ink-soft">
              {t('viewOnly')}
            </p>
          ) : null}

          {tab === 'memory' ? (
            <ProjectMemoryPanel
              key={`${agentId}:${projectKey}`}
              agentId={agentId}
              agentName={selectedAgent?.name}
              projectKey={projectKey}
              projectName={selectedProject?.name}
              canEdit={canEdit}
              canDeleteMemory={canDeleteMemory}
            />
          ) : (
            <WorkFilesPanel key={projectKey} projectKey={projectKey} canEdit={canEdit} initialFile={deepLinkFile} />
          )}
        </div>
      </div>
    </div>
  )
}
