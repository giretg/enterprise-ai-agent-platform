'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { listProjectMemoryAction, saveProjectMemoryAction } from '@/app/actions/project-work'
import { PROJECT_MEMORY_KINDS } from '@/domain/project-work/types'
import type { MemoryView, ProjectListItem } from '@/domain/project-work/project-work-service'
import { GENERAL_WORK_PROJECT_KEY } from '@/lib/work-project'
import { projectWorkErrorLabel } from './labels'

export type MemoryKind = (typeof PROJECT_MEMORY_KINDS)[number]

export const MEMORY_KIND_META: Record<MemoryKind, { label: string; hint: string; badge: string }> = {
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

export const projectWorkFieldClass =
  'w-full rounded-md border border-ink/15 bg-white px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint'
export const projectWorkPrimaryBtnClass =
  'rounded-full bg-coral/20 px-4 py-1.5 text-sm font-semibold text-coral disabled:opacity-50'
export const projectWorkGhostBtnClass =
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
          className={projectWorkFieldClass + ' mt-1'}
          value={draft.kind}
          onChange={(e) => onChange({ ...draft, kind: e.target.value as MemoryKind })}
        >
          {PROJECT_MEMORY_KINDS.map((kind) => (
            <option key={kind} value={kind} title={MEMORY_KIND_META[kind].hint}>
              {MEMORY_KIND_META[kind].label} — {MEMORY_KIND_META[kind].hint}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs text-ink-soft">
        Cím
        <input
          className={projectWorkFieldClass + ' mt-1'}
          value={draft.title}
          maxLength={200}
          placeholder="Rövid, kereshető cím"
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
        />
      </label>
      <label className="block text-xs text-ink-soft">
        Tartalom
        <textarea
          className={projectWorkFieldClass + ' mt-1'}
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
          className={projectWorkFieldClass + ' mt-1'}
          value={draft.artifactPath}
          placeholder="pl. tervek/bevezetes.md"
          onChange={(e) => onChange({ ...draft, artifactPath: e.target.value })}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={onSubmit} className={projectWorkPrimaryBtnClass}>
          {busy ? 'Mentés…' : submitLabel}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={projectWorkGhostBtnClass}>
          Mégse
        </button>
      </div>
    </div>
  )
}

export function ProjectPickerNav({
  projects,
  projectKey,
  onSelect,
  children,
}: {
  projects: ProjectListItem[]
  projectKey: string
  onSelect: (key: string) => void
  children?: ReactNode
}) {
  return (
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
              onClick={() => onSelect(project.key)}
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
      {children}
    </nav>
  )
}

export function ProjectMemoryPanel({
  agentId,
  agentName,
  projectKey,
  projectName,
  canEdit,
}: {
  agentId: string
  agentName?: string
  projectKey: string
  projectName?: string
  canEdit: boolean
}) {
  const [memories, setMemories] = useState<MemoryView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState<'all' | MemoryKind>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<MemoryDraft>(emptyDraft)
  const [showNewMemory, setShowNewMemory] = useState(false)
  const [newDraft, setNewDraft] = useState<MemoryDraft>(emptyDraft)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!agentId) {
        setMemories([])
        setLoading(false)
        return
      }
      setLoading(true)
      setError(null)
      setNotice(null)
      const res = await listProjectMemoryAction({ agentId, projectKey })
      if (cancelled) return
      setLoading(false)
      if (res.success) setMemories(res.data.items)
      else setError(projectWorkErrorLabel(res.error))
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
    setSaving(true)
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
    setSaving(false)
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
      kind: item.kind,
      title: item.title,
      body: item.body,
      artifactPath: item.artifactPath ?? '',
    })
  }

  return (
    <section className="space-y-3" aria-label="Projektmemória">
      {notice ? (
        <p className="rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-sm text-sage">{notice}</p>
      ) : null}
      {error ? (
        <p className="rounded-lg border border-coral/35 bg-coral/10 px-3 py-2 text-sm text-coral-deep">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={projectWorkFieldClass + ' min-w-52 flex-1'}
          placeholder="Keresés cím, tartalom vagy beszélgetőpartner alapján…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex flex-wrap gap-1">
          {(['all', ...PROJECT_MEMORY_KINDS] as const).map((kind) => (
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
        <button type="button" onClick={() => setShowNewMemory(true)} className={projectWorkPrimaryBtnClass}>
          + Új emlék
        </button>
      ) : null}
      {showNewMemory ? (
        <div className="rounded-xl border border-ink/10 bg-white/50 p-4 shadow-sm">
          <p className="font-medium text-ink">Új emlék</p>
          <p className="text-xs text-ink-soft">
            {projectName} · {agentName} · azonnal bekerül, verzióval és naplóval.
          </p>
          <MemoryEditor
            draft={newDraft}
            onChange={setNewDraft}
            onSubmit={() => void onSaveMemory()}
            onCancel={() => {
              setShowNewMemory(false)
              setNewDraft(emptyDraft)
            }}
            busy={saving}
            submitLabel="Emlék mentése"
          />
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-ink-soft">Betöltés…</p>
      ) : !agentId ? (
        <p className="text-sm text-ink-soft">Nincs munkatárs — a projektmemória munkatársonként él.</p>
      ) : visibleMemories.length === 0 ? (
        <p className="text-sm text-ink-soft">
          {memories.length === 0
            ? 'Ehhez a projekthez ennél a munkatársnál még nincs projektmemória.'
            : 'A keresésnek nincs találata.'}
        </p>
      ) : (
        <ul className="space-y-3">
          {visibleMemories.map((item) => {
            const meta = MEMORY_KIND_META[item.kind] ?? {
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
              <li key={item.id} className="rounded-xl border border-ink/10 bg-white/50 p-4 shadow-sm">
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
                <p className="mt-2 text-xs text-ink-faint">Beszélgetőpartner: {item.withUserName}</p>
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
                    busy={saving}
                    submitLabel="Változások mentése"
                  />
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export function AgentProjectMemoryBrowser({
  agentId,
  agentName,
  projects,
  canEdit,
  initialError,
}: {
  agentId: string
  agentName: string
  projects: ProjectListItem[]
  canEdit: boolean
  initialError: string | null
}) {
  const [projectKey, setProjectKey] = useState(projects[0]?.key ?? GENERAL_WORK_PROJECT_KEY)
  const selected = projects.find((p) => p.key === projectKey)

  return (
    <div className="space-y-4">
      {initialError ? (
        <p className="rounded-lg border border-coral/35 bg-coral/10 px-3 py-2 text-sm text-coral-deep">
          {projectWorkErrorLabel(initialError)}
        </p>
      ) : null}
      {!canEdit ? (
        <p className="rounded-lg border border-ink/10 bg-white/40 px-3 py-2 text-sm text-ink-soft">
          Nézegetni szabad; íráshoz és szerkesztéshez jóváhagyói szerep kell.
        </p>
      ) : null}
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <ProjectPickerNav projects={projects} projectKey={projectKey} onSelect={setProjectKey} />
        <div className="min-w-0 flex-1">
          <ProjectMemoryPanel
            key={`${agentId}:${projectKey}`}
            agentId={agentId}
            agentName={agentName}
            projectKey={projectKey}
            projectName={selected?.name}
            canEdit={canEdit}
          />
        </div>
      </div>
    </div>
  )
}
