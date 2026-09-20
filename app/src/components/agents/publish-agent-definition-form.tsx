'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import {
  activateAgent,
  publishAgentDefinitionAction,
  resumeAgent,
  suspendAgent,
} from '@/app/actions/platform'
import { Card } from '@/components/ui/shell'

type AgentStatus = 'draft' | 'active' | 'suspended' | 'retired'

const MCP_OFF_REASON = 'MCP-ről levétel'

export function PublishAgentDefinitionForm({
  agentId,
  currentDefinitionId,
  status = 'draft',
  goLive = false,
  wizard = false,
  canEdit = true,
  bare = false,
  onChanged,
}: {
  agentId: string
  currentDefinitionId: string | null
  status?: AgentStatus
  /** Használható kapcsoló: közzététel + aktiválás, lekapcsolva felfüggesztés. */
  goLive?: boolean
  wizard?: boolean
  canEdit?: boolean
  bare?: boolean
  onChanged?: (next: { definitionId: string | null; status: AgentStatus }) => void
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [definitionId, setDefinitionId] = useState(currentDefinitionId)
  const [agentStatus, setAgentStatus] = useState(status)
  const live = agentStatus === 'active'
  const retired = agentStatus === 'retired'

  function refresh(next: { definitionId: string | null; status: AgentStatus }) {
    setDefinitionId(next.definitionId)
    setAgentStatus(next.status)
    onChanged?.(next)
    router.refresh()
  }

  const switchBody = (
    <>
      {wizard ? (
        <>
          <p className="text-sm text-ink">
            A vázlat már mentve — név, munkakör, eszközök, skillek és kapcsolatok az előző
            lépéseken rögzültek. Itt nincs külön Mentés.
          </p>
          <p className="mt-2 text-sm text-ink-soft">
            A kapcsoló az MCP-n teszi elérhetővé a munkatársat. Bekapcsolva közzéteszi a
            vázlatot és aktiválja; kikapcsolva levesszük a listáról.
          </p>
        </>
      ) : (
        <p className="text-sm text-ink-soft">
          Bekapcsolva a munkatárs az MCP-n is elérhető. Kikapcsolva levesszük a listáról —
          a vázlat megmarad, bármikor vissza lehet kapcsolni.
        </p>
      )}
      <label className="mt-4 flex items-center gap-3 rounded-lg border border-line bg-paper px-3 py-3">
        <input
          type="checkbox"
          role="switch"
          className="h-4 w-4 accent-coral"
          checked={live}
          disabled={pending || retired || !canEdit}
          onChange={(event) => {
            const on = event.target.checked
            start(async () => {
              setError(null)
              if (!on) {
                const suspended = await suspendAgent({ agentId, reason: MCP_OFF_REASON })
                if (!suspended.success) {
                  setError(suspended.error)
                  return
                }
                refresh({ definitionId, status: suspended.data.status })
                return
              }
              const published = await publishAgentDefinitionAction({ agentId })
              if (!published.success) {
                setError(published.error)
                return
              }
              const nextId = published.data.definitionId
              if (agentStatus === 'suspended') {
                const resumed = await resumeAgent({ agentId })
                if (!resumed.success) {
                  setError(resumed.error)
                  refresh({ definitionId: nextId, status: 'suspended' })
                  return
                }
                refresh({ definitionId: nextId, status: resumed.data.status })
                return
              }
              const activated = await activateAgent({ agentId })
              if (!activated.success) {
                setError(activated.error)
                refresh({ definitionId: nextId, status: 'draft' })
                return
              }
              refresh({ definitionId: nextId, status: activated.data.status })
            })
          }}
        />
        <span>
          <span className="block text-sm font-semibold">Használható az MCP-n</span>
          <span className="block text-xs text-ink-soft">
            {retired
              ? 'Nyugdíjazott munkatárs — nem kapcsolható vissza.'
              : live
                ? 'Látszik az MCP-listán, a közzétett verzió hívható.'
                : pending
                  ? 'Mentés…'
                  : 'Kikapcsolva csak vázlat / felfüggesztve, az MCP nem listázza.'}
          </span>
        </span>
      </label>
      {live && canEdit ? (
        <button
          type="button"
          disabled={pending}
          className="mt-3 rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink-soft disabled:opacity-60"
          onClick={() => {
            start(async () => {
              setError(null)
              const result = await publishAgentDefinitionAction({ agentId })
              if (!result.success) {
                setError(result.error)
                return
              }
              refresh({ definitionId: result.data.definitionId, status: agentStatus })
            })
          }}
        >
          {pending ? 'Közzététel…' : 'Új verzió közzététele'}
        </button>
      ) : null}
      {error ? <p className="mt-2 text-sm text-coral-deep">{error}</p> : null}
    </>
  )

  const publishOnlyBody = (
    <>
      <p className="text-sm text-ink-soft">
        A vázlat folyamatosan mentődik, ahogy szerkeszted. A közzététel ettől külön:
        rögzít egy verziót, amit az MCP olvashat.
      </p>
      <p className="mt-2 text-sm text-ink">
        {definitionId ? 'Van közzétett verzió.' : 'Még nincs közzétett verzió.'}
      </p>
      {canEdit ? (
        <button
          type="button"
          disabled={pending}
          className="mt-3 rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          onClick={() => {
            start(async () => {
              setError(null)
              const result = await publishAgentDefinitionAction({ agentId })
              if (!result.success) {
                setError(result.error)
                return
              }
              refresh({ definitionId: result.data.definitionId, status: agentStatus })
            })
          }}
        >
          {pending ? 'Közzététel…' : definitionId ? 'Új verzió közzététele' : 'Közzététel'}
        </button>
      ) : null}
      {error ? <p className="mt-2 text-sm text-coral-deep">{error}</p> : null}
    </>
  )

  const body = goLive ? switchBody : publishOnlyBody
  if (bare) return body
  return <Card title={goLive ? 'Használható az MCP-n' : 'Közzététel'}>{body}</Card>
}
