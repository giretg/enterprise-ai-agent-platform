'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import {
  activateProcessDefinition,
  attachProcessTrigger,
  createProcessDefinition,
  listAssignableProcessUsers,
  listSuitableAgents,
  updateProcessDefinitionBindings,
} from '@/app/actions/process'

export type ProcessBuilderPlaybookVersion = {
  playbookId: string
  playbookName: string
  processType: string
  playbookVersionId: string
  version: number
  agentRoles: { key: string; requiredCapabilities: string[] }[]
  humanRoles: { key: string; requiredPermissions: string[] }[]
  configSlots: { name: string; type: string; required: boolean; description: string | null }[]
  triggerSlots: { name: string; type: string; required: boolean; description: string | null }[]
}

type SuitableAgent = {
  id: string
  name: string
  status: string
  role: string
}

type AssignableUser = {
  id: string
  name: string
  email: string
  role: string
}

type TriggerType = 'manual' | 'ticket' | 'chat' | 'monitor_cron'

function initialName(version?: ProcessBuilderPlaybookVersion) {
  return version ? `${version.playbookName} Folyamat` : ''
}

function initialChatSlotNames(version?: ProcessBuilderPlaybookVersion) {
  return (version?.triggerSlots ?? []).map((slot) => slot.name).join(', ')
}

function initialTicketFieldMapJson(version?: ProcessBuilderPlaybookVersion) {
  return JSON.stringify(
    {
      fieldMap: Object.fromEntries((version?.triggerSlots ?? []).map((slot) => [slot.name, `payload.${slot.name}`])),
    },
    null,
    2,
  )
}

function initialMonitorContextMapJson(version?: ProcessBuilderPlaybookVersion) {
  return JSON.stringify(
    {
      contextMap: Object.fromEntries(
        (version?.triggerSlots ?? []).map((slot) => [slot.name, slot.name === 'now' ? 'now()' : `payload.${slot.name}`]),
      ),
    },
    null,
    2,
  )
}

