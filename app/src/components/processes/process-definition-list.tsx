'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  archiveProcessDefinition,
  attachProcessTrigger,
  detachProcessTrigger,
  listAssignableProcessUsers,
  listSuitableAgentsForVersion,
  replaceActiveProcessDefinition,
  updateProcessDefinitionBindings,
} from '@/app/actions/process'
import { agentDisplayName } from '@/lib/agent-persona'
import type { ProcessBuilderPlaybookVersion } from './process-definition-builder'

export type ProcessDefinitionListItem = {
  id: string
  name: string
  status: string
  playbookVersionId: string
  roleBindings: unknown
  updatedAt: string
  triggers: { id: string; type: string; enabled: boolean; inputMap: unknown; monitorDefinitionId: string | null }[]
}

const DEF_TONE: Record<string, string> = {
  draft: 'bg-ink/8 text-ink-soft',
  active: 'bg-sage/15 text-sage',
  archived: 'bg-ink/8 text-ink-soft',
}

type TriggerType = 'manual' | 'ticket' | 'chat' | 'monitor_cron'

export function ProcessDefinitionList({
  definitions,
  playbookVersions,
  canEditDraft,
  canArchive,
}: {
  definitions: ProcessDefinitionListItem[]
  playbookVersions: ProcessBuilderPlaybookVersion[]
  canEditDraft: boolean
  canArchive: boolean
}) {
  const [editingId, setEditingId] = useState<string | null>(null)

  return (
    <ul className="divide-y divide-ink/8">
      {definitions.map((d) => {
        const version = playbookVersions.find((v) => v.playbookVersionId === d.playbookVersionId)
        const editable = canEditDraft && (d.status === 'draft' || d.status === 'active')
        const archivable = canArchive && d.status !== 'archived'
        return (
          <li key={d.id} className="py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-medium">{d.name}</span>
                <span className="ml-2 font-mono text-xs text-ink-soft">{d.id}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-ink-soft">{new Date(d.updatedAt).toLocaleString('hu-HU')}</span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    DEF_TONE[d.status] ?? 'bg-ink/8 text-ink-soft'
                  }`}
                >
                  {d.status}
                </span>
                {editable && (
                  <button
                    type="button"
                    onClick={() => setEditingId((current) => (current === d.id ? null : d.id))}
                    className="rounded-lg border border-ink/15 px-3 py-1 text-xs font-medium"
                  >
                    {editingId === d.id ? 'Bezárás' : 'Szerkesztés'}
                  </button>
                )}
                {archivable && <ArchiveButton id={d.id} />}
              </div>
            </div>
            {editingId === d.id &&
              (version ? (
                <ProcessDefinitionEditForm
                  definition={d}
                  version={version}
                  replaceMode={d.status === 'active'}
                  onClose={() => setEditingId(null)}
                />
              ) : (
                <p className="mt-3 text-sm text-coral">
                  A PIN-elt Playbook-verzió nem található — a Folyamat nem szerkeszthető.
                </p>
              ))}
          </li>
        )
      })}
      {definitions.length === 0 && <li className="py-3 text-sm text-ink-soft">Még nincs Folyamat.</li>}
    </ul>
  )
}

function ArchiveButton({ id }: { id: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function onArchive() {
    if (!window.confirm('Biztosan leállítod (archiválod) ezt a Folyamatot? A művelet nem visszavonható.')) return
    setError(null)
    startTransition(async () => {
      const res = await archiveProcessDefinition({ id })
      if (!res.success) {
        setError(res.error)
        return
      }
      router.refresh()
    })
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onArchive}
        disabled={pending}
        className="rounded-lg border border-coral/30 px-3 py-1 text-xs font-medium text-coral disabled:opacity-50"
      >
        {pending ? 'Archiválás...' : 'Leállítás'}
      </button>
      {error && <span className="text-xs text-coral">{error}</span>}
    </div>
  )
}

function ProcessDefinitionEditForm({
  definition,
  version,
  replaceMode,
  onClose,
}: {
  definition: ProcessDefinitionListItem
  version: ProcessBuilderPlaybookVersion
  replaceMode: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const existingBindings = definition.roleBindings as Record<string, string>
  const [roleBindings, setRoleBindings] = useState<Record<string, string>>(existingBindings ?? {})
  const [suitableAgents, setSuitableAgents] = useState<
    Record<string, { id: string; name: string; personaNickname?: string | null; role: string }[]>
  >(
    {},
  )
  const [assignableUsers, setAssignableUsers] = useState<{ id: string; name: string; email: string; role: string }[]>(
    [],
  )
  const existingTrigger = definition.triggers[0]
  const [triggerType, setTriggerType] = useState<TriggerType>((existingTrigger?.type as TriggerType) ?? 'manual')
  const [monitorDefinitionId, setMonitorDefinitionId] = useState(existingTrigger?.monitorDefinitionId ?? '')
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const res = await listSuitableAgentsForVersion({ playbookVersionId: version.playbookVersionId })
      if (!cancelled && res.success) setSuitableAgents(res.data)
      const usersRes = await listAssignableProcessUsers()
      if (usersRes.success && !cancelled) setAssignableUsers(usersRes.data)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [version])

  function triggerInputMapForSubmit() {
    if (existingTrigger && existingTrigger.type === triggerType) {
      return (existingTrigger.inputMap as Record<string, unknown> | undefined) ?? {}
    }
    return {}
  }

  function submit() {
    if (
      replaceMode &&
      !window.confirm(
        'Mentéskor új Folyamat jön létre a módosításokkal, a jelenlegi aktív példány leáll (archiválódik). A már futó Futások érintetlenek maradnak. Folytatod?',
      )
    ) {
      return
    }

    setMessage(null)
    startTransition(async () => {
      if (replaceMode) {
        const replaced = await replaceActiveProcessDefinition({
          id: definition.id,
          roleBindings,
          configValues: {},
          triggerType,
          triggerInputMap: triggerInputMapForSubmit(),
          monitorDefinitionId:
            triggerType === 'monitor_cron' && monitorDefinitionId.trim() ? monitorDefinitionId : null,
        })
        if (!replaced.success) {
          setMessage({ tone: 'err', text: replaced.error })
          return
        }
        setMessage({ tone: 'ok', text: replaced.data.message })
        onClose()
        router.refresh()
        return
      }

      const updated = await updateProcessDefinitionBindings({
        id: definition.id,
        roleBindings,
        configValues: {},
      })
      if (!updated.success) {
        setMessage({ tone: 'err', text: updated.error })
        return
      }

      if (existingTrigger && existingTrigger.type !== triggerType) {
        const detached = await detachProcessTrigger({
          processDefinitionId: definition.id,
          triggerId: existingTrigger.id,
        })
        if (!detached.success) {
          setMessage({ tone: 'err', text: detached.error })
          return
        }
        const attached = await attachProcessTrigger({
          processDefinitionId: definition.id,
          type: triggerType,
          inputMap: existingTrigger.inputMap ?? {},
          monitorDefinitionId: triggerType === 'monitor_cron' && monitorDefinitionId.trim() ? monitorDefinitionId : null,
        })
        if (!attached.success) {
          setMessage({ tone: 'err', text: attached.error })
          return
        }
      } else if (!existingTrigger) {
        const attached = await attachProcessTrigger({
          processDefinitionId: definition.id,
          type: triggerType,
          inputMap: {},
          monitorDefinitionId: triggerType === 'monitor_cron' && monitorDefinitionId.trim() ? monitorDefinitionId : null,
        })
        if (!attached.success) {
          setMessage({ tone: 'err', text: attached.error })
          return
        }
      }

      setMessage({ tone: 'ok', text: 'Mentve.' })
      router.refresh()
    })
  }

  return (
    <div className="mt-3 rounded-lg border border-ink/10 p-4">
      {replaceMode && (
        <p className="mb-3 rounded-lg border border-honey/30 bg-honey/10 px-3 py-2 text-sm text-ink">
          Aktív Folyamat — a mentés új példányt hoz létre, a jelenlegi leáll. A futó Futások nem állnak le.
        </p>
      )}
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-soft">Szerep-kötések</p>
      <div className="mt-2 space-y-3">
        {version.agentRoles.map((role) => (
          <label key={role.key} className="block text-sm">
            <span className="mb-1 block text-ink-soft">{role.key}</span>
            <select
              value={roleBindings[role.key] ?? ''}
              onChange={(event) => setRoleBindings((current) => ({ ...current, [role.key]: event.target.value }))}
              className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
            >
              <option value="">Válassz agentet</option>
              {(suitableAgents[role.key] ?? []).map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agentDisplayName(agent.name, agent)} - {agent.role}
                </option>
              ))}
            </select>
          </label>
        ))}
        {version.humanRoles.map((role) => (
          <label key={role.key} className="block text-sm">
            <span className="mb-1 block text-ink-soft">{role.key}</span>
            <select
              value={roleBindings[role.key] ?? ''}
              onChange={(event) => setRoleBindings((current) => ({ ...current, [role.key]: event.target.value }))}
              className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
            >
              <option value="">Válassz usert</option>
              {assignableUsers.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name} - {user.email} - {user.role}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <div className="mt-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-soft">Trigger</p>
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-ink-soft">Típus</span>
            <select
              value={triggerType}
              onChange={(event) => setTriggerType(event.target.value as TriggerType)}
              className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
            >
              <option value="manual">manual</option>
              <option value="ticket">ticket</option>
              <option value="chat">chat</option>
              <option value="monitor_cron">monitor_cron</option>
            </select>
          </label>
          {triggerType === 'monitor_cron' && (
            <label className="block text-sm">
              <span className="mb-1 block text-ink-soft">MonitorDefinition ID</span>
              <input
                value={monitorDefinitionId}
                onChange={(event) => setMonitorDefinitionId(event.target.value)}
                className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 font-mono text-xs"
              />
            </label>
          )}
        </div>
      </div>

      {message && (
        <p className={`mt-3 text-sm ${message.tone === 'ok' ? 'text-sage' : 'text-coral'}`}>{message.text}</p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? 'Mentés...' : replaceMode ? 'Mentés és csere' : 'Mentés'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-ink/15 px-4 py-2 text-sm font-medium"
        >
          Mégse
        </button>
      </div>
    </div>
  )
}
