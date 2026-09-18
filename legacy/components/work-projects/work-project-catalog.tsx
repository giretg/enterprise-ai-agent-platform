'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { archiveWorkProject, createWorkProject, updateWorkProject } from '@/app/actions/work-projects'
import { slugifyWorkProjectKey } from '@/lib/work-project'
import { Card } from '@/components/ui/shell'

export type WorkProjectCatalogItem = {
  id: string | null
  key: string
  name: string
  description: string | null
  builtin: boolean
  archived?: boolean
}

export function WorkProjectCatalog({
  projects,
  canEdit,
}: {
  projects: WorkProjectCatalogItem[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')

  const previewKey = slugifyWorkProjectKey(name)

  function handleCreate() {
    startTransition(async () => {
      setError(null)
      const res = await createWorkProject({
        name: name.trim(),
        description: description.trim() || undefined,
      })
      if (res.success) {
        setName('')
        setDescription('')
        router.refresh()
      } else {
        setError(res.error)
      }
    })
  }

  function handleArchive(project: WorkProjectCatalogItem, archived: boolean) {
    if (!project.id) return
    startTransition(async () => {
      setError(null)
      const res = await archiveWorkProject({ id: project.id!, archived })
      if (res.success) router.refresh()
      else setError(res.error)
    })
  }

  function startEdit(project: WorkProjectCatalogItem) {
    if (!project.id) return
    setEditingId(project.id)
    setEditName(project.name)
    setEditDescription(project.description ?? '')
    setError(null)
  }

  function handleSave() {
    if (!editingId) return
    startTransition(async () => {
      setError(null)
      const res = await updateWorkProject({
        id: editingId,
        name: editName.trim(),
        description: editDescription.trim() || undefined,
      })
      if (res.success) {
        setEditingId(null)
        router.refresh()
      } else {
        setError(res.error)
      }
    })
  }

  return (
    <div className="space-y-6">
      {canEdit ? (
        <Card title="Új projekt">
          <p className="mb-3 text-sm text-ink-soft">
            Adj nevet a munkának. A kulcs ebből készül — ez köti össze a beszélgetéseket és az
            emlékeket. Létrehozás után a kulcs nem változik.
          </p>
          {error && !editingId ? <p className="mb-3 text-xs text-coral">{error}</p> : null}
          <div className="space-y-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Projekt neve — pl. Ingatlan adásvétel"
              className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm"
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Rövid leírás (nem kötelező) — miről szól ez a munka, kik tartoznak hozzá"
              rows={3}
              className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm"
            />
            <p className="text-xs text-ink-faint">
              Kulcs:{' '}
              <code className="rounded bg-night-2 px-1.5 py-0.5">
                {previewKey || '—'}
              </code>
            </p>
            <button
              type="button"
              disabled={pending || name.trim().length === 0}
              onClick={handleCreate}
              className="rounded-full bg-coral px-4 py-1.5 text-sm font-semibold text-card disabled:opacity-50"
            >
              Projekt létrehozása
            </button>
          </div>
        </Card>
      ) : null}

      <Card title="Meghatározott projektek">
        {error && editingId ? <p className="mb-3 text-xs text-coral">{error}</p> : null}
        <ul className="space-y-3">
          {projects.map((project) => (
            <li key={project.key} className="rounded-lg border border-line bg-night-2/40 p-3">
              {editingId && editingId === project.id ? (
                <div className="space-y-2">
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm"
                  />
                  <textarea
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    rows={2}
                    className="w-full rounded-lg border border-line bg-card px-3 py-2 text-sm"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={handleSave}
                      className="rounded-full bg-sage/20 px-3 py-1 text-xs font-semibold text-sage"
                    >
                      Mentés
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => setEditingId(null)}
                      className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft"
                    >
                      Mégse
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-ink">
                      {project.name}
                      {project.builtin ? (
                        <span className="ml-2 rounded-full bg-ink/8 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                          beépített
                        </span>
                      ) : null}
                      {project.archived ? (
                        <span className="ml-2 rounded-full bg-honey/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-honey">
                          archivált
                        </span>
                      ) : null}
                    </p>
                    {project.description ? (
                      <p className="mt-1 text-sm text-ink-soft">{project.description}</p>
                    ) : null}
                    {project.builtin ? null : (
                      <p className="mt-1 text-xs text-ink-faint">
                        kulcs: <code>{project.key}</code>
                      </p>
                    )}
                  </div>
                  {canEdit && project.id ? (
                    <span className="flex gap-2">
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => startEdit(project)}
                        className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft hover:bg-line/30"
                      >
                        Szerkesztés
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => handleArchive(project, !project.archived)}
                        className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft hover:bg-line/30"
                      >
                        {project.archived ? 'Visszaállítás' : 'Archiválás'}
                      </button>
                    </span>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
