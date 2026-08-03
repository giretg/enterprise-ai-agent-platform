'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import { WorkspaceFileDropzone } from '@/components/workspace/workspace-file-dropzone'

/**
 * Korlátozott feladatkörű agent (#199) skill-kötött indító űrlapja.
 *
 * Közös a board „Új feladat” űrlap és az agent oldali feladat-gomb modálja között —
 * szándékosan NEM a normál board-űrlap része, hogy a két út ne keveredjen feltételekkel.
 */

export type LaunchableSkill = {
  skillVersionId: string
  name: string
  description: string
  parameters: Array<{ name: string; description: string }>
  allowAttachments: boolean
  attachmentDescription?: string
}

type AgentSkillRow = {
  enabled: boolean
  skillId: string
  skillVersionId: string
  name: string
  description: string
  readiness: { color: string }
  parameters: Array<{ name: string; description: string }>
  allowAttachments: boolean
  attachmentDescription?: string
}

type PendingFile = { id: string; file: File }

function makePendingFile(file: File): PendingFile {
  return { id: `${file.name}-${file.size}-${file.lastModified}`, file }
}

/** Csak a ténylegesen futtatható skillek: engedélyezve + zöld readiness. */
export function filterLaunchableSkills(rows: AgentSkillRow[]): LaunchableSkill[] {
  const bySkill = new Map<string, LaunchableSkill>()
  for (const row of rows) {
    if (!row.enabled || row.readiness.color !== 'green') continue
    if (bySkill.has(row.skillId)) continue
    bySkill.set(row.skillId, {
      skillVersionId: row.skillVersionId,
      name: row.name,
      description: row.description,
      parameters: row.parameters,
      allowAttachments: row.allowAttachments,
      attachmentDescription: row.attachmentDescription,
    })
  }
  return [...bySkill.values()]
}

export type TaskOnlyLaunchSubmitInput = {
  skillVersionId: string
  skillParameterValues: Record<string, string>
  files: File[]
}

