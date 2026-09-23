'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  createWorkProjectAction,
  deleteWorkFileAction,
  listProjectMemoryAction,
  listWorkFilesAction,
  readWorkFileAction,
  saveProjectMemoryAction,
  saveWorkFileAction,
  type WorkFileListItem,
} from '@/app/actions/project-work'
import type { MemoryView, ProjectListItem } from '@/domain/project-work/project-work-service'
import { projectWorkErrorLabel } from './labels'

type AgentOption = { id: string; name: string }
type Tab = 'memory' | 'files'
type MemoryKind = 'decision' | 'open_task' | 'finding' | 'constraint' | 'artifact' | 'handoff_summary'

const MEMORY_KIND_META: Record<MemoryKind, { label: string; hint: string; badge: string }> = {
  decision: {
    label: 'Döntés',
    hint: 'Meghozott döntés és indoka.',
    badge: 'bg-coral/15 text-coral-deep',
  },
  open_task: {
    label: 'Nyitott feladat',
    hint: 'Még el nem végzett teendő.',
    badge: 'bg-sage/15 text-sage',
  },
  finding: {
    label: 'Megállapítás',
    hint: 'Felismert tény, tanulság.',
    badge: 'bg-ink/5 text-ink-soft',
  },
  constraint: {
    label: 'Korlát',
    hint: 'Betartandó szabály, tiltás.',
    badge: 'bg-ink/5 text-ink-soft',
  },
  artifact: {
    label: 'Hivatkozás',
    hint: 'Munkafájlra mutató emlék (a terv a fájlban él).',
    badge: 'bg-ink/5 text-ink-soft',
  },
  handoff_summary: {
    label: 'Átadás',
    hint: 'Átadási állapot a következő futásnak.',
    badge: 'bg-ink/5 text-ink-soft',
  },
}

const BODY_PREVIEW_CHARS = 240

const inputClass =
  'w-full rounded-md border border-ink/15 bg-white px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint'
const primaryBtnClass =
  'rounded-full bg-coral/20 px-4 py-1.5 text-sm font-semibold text-coral disabled:opacity-50'
const ghostBtnClass =
  'rounded-full border border-ink/20 px-4 py-1.5 text-sm text-ink disabled:opacity-50'

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('hu-HU')
}

type MemoryDraft = { kind: MemoryKind; title: string; body: string; artifactPath: string }

const emptyDraft: MemoryDraft = { kind: 'decision', title: '', body: '', artifactPath: '' }