export function ProcessDefinitionBuilder({
  playbookVersions,
}: {
  playbookVersions: ProcessBuilderPlaybookVersion[]
}) {
  const [pending, startTransition] = useTransition()
  const [selectedVersionId, setSelectedVersionId] = useState(playbookVersions[0]?.playbookVersionId ?? '')
  const initialVersion = playbookVersions[0]
  const selectedVersion = useMemo(
    () => playbookVersions.find((version) => version.playbookVersionId === selectedVersionId),
    [playbookVersions, selectedVersionId],
  )
  const [name, setName] = useState(initialName(initialVersion))
  const [description, setDescription] = useState('')
  const [roleBindings, setRoleBindings] = useState<Record<string, string>>({})
  const [suitableAgents, setSuitableAgents] = useState<Record<string, SuitableAgent[]>>({})
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([])
  const [agentLoadError, setAgentLoadError] = useState<string | null>(null)
  const [userLoadError, setUserLoadError] = useState<string | null>(null)
  const [triggerType, setTriggerType] = useState<TriggerType>('manual')
  const [ticketFieldMapJson, setTicketFieldMapJson] = useState(initialTicketFieldMapJson(initialVersion))
  const [chatSlotNames, setChatSlotNames] = useState(initialChatSlotNames(initialVersion))
  const [monitorContextMapJson, setMonitorContextMapJson] = useState(initialMonitorContextMapJson(initialVersion))
  const [monitorDefinitionId, setMonitorDefinitionId] = useState('')
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string; id?: string } | null>(null)

  function selectVersion(versionId: string) {
    const version = playbookVersions.find((candidate) => candidate.playbookVersionId === versionId)
    setSelectedVersionId(versionId)
    setName(initialName(version))
    setDescription('')
    setRoleBindings({})
    setChatSlotNames(initialChatSlotNames(version))
    setTicketFieldMapJson(initialTicketFieldMapJson(version))
    setMonitorContextMapJson(initialMonitorContextMapJson(version))
    setMessage(null)
  }

  useEffect(() => {
    let cancelled = false
    async function loadSuitableAgents() {
      if (!selectedVersion) return
      setAgentLoadError(null)
      const next: Record<string, SuitableAgent[]> = {}
      for (const role of selectedVersion.agentRoles) {
        const res = await listSuitableAgents({
          playbookVersionId: selectedVersion.playbookVersionId,
          roleKey: role.key,
        })
        if (!res.success) {
          if (!cancelled) setAgentLoadError(res.error)
          return
        }
        next[role.key] = res.data
      }
      if (!cancelled) setSuitableAgents(next)
    }
    void loadSuitableAgents()
    return () => {
      cancelled = true
    }
  }, [selectedVersion])

  useEffect(() => {
    let cancelled = false
    async function loadUsers() {
      setUserLoadError(null)
      const res = await listAssignableProcessUsers()
      if (!res.success) {
        if (!cancelled) setUserLoadError(res.error)
        return
      }
      if (!cancelled) setAssignableUsers(res.data)
    }
    void loadUsers()
    return () => {
      cancelled = true
    }
  }, [])

  function parseJson(value: string, label: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(value || '{}')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setMessage({ tone: 'err', text: `${label} csak JSON objektum lehet.` })
        return null
      }
      return parsed as Record<string, unknown>
    } catch {
      setMessage({ tone: 'err', text: `${label} nem érvényes JSON.` })
      return null
    }
  }

  function buildTriggerInputMap(): Record<string, unknown> | null {
    if (triggerType === 'manual') return {}
    if (triggerType === 'ticket') return parseJson(ticketFieldMapJson, 'Ticket fieldMap')
    if (triggerType === 'monitor_cron') return parseJson(monitorContextMapJson, 'Monitor contextMap')
    return {
      slotNames: chatSlotNames
        .split(',')
        .map((slot) => slot.trim())
        .filter(Boolean),
    }
  }

  function submit(activate: boolean) {
    setMessage(null)
    if (!selectedVersion) {
      setMessage({ tone: 'err', text: 'Válassz publikált Playbook-verziót.' })
      return
    }
    if (selectedVersion.agentRoles.some((role) => !roleBindings[role.key])) {
      setMessage({ tone: 'err', text: 'Minden agent-szerephez válassz alkalmas agentet.' })
      return
    }
    if (selectedVersion.humanRoles.some((role) => !roleBindings[role.key])) {
      setMessage({ tone: 'err', text: 'Minden emberi szerephez válassz usert.' })
      return
    }
    const inputMap = buildTriggerInputMap()
    if (!inputMap) return

    startTransition(async () => {
      const created = await createProcessDefinition({
        name,
        description: description.trim() ? description : null,
        playbookVersionId: selectedVersion.playbookVersionId,
      })
      if (!created.success) {
        setMessage({ tone: 'err', text: created.error })
        return
      }

      const updated = await updateProcessDefinitionBindings({
        id: created.data.id,
        roleBindings,
        configValues: {},
      })
      if (!updated.success) {
        setMessage({ tone: 'err', text: updated.error })
        return
      }

      const trigger = await attachProcessTrigger({
        processDefinitionId: created.data.id,
        type: triggerType,
        inputMap,
        monitorDefinitionId: triggerType === 'monitor_cron' && monitorDefinitionId.trim() ? monitorDefinitionId : null,
      })
      if (!trigger.success) {
        setMessage({ tone: 'err', text: trigger.error, id: created.data.id })
        return
      }

      if (activate) {
        const activated = await activateProcessDefinition({ id: created.data.id })
        if (!activated.success) {
          setMessage({ tone: 'err', text: activated.error, id: created.data.id })
          return
        }
      }

      setMessage({
        tone: 'ok',
        text: activate ? 'Folyamat létrehozva és aktiválva.' : 'Folyamat-draft létrehozva.',
        id: created.data.id,
      })
    })
  }

  if (playbookVersions.length === 0) {
    return <p className="text-sm text-ink-soft">Nincs publikált Playbook-verzió.</p>
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Publikált Playbook-verzió</span>
          <select
            value={selectedVersionId}
            onChange={(event) => selectVersion(event.target.value)}
            className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
          >
            {playbookVersions.map((version) => (
              <option key={version.playbookVersionId} value={version.playbookVersionId}>
                {version.playbookName} @v{version.version} - {version.processType}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Folyamat neve</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
          />
        </label>
      </div>

      <label className="block text-sm">
        <span className="mb-1 block text-ink-soft">Leírás</span>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={2}
          className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
        />
      </label>

      {selectedVersion && (
        <div className="grid gap-4">
          <div className="rounded-lg border border-ink/10 p-4">
            <h3 className="font-semibold">Szerep-kötések</h3>
            {agentLoadError && <p className="mt-2 text-sm text-coral">{agentLoadError}</p>}
            {userLoadError && <p className="mt-2 text-sm text-coral">{userLoadError}</p>}
            <div className="mt-3 space-y-3">
              {selectedVersion.agentRoles.length > 0 && (
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-soft">Agent szerepek</p>
              )}
              {selectedVersion.agentRoles.map((role) => {
                const agents = suitableAgents[role.key] ?? []
                return (
                  <label key={role.key} className="block text-sm">
                    <span className="mb-1 flex flex-wrap items-center justify-between gap-2 text-ink-soft">
                      <span>{role.key}</span>
                      {role.requiredCapabilities.length > 0 && (
                        <span className="font-mono text-[11px]">{role.requiredCapabilities.join(', ')}</span>
                      )}
                    </span>
                    <select
                      value={roleBindings[role.key] ?? ''}
                      onChange={(event) =>
                        setRoleBindings((current) => ({ ...current, [role.key]: event.target.value }))
                      }
                      className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
                    >
                      <option value="">Válassz agentet</option>
                      {agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name} - {agent.role}
                        </option>
                      ))}
                    </select>
                    {agents.length === 0 && (
                      <Link href="/control-plane/agents" className="mt-1 inline-block text-xs text-coral underline">
                        Nincs alkalmas agent
                      </Link>
                    )}
                  </label>
                )
              })}
              {selectedVersion.humanRoles.length > 0 && (
                <p className="pt-2 text-xs font-semibold uppercase tracking-[0.16em] text-ink-soft">
                  Emberi szerepek
                </p>
              )}
              {selectedVersion.humanRoles.map((role) => (
                <label key={role.key} className="block text-sm">
                  <span className="mb-1 flex flex-wrap items-center justify-between gap-2 text-ink-soft">
                    <span>{role.key}</span>
                    {role.requiredPermissions.length > 0 && (
                      <span className="font-mono text-[11px]">{role.requiredPermissions.join(', ')}</span>
                    )}
                  </span>
                  <select
                    value={roleBindings[role.key] ?? ''}
                    onChange={(event) =>
                      setRoleBindings((current) => ({ ...current, [role.key]: event.target.value }))
                    }
                    className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
                  >
                    <option value="">Válassz usert</option>
                    {assignableUsers.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name} - {user.email} - {user.role}
                      </option>
                    ))}
                  </select>
                  {assignableUsers.length === 0 && (
                    <Link href="/control-plane/iam" className="mt-1 inline-block text-xs text-coral underline">
                      Nincs aktív hozzárendelhető user
                    </Link>
                  )}
                </label>
              ))}
              {selectedVersion.agentRoles.length === 0 && selectedVersion.humanRoles.length === 0 && (
                <p className="text-sm text-ink-soft">Ez a Playbook nem deklarál szerepet.</p>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-ink/10 p-4">
        <h3 className="font-semibold">Trigger</h3>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
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

        {triggerType === 'ticket' && (
          <label className="mt-3 block text-sm">
            <span className="mb-1 block text-ink-soft">Ticket inputMap JSON</span>
            <textarea
              value={ticketFieldMapJson}
              onChange={(event) => setTicketFieldMapJson(event.target.value)}
              rows={5}
              spellCheck={false}
              className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 font-mono text-xs"
            />
          </label>
        )}
        {triggerType === 'chat' && (
          <label className="mt-3 block text-sm">
            <span className="mb-1 block text-ink-soft">Chat slotok</span>
            <input
              value={chatSlotNames}
              onChange={(event) => setChatSlotNames(event.target.value)}
              className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 font-mono text-xs"
            />
          </label>
        )}
        {triggerType === 'monitor_cron' && (
          <label className="mt-3 block text-sm">
            <span className="mb-1 block text-ink-soft">Monitor contextMap JSON</span>
            <textarea
              value={monitorContextMapJson}
              onChange={(event) => setMonitorContextMapJson(event.target.value)}
              rows={5}
              spellCheck={false}
              className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 font-mono text-xs"
            />
          </label>
        )}
      </div>

      {message && (
        <p className={`text-sm ${message.tone === 'ok' ? 'text-sage' : 'text-coral'}`}>
          {message.text}
          {message.id && (
            <>
              {' '}
              <span className="font-mono text-xs">{message.id}</span>
            </>
          )}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => submit(false)}
          disabled={pending}
          className="rounded-lg border border-ink/15 px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {pending ? 'Mentés...' : 'Draft mentése'}
        </button>
        <button
          type="button"
          onClick={() => submit(true)}
          disabled={pending}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? 'Aktiválás...' : 'Mentés és aktiválás'}
        </button>
      </div>
    </div>
  )
}