export function TaskOnlyLaunchForm({
  skills,
  pending,
  message,
  submitLabel,
  pendingLabel = 'Létrehozás…',
  onCancel,
  onSubmit,
  cancelDisabled,
  onSelectedSkillChange,
  initialFocusRef,
}: {
  skills: LaunchableSkill[]
  pending: boolean
  message: string | null
  submitLabel: string
  pendingLabel?: string
  onCancel: () => void
  onSubmit: (input: TaskOnlyLaunchSubmitInput) => void
  cancelDisabled?: boolean
  onSelectedSkillChange?: (skill: LaunchableSkill | undefined) => void
  /** Modál megnyitásakor ide kerül a fókusz (Escape / a11y). */
  initialFocusRef?: RefObject<HTMLButtonElement | null>
}) {
  const [selectedId, setSelectedId] = useState(skills[0]?.skillVersionId ?? '')
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const submitRef = useRef<HTMLButtonElement>(null)

  const selected = skills.find((s) => s.skillVersionId === selectedId) ?? skills[0]

  useEffect(() => {
    if (initialFocusRef) initialFocusRef.current = submitRef.current
    submitRef.current?.focus()
  }, [initialFocusRef])

  useEffect(() => {
    onSelectedSkillChange?.(selected)
  }, [selected, onSelectedSkillChange])

  useEffect(() => {
    setSelectedId(skills[0]?.skillVersionId ?? '')
    setParamValues({})
    setPendingFiles([])
  }, [skills])

  const addPendingFile = (file: File) => {
    setPendingFiles((prev) => {
      const next = makePendingFile(file)
      if (prev.some((item) => item.id === next.id)) return prev
      return [...prev, next]
    })
  }

  const selectSkill = (skillVersionId: string) => {
    setSelectedId(skillVersionId)
    setParamValues({})
    const next = skills.find((s) => s.skillVersionId === skillVersionId)
    if (next && !next.allowAttachments) setPendingFiles([])
  }

  const handleSubmit = () => {
    if (!selected) return
    const localFiles = selected.allowAttachments ? pendingFiles.map((item) => item.file) : []
    const values: Record<string, string> = {}
    for (const param of selected.parameters) {
      const raw = paramValues[param.name]
      if (typeof raw === 'string' && raw.trim()) values[param.name] = raw.trim()
    }
    onSubmit({
      skillVersionId: selected.skillVersionId,
      skillParameterValues: values,
      files: localFiles,
    })
  }

  if (skills.length === 0) {
    return (
      <p className="text-sm text-ink-faint">
        Ehhez az agenthez nincs futtatható skill hozzárendelve — szólj az adminnak.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {selected && (
        <>
          {selected.description && (
            <p className="text-sm text-ink-soft">{selected.description}</p>
          )}
          <p className="text-xs text-ink-faint">
            Ez az agent korlátozott feladatkörű: a feladat leírását nem kell megírnod — a
            munkamenetet a skill tartalmazza.
          </p>
        </>
      )}

      {skills.length > 1 && (
        <div>
          <label htmlFor="task-only-skill" className="text-sm font-medium text-ink-soft">
            Melyik feladat?
          </label>
          <select
            id="task-only-skill"
            value={selected?.skillVersionId ?? ''}
            disabled={pending}
            onChange={(e) => selectSkill(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
          >
            {skills.map((skill) => (
              <option key={skill.skillVersionId} value={skill.skillVersionId}>
                {skill.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {selected && selected.parameters.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-medium text-ink-soft">
            Kiegészítő adatok <span className="font-normal text-ink-faint">(opcionális)</span>
          </p>
          {selected.parameters.map((param) => (
            <div key={param.name}>
              <label htmlFor={`task-only-param-${param.name}`} className="text-sm text-ink-soft">
                {param.name}
              </label>
              {param.description && <p className="text-xs text-ink-faint">{param.description}</p>}
              <input
                id={`task-only-param-${param.name}`}
                value={paramValues[param.name] ?? ''}
                disabled={pending}
                maxLength={2000}
                onChange={(e) =>
                  setParamValues((prev) => ({ ...prev, [param.name]: e.target.value }))
                }
                className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
              />
            </div>
          ))}
        </div>
      )}

      {selected?.allowAttachments && (
        <div>
          {selected.attachmentDescription && (
            <p className="mb-2 text-sm text-ink-soft">{selected.attachmentDescription}</p>
          )}
          <p className="text-sm font-medium text-ink-soft">
            Fájlok <span className="font-normal text-ink-faint">(opcionális)</span>
          </p>
          <div className="mt-2">
            <WorkspaceFileDropzone
              disabled={pending}
              uploading={pending}
              onFileSelected={addPendingFile}
            />
          </div>
          {pendingFiles.length > 0 ? (
            <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
              {pendingFiles.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="truncate text-sm text-ink" title={item.file.name}>
                    {item.file.name}
                  </span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      setPendingFiles((prev) => prev.filter((f) => f.id !== item.id))
                    }
                    className="shrink-0 text-sm text-coral hover:underline disabled:opacity-50"
                  >
                    Eltávolítás
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-ink-faint">Még nincs csatolt fájl.</p>
          )}
        </div>
      )}

      {message && (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-sm text-coral">
          {message}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          ref={submitRef}
          type="button"
          disabled={pending}
          onClick={handleSubmit}
          className="rounded-lg bg-coral px-4 py-2 text-sm font-medium text-white transition hover:bg-coral-deep disabled:opacity-60"
        >
          {pending ? pendingLabel : submitLabel}
        </button>
        <button
          type="button"
          disabled={pending || cancelDisabled}
          onClick={onCancel}
          className="rounded-lg border border-line px-4 py-2 text-sm text-ink-soft transition hover:bg-night-2 disabled:opacity-50"
        >
          Mégse
        </button>
      </div>
    </div>
  )
}