function MemoryEditor({
  draft,
  onChange,
  onSubmit,
  onCancel,
  busy,
  submitLabel,
}: {
  draft: MemoryDraft
  onChange: (next: MemoryDraft) => void
  onSubmit: () => void
  onCancel: () => void
  busy: boolean
  submitLabel: string
}) {
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-ink/10 bg-white/60 p-3">
      <label className="block text-xs text-ink-soft">
        Fajta
        <select
          className={inputClass + ' mt-1'}
          value={draft.kind}
          onChange={(e) => onChange({ ...draft, kind: e.target.value as MemoryKind })}
        >
          {(Object.keys(MEMORY_KIND_META) as MemoryKind[]).map((kind) => (
            <option key={kind} value={kind} title={MEMORY_KIND_META[kind].hint}>
              {MEMORY_KIND_META[kind].label} — {MEMORY_KIND_META[kind].hint}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs text-ink-soft">
        Cím
        <input
          className={inputClass + ' mt-1'}
          value={draft.title}
          maxLength={200}
          placeholder="Rövid, kereshető cím"
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
        />
      </label>
      <label className="block text-xs text-ink-soft">
        Tartalom
        <textarea
          className={inputClass + ' mt-1'}
          rows={5}
          value={draft.body}
          maxLength={8000}
          placeholder="A lényeg: mi, miért, kivel egyeztetve"
          onChange={(e) => onChange({ ...draft, body: e.target.value })}
        />
      </label>
      <label className="block text-xs text-ink-soft" title="Opcionális: melyik munkafájlban él a részletes terv">
        Munkafájl-hivatkozás (opcionális)
        <input
          className={inputClass + ' mt-1'}
          value={draft.artifactPath}
          placeholder="pl. tervek/bevezetes.md"
          onChange={(e) => onChange({ ...draft, artifactPath: e.target.value })}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={onSubmit} className={primaryBtnClass}>
          {busy ? 'Mentés…' : submitLabel}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={ghostBtnClass}>
          Mégse
        </button>
      </div>
    </div>
  )
}

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

  const [memories, setMemories] = useState<MemoryView[]>([])
  const [memLoading, setMemLoading] = useState(false)
  const [files, setFiles] = useState<WorkFileListItem[]>([])
  const [filesLoading, setFilesLoading] = useState(false)

  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(initialError ? projectWorkErrorLabel(initialError) : null)

  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState<'all' | MemoryKind>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<MemoryDraft>(emptyDraft)
  const [showNewMemory, setShowNewMemory] = useState(false)
  const [newDraft, setNewDraft] = useState<MemoryDraft>(emptyDraft)
  const [savingMemory, setSavingMemory] = useState(false)

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

  function clearTransientUi() {
    setExpandedId(null)
    setEditingId(null)
    setSelectedPath(null)
    setShowNewMemory(false)
    setShowNewFile(false)
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setMemLoading(true)
      setFilesLoading(true)
      setError(null)
      const [memRes, fileRes] = await Promise.all([
        agentId ? listProjectMemoryAction({ agentId, projectKey }) : null,
        listWorkFilesAction({ projectKey }),
      ])
      if (cancelled) return
      setMemLoading(false)
      setFilesLoading(false)
      if (memRes) {
        if (memRes.success) setMemories(memRes.data.items)
        else setError(projectWorkErrorLabel(memRes.error))
      } else {
        setMemories([])
      }
      if (fileRes?.success) setFiles(fileRes.data.files)
      else if (fileRes) setError(projectWorkErrorLabel(fileRes.error))
    })()
    return () => {
      cancelled = true
    }
  }, [projectKey, agentId])

  const visibleMemories = useMemo(() => {
    const q = search.trim().toLowerCase()
    return memories.filter((item) => {
      if (kindFilter !== 'all' && item.kind !== kindFilter) return false
      if (!q) return true
      return (
        item.title.toLowerCase().includes(q) ||
        item.body.toLowerCase().includes(q) ||
        item.withUserName.toLowerCase().includes(q)
      )
    })
  }, [memories, search, kindFilter])

  async function onSaveMemory(replaceId?: string) {
    const draft = replaceId ? editDraft : newDraft
    if (!draft.title.trim() || !draft.body.trim() || !agentId) return
    setSavingMemory(true)
    setError(null)
    setNotice(null)
    const res = await saveProjectMemoryAction({
      agentId,
      projectKey,
      kind: draft.kind,
      title: draft.title.trim(),
      body: draft.body.trim(),
      artifactPath: draft.artifactPath.trim() || undefined,
      replaceId,
    })
    setSavingMemory(false)
    if (!res.success) {
      setError(projectWorkErrorLabel(res.error))
      return
    }
    setMemories((current) => {
      if (replaceId) return current.map((m) => (m.id === replaceId ? res.data.item : m))
      return [res.data.item, ...current]
    })
    setEditingId(null)
    setShowNewMemory(false)
    setNewDraft(emptyDraft)
    setNotice(replaceId ? 'Emlék frissítve — a régi változat lecserélődött.' : 'Új emlék mentve.')
  }

  function startEdit(item: MemoryView) {
    setEditingId(item.id)
    setEditDraft({
      kind: item.kind as MemoryKind,
      title: item.title,
      body: item.body,
      artifactPath: item.artifactPath ?? '',
    })
  }

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
    clearTransientUi()
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
        <nav
          aria-label="Projektek"
          className="shrink-0 rounded-xl border border-line/60 bg-panel/40 p-2 lg:sticky lg:top-4 lg:w-64"
        >
          <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
            Projektek
          </p>
          <div className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {projects.map((project) => {
              const selected = project.key === projectKey
              return (
                <button
                  key={project.key}
                  type="button"
                  onClick={() => {
                    setProjectKey(project.key)
                    clearTransientUi()
                  }}
                  title={project.description ?? project.key}
                  className={`whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    selected
                      ? 'bg-coral/15 font-medium text-coral-deep'
                      : 'text-ink-soft hover:bg-night/30 hover:text-ink'
                  }`}
                >
                  {project.name}
                  <span className="block text-xs font-normal text-ink-faint">{project.key}</span>
                </button>
              )
            })}
          </div>
          {canEdit ? (
            <div className="mt-2 border-t border-line/60 p-2">
              {showNewProject ? (
                <div className="space-y-2">
                  <input
                    className={inputClass}
                    placeholder="Projekt neve"
                    value={newProject.name}
                    onChange={(e) => setNewProject({ ...newProject, name: e.target.value })}
                  />
                  <input
                    className={inputClass}
                    placeholder="Kulcs (opcionális, pl. ugyfel-x)"
                    value={newProject.key}
                    onChange={(e) => setNewProject({ ...newProject, key: e.target.value })}
                  />
                  <input
                    className={inputClass}
                    placeholder="Leírás (opcionális)"
                    value={newProject.description}
                    onChange={(e) => setNewProject({ ...newProject, description: e.target.value })}
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={savingProject}
                      onClick={() => void onCreateProject()}
                      className={primaryBtnClass}
                    >
                      {savingProject ? 'Mentés…' : 'Létrehozás'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowNewProject(false)}
                      className={ghostBtnClass}
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
        </nav>

        <div className="min-w-0 flex-1 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-52 flex-1 text-xs text-ink-soft" title="A projektmemória munkatársonként él — válaszd ki, kinek az emlékeit nézed">
              Munkatárs
              <select
                className={inputClass + ' mt-1'}
                value={agentId}
                onChange={(e) => {
                  setAgentId(e.target.value)
                  clearTransientUi()
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
            <section className="space-y-3" aria-label="Projektmemória">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className={inputClass + ' min-w-52 flex-1'}
                  placeholder="Keresés cím, tartalom vagy beszélgetőpartner alapján…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className="flex flex-wrap gap-1">
                  {(['all', ...(Object.keys(MEMORY_KIND_META) as MemoryKind[])] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => setKindFilter(kind)}
                      className={`rounded-full px-3 py-1 text-xs transition-colors ${
                        kindFilter === kind
                          ? 'bg-ink text-white'
                          : 'border border-ink/15 text-ink-soft hover:text-ink'
                      }`}
                    >
                      {kind === 'all' ? 'Mind' : MEMORY_KIND_META[kind].label}
                    </button>
                  ))}
                </div>
              </div>

              {canEdit && !showNewMemory ? (
                <button type="button" onClick={() => setShowNewMemory(true)} className={primaryBtnClass}>
                  + Új emlék
                </button>
              ) : null}
              {showNewMemory ? (
                <div className="rounded-xl border border-ink/10 bg-white/50 p-4 shadow-sm">
                  <p className="font-medium text-ink">Új emlék</p>
                  <p className="text-xs text-ink-soft">
                    {selectedProject?.name} · {selectedAgent?.name} · azonnal bekerül, verzióval és
                    naplóval.
                  </p>
                  <MemoryEditor
                    draft={newDraft}
                    onChange={setNewDraft}
                    onSubmit={() => void onSaveMemory()}
                    onCancel={() => {
                      setShowNewMemory(false)
                      setNewDraft(emptyDraft)
                    }}
                    busy={savingMemory}
                    submitLabel="Emlék mentése"
                  />
                </div>
              ) : null}

              {memLoading ? (
                <p className="text-sm text-ink-soft">Betöltés…</p>
              ) : !agentId ? (
                <p className="text-sm text-ink-soft">
                  Nincs munkatárs — a projektmemória munkatársonként él.
                </p>
              ) : visibleMemories.length === 0 ? (
                <p className="text-sm text-ink-soft">
                  {memories.length === 0
                    ? 'Ehhez a projekthez ennél a munkatársnál még nincs projektmemória.'
                    : 'A keresésnek nincs találata.'}
                </p>
              ) : (
                <ul className="space-y-3">
                  {visibleMemories.map((item) => {
                    const meta = MEMORY_KIND_META[item.kind as MemoryKind] ?? {
                      label: item.kind,
                      hint: '',
                      badge: 'bg-ink/5 text-ink-soft',
                    }
                    const expanded = expandedId === item.id
                    const body =
                      expanded || item.body.length <= BODY_PREVIEW_CHARS
                        ? item.body
                        : `${item.body.slice(0, BODY_PREVIEW_CHARS)}…`
                    return (
                      <li
                        key={item.id}
                        className="rounded-xl border border-ink/10 bg-white/50 p-4 shadow-sm"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span
                            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.badge}`}
                            title={meta.hint}
                          >
                            {meta.label}
                          </span>
                          <span className="text-xs text-ink-faint">{formatWhen(item.createdAt)}</span>
                        </div>
                        <p className="mt-2 font-medium text-ink">{item.title}</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-ink-soft">{body}</p>
                        {item.artifactPath ? (
                          <p className="mt-1 text-xs text-ink-faint" title="A részletes terv ebben a munkafájlban él">
                            Hivatkozott fájl: {item.artifactPath}
                          </p>
                        ) : null}
                        <p className="mt-2 text-xs text-ink-faint">
                          Beszélgetőpartner: {item.withUserName}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {item.body.length > BODY_PREVIEW_CHARS ? (
                            <button
                              type="button"
                              onClick={() => setExpandedId(expanded ? null : item.id)}
                              className="rounded-full px-3 py-1 text-xs text-ink-soft hover:text-ink"
                            >
                              {expanded ? 'Elrejtés' : 'Teljes szöveg'}
                            </button>
                          ) : null}
                          {canEdit ? (
                            <button
                              type="button"
                              onClick={() => startEdit(item)}
                              className="rounded-full px-3 py-1 text-xs text-ink-soft hover:text-ink"
                            >
                              Szerkesztés
                            </button>
                          ) : null}
                        </div>
                        {editingId === item.id ? (
                          <MemoryEditor
                            draft={editDraft}
                            onChange={setEditDraft}
                            onSubmit={() => void onSaveMemory(item.id)}
                            onCancel={() => setEditingId(null)}
                            busy={savingMemory}
                            submitLabel="Változások mentése"
                          />
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
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
                  className={primaryBtnClass}
                >
                  + Új munkafájl
                </button>
              ) : null}
              {showNewFile ? (
                <div className="space-y-2 rounded-xl border border-ink/10 bg-white/50 p-4 shadow-sm">
                  <input
                    className={inputClass}
                    placeholder="Útvonal, pl. tervek/bevezetes.md"
                    value={newPath}
                    onChange={(e) => setNewPath(e.target.value)}
                  />
                  <textarea
                    className={inputClass}
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
                      className={primaryBtnClass}
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
                      className={ghostBtnClass}
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
                        className={inputClass + ' font-mono'}
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
                            className={primaryBtnClass}
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
