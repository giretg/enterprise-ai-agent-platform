'use client'

import { useEffect, useState } from 'react'
import {
  createWorkProjectAction,
  deleteWorkFileAction,
  listWorkFilesAction,
  readWorkFileAction,
  saveWorkFileAction,
  type WorkFileListItem,
} from '@/app/actions/project-work'
import type { ProjectListItem } from '@/domain/project-work/project-work-service'
import { projectWorkErrorLabel } from './labels'
import {
  ProjectMemoryPanel,
  ProjectPickerNav,
  projectWorkFieldClass,
  projectWorkGhostBtnClass,
  projectWorkPrimaryBtnClass,
} from './project-memory-panel'

type AgentOption = { id: string; name: string }
type Tab = 'memory' | 'files'

export function ProjectsPanel({
  initialProjects,
  agents,
  canEdit,
  initialError,
}: {
  initialProjects: ProjectListItem[]
  agents: AgentOption[]
  canEdit: boolean
  initialError: string | null
}) {
  const [projects, setProjects] = useState(initialProjects)
  const [projectKey, setProjectKey] = useState(initialProjects[0]?.key ?? '__general__')
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '')
  const [tab, setTab] = useState<Tab>('memory')

  const [files, setFiles] = useState<WorkFileListItem[]>([])
  const [filesLoading, setFilesLoading] = useState(false)

  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(initialError ? projectWorkErrorLabel(initialError) : null)

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState('')
  const [fileLoading, setFileLoading] = useState(false)
  const [savingFile, setSavingFile] = useState(false)
  const [showNewFile, setShowNewFile] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [newFileContent, setNewFileContent] = useState('')

  const [showNewProject, setShowNewProject] = useState(false)
  const [newProject, setNewProject] = useState({ name: '', key: '', description: '' })
  const [savingProject, setSavingProject] = useState(false)

  const selectedProject = projects.find((p) => p.key === projectKey)
  const selectedAgent = agents.find((a) => a.id === agentId)

  function clearFileUi() {
    setSelectedPath(null)
    setShowNewFile(false)
  }

  useEffect(() => {
    if (tab !== 'files') return
    let cancelled = false
    void (async () => {
      setFilesLoading(true)
      setError(null)
      const fileRes = await listWorkFilesAction({ projectKey })
      if (cancelled) return
      setFilesLoading(false)
      if (fileRes.success) setFiles(fileRes.data.files)
      else setError(projectWorkErrorLabel(fileRes.error))
    })()
    return () => {
      cancelled = true
    }
  }, [projectKey, tab])

  async function onSelectFile(path: string) {
    setShowNewFile(false)
    setSelectedPath(path)
    setFileLoading(true)
    setError(null)
    const res = await readWorkFileAction({ projectKey, path })
    setFileLoading(false)
    if (!res.success) {
      setError(projectWorkErrorLabel(res.error))
      return
    }
    setFileContent(res.data.content)
  }

  async function onSaveFile(path: string, content: string, isNew: boolean) {
    if (!path.trim()) return
    setSavingFile(true)
    setError(null)
    setNotice(null)
    const res = await saveWorkFileAction({ projectKey, path: path.trim(), content })
    setSavingFile(false)
    if (!res.success) {
      setError(projectWorkErrorLabel(res.error))
      return
    }
    const listed = await listWorkFilesAction({ projectKey })
    if (listed.success) setFiles(listed.data.files)
    setSelectedPath(res.data.path)
    if (isNew) {
      setShowNewFile(false)
      setNewPath('')
      setNewFileContent('')
    }
    setNotice('Munkafájl mentve.')
  }

  async function onDeleteFile(path: string) {
    if (!window.confirm(`Törlöd a(z) ${path} munkafájlt?`)) return
    setError(null)
    const res = await deleteWorkFileAction({ projectKey, path })
    if (!res.success) {
      setError(projectWorkErrorLabel(res.error))
      return
    }
    setFiles((current) => current.filter((f) => f.path !== path))
    if (selectedPath === path) {
      setSelectedPath(null)
      setFileContent('')
    }
    setNotice('Munkafájl törölve.')
  }

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
      setError(projectWorkErrorLabel(res.error))
      return
    }
    setProjects((current) => [...current, res.data.project])
    setProjectKey(res.data.project.key)
    clearFileUi()
    setNewProject({ name: '', key: '', description: '' })
    setShowNewProject(false)
    setNotice('Projekt létrehozva.')
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
          onSelect={(key) => {
            setProjectKey(key)
            clearFileUi()
          }}
        >
          {canEdit ? (
            <div className="mt-2 border-t border-line/60 p-2">
              {showNewProject ? (
                <div className="space-y-2">
                  <input
                    className={projectWorkFieldClass}
                    placeholder="Projekt neve"
                    value={newProject.name}
                    onChange={(e) => setNewProject({ ...newProject, name: e.target.value })}
                  />
                  <input
                    className={projectWorkFieldClass}
                    placeholder="Kulcs (opcionális, pl. ugyfel-x)"
                    value={newProject.key}
                    onChange={(e) => setNewProject({ ...newProject, key: e.target.value })}
                  />
                  <input
                    className={projectWorkFieldClass}
                    placeholder="Leírás (opcionális)"
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
                      {savingProject ? 'Mentés…' : 'Létrehozás'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowNewProject(false)}
                      className={projectWorkGhostBtnClass}
                    >
                      Mégse
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowNewProject(true)}
                  className="w-full rounded-lg px-3 py-2 text-left text-sm text-ink-soft hover:bg-night/30 hover:text-ink"
                >
                  + Új projekt
                </button>
              )}
            </div>
          ) : null}
        </ProjectPickerNav>

        <div className="min-w-0 flex-1 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label
              className="min-w-52 flex-1 text-xs text-ink-soft"
              title="A projektmemória munkatársonként él — válaszd ki, kinek az emlékeit nézed"
            >
              Munkatárs
              <select
                className={projectWorkFieldClass + ' mt-1'}
                value={agentId}
                onChange={(e) => {
                  setAgentId(e.target.value)
                  clearFileUi()
                }}
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
                  { id: 'memory', label: 'Projektmemória' },
                  { id: 'files', label: 'Munkafájlok' },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}
                  className={`rounded-full px-4 py-1.5 text-sm transition-colors ${
                    tab === t.id
                      ? 'bg-coral/15 font-medium text-coral-deep'
                      : 'text-ink-soft hover:text-ink'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {!canEdit ? (
            <p className="rounded-lg border border-ink/10 bg-white/40 px-3 py-2 text-sm text-ink-soft">
              Nézegetni szabad; íráshoz és szerkesztéshez jóváhagyói szerep kell.
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
            />
          ) : (
            <section className="space-y-3" aria-label="Munkafájlok">
              <p className="text-sm text-ink-soft">
                A munka termékei: tervek, jegyzetek, piszkozatok. A munkatársak közösen írják; a
                promptba nem kerülnek be maguktól.
              </p>
              {canEdit && !showNewFile ? (
                <button
                  type="button"
                  onClick={() => {
                    setShowNewFile(true)
                    setSelectedPath(null)
                    setNewPath('')
                    setNewFileContent('')
                  }}
                  className={projectWorkPrimaryBtnClass}
                >
                  + Új munkafájl
                </button>
              ) : null}
              {showNewFile ? (
                <div className="space-y-2 rounded-xl border border-ink/10 bg-white/50 p-4 shadow-sm">
                  <input
                    className={projectWorkFieldClass}
                    placeholder="Útvonal, pl. tervek/bevezetes.md"
                    value={newPath}
                    onChange={(e) => setNewPath(e.target.value)}
                  />
                  <textarea
                    className={projectWorkFieldClass}
                    rows={6}
                    placeholder="Tartalom…"
                    value={newFileContent}
                    onChange={(e) => setNewFileContent(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={savingFile}
                      onClick={() => void onSaveFile(newPath, newFileContent, true)}
                      className={projectWorkPrimaryBtnClass}
                    >
                      {savingFile ? 'Mentés…' : 'Fájl mentése'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowNewFile(false)
                        setNewPath('')
                        setNewFileContent('')
                      }}
                      className={projectWorkGhostBtnClass}
                    >
                      Mégse
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="flex flex-col gap-4 md:flex-row md:items-start">
                <ul className="w-full shrink-0 space-y-1 md:w-64">
                  {filesLoading ? (
                    <li className="text-sm text-ink-soft">Betöltés…</li>
                  ) : files.length === 0 ? (
                    <li className="text-sm text-ink-soft">Ebben a projektben még nincs munkafájl.</li>
                  ) : (
                    files.map((file) => (
                      <li key={file.path}>
                        <button
                          type="button"
                          onClick={() => void onSelectFile(file.path)}
                          title={`${file.path} · ${file.byteSize} bájt`}
                          className={`w-full truncate rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                            selectedPath === file.path
                              ? 'bg-coral/15 font-medium text-coral-deep'
                              : 'text-ink-soft hover:bg-night/30 hover:text-ink'
                          }`}
                        >
                          {file.path}
                        </button>
                      </li>
                    ))
                  )}
                </ul>
                <div className="min-w-0 flex-1">
                  {!selectedPath ? (
                    <p className="text-sm text-ink-soft">Válassz fájlt a listából.</p>
                  ) : fileLoading ? (
                    <p className="text-sm text-ink-soft">Betöltés…</p>
                  ) : (
                    <div className="space-y-2 rounded-xl border border-ink/10 bg-white/50 p-4 shadow-sm">
                      <p className="truncate font-medium text-ink" title={selectedPath}>
                        {selectedPath}
                      </p>
                      <textarea
                        className={projectWorkFieldClass + ' font-mono'}
                        rows={14}
                        value={fileContent}
                        readOnly={!canEdit}
                        onChange={(e) => setFileContent(e.target.value)}
                      />
                      {canEdit ? (
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={savingFile}
                            onClick={() => void onSaveFile(selectedPath, fileContent, false)}
                            className={projectWorkPrimaryBtnClass}
                          >
                            {savingFile ? 'Mentés…' : 'Mentés'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void onDeleteFile(selectedPath)}
                            className="rounded-full px-4 py-1.5 text-sm text-coral-deep hover:bg-coral/10"
                          >
                            Törlés
                          </button>
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
