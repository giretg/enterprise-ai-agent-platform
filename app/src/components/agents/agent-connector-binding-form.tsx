'use client'

import { useEffect, useId, useMemo, useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import {
  assignConnectorToAgent,
  unassignConnectorFromAgent,
} from '@/app/actions/provisioning'
import { assignTenantMailboxAction } from '@/app/actions/tenant-mailbox'
import { TENANT_MAILBOX_ASSIGN_WARNING } from '@/domain/connector-grant/tenant-mailbox'
import { Card } from '@/components/ui/shell'
import { OpenInNewWindowLink } from '@/components/ui/open-in-new-window-link'
import {
  CREATE_AGENT_WIZARD_EXTERNAL_HREFS,
  matchAssignableConnectorsByName,
} from '@/lib/create-agent-wizard'
import { connectorDisplayLabel } from '@/lib/connector-display-label'
import {
  KbBindingGroupHeader,
  KbBindingIcon,
  KbBindingOpenLink,
  KbBindingStatusLine,
  useAgentKbCopy,
  type AgentKbBindingInfo,
} from '@/components/agents/agent-kb-binding-summary'
import { HelpHint } from '@/components/onboarding/onboarding-ui'
import { UpdateApproverForm } from '@/components/agents/update-approver-form'
import { ConnectorTemplateIcon } from '@/components/account/provider-icon'

export type ConnectorCatalogOption = {
  id: string
  type: string
  name: string
  description?: string | null
  baseUrl?: string | null
  templateKey?: string | null
  /** Közös (tenant-szintű) postafiók: kötéskor figyelmeztetés kell, csak-olvasásnál nincs írás. */
  tenantMailbox?: { readOnly: boolean } | null
  iconDataUrl?: string | null
  tools?: Array<{ method: string; path: string; description?: string | null }>
}

function ConnectorListIcon({
  iconDataUrl,
  provider,
}: {
  iconDataUrl?: string | null
  provider: string
}) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-ink/10 bg-white">
      <ConnectorTemplateIcon iconDataUrl={iconDataUrl} provider={provider} className="h-5 w-5" />
    </span>
  )
}

function accessModeRoleLine(mode: 'read' | 'write'): string {
  return mode === 'write'
    ? 'Írási mód: a munkatárs ezen a kapcsolaton keresztül műveleteket is végezhet (küldés, módosítás, API-hívás — a kapcsolat típusától függően).'
    : 'Olvasási mód: a munkatárs ezen a kapcsolaton keresztül adatokat nézhet meg; önálló módosítást nem végezhet.'
}

function ConnectorCatalogDetail({
  connector,
  accessMode,
}: {
  connector: ConnectorCatalogOption
  accessMode?: 'read' | 'write'
}) {
  const tools = connector.tools ?? []
  return (
    <div className="rounded-lg border border-line/60 bg-paper/80 px-3 py-2">
      {accessMode ? (
        <p className="mb-2 text-xs leading-relaxed text-ink">{accessModeRoleLine(accessMode)}</p>
      ) : null}
      {connector.description ? (
        <p className="text-sm leading-relaxed text-ink-soft">{connector.description}</p>
      ) : (
        <p className="text-sm italic text-ink-faint">Ehhez a kapcsolathoz nincs leírás.</p>
      )}
      <p className="mt-1 text-xs text-ink-faint">
        {connector.type}
        {connector.baseUrl ? ` · ${connector.baseUrl}` : ''}
        {tools.length > 0 ? ` · ${tools.length} művelet` : ''}
      </p>
      {tools.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {tools.slice(0, 6).map((t) => (
            <li key={`${t.method} ${t.path}`} className="text-xs text-ink-soft">
              <span className="font-mono font-semibold">{t.method}</span>{' '}
              <span className="font-mono">{t.path}</span>
              {t.description ? <span className="text-ink-faint"> — {t.description}</span> : null}
            </li>
          ))}
          {tools.length > 6 ? (
            <li className="text-xs text-ink-faint">…és még {tools.length - 6} művelet</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}

type Binding = {
  connector: { id: string; name: string; type: string; config?: unknown; approverUserId?: string | null }
  accessMode: 'read' | 'write'
}

type ConnectorPick = { accessMode: 'read' | 'write' }

const CONNECTOR_TYPE_LABEL: Record<string, string> = {
  http_api: 'API',
  gmail: 'Gmail',
  google_drive: 'Google Drive',
  mcp: 'MCP',
  code_sandbox: 'Kódfuttatás',
  web_search: 'Webes keresés',
  knowledge_base: 'Tudásbázis',
}

/** Típus és mód; a típust elhagyja, ha a kapcsolat neve már ugyanaz (pl. Gmail). */
function connectorSubtitle(type: string, displayName: string, accessMode: 'read' | 'write'): string {
  const mode = accessMode === 'write' ? 'Írás' : 'Olvasás'
  const label = CONNECTOR_TYPE_LABEL[type] ?? type
  return label === displayName ? mode : `${label} · ${mode}`
}

function AddConnectorBindingsDialog({
  agentId,
  ordered,
  suggested,
  onClose,
  onAssigned,
}: {
  agentId: string
  ordered: ConnectorCatalogOption[]
  suggested: ConnectorCatalogOption[]
  onClose: () => void
  onAssigned: () => void
}) {
  const router = useRouter()
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const [mounted, setMounted] = useState(false)
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const suggestedIds = useMemo(() => new Set(suggested.map((item) => item.id)), [suggested])
  const [picks, setPicks] = useState<Record<string, ConnectorPick>>({})
  const [previewId, setPreviewId] = useState<string | null>(null)

  const selectedIds = useMemo(
    () => Object.keys(picks).filter((id) => ordered.some((item) => item.id === id)),
    [picks, ordered],
  )

  const preview = useMemo(() => {
    return previewId ? ordered.find((item) => item.id === previewId) : undefined
  }, [previewId, ordered])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client portal mount gate
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) return
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mounted, onClose])

  function togglePick(id: string, checked: boolean) {
    setPicks((prev) => {
      const next = { ...prev }
      if (checked) next[id] = prev[id] ?? { accessMode: 'read' }
      else delete next[id]
      return next
    })
  }

  function setAccessMode(id: string, accessMode: 'read' | 'write') {
    setPicks((prev) => ({ ...prev, [id]: { accessMode } }))
  }

  function submit() {
    if (selectedIds.length === 0) return
    start(async () => {
      setError(null)
      const failures: string[] = []
      for (const connectorId of selectedIds) {
        const pick = picks[connectorId]
        const accessMode = pick?.accessMode ?? 'read'
        // A közös postafiók figyelmeztetése a sor alatt látszik; a Kötés gomb az elfogadása.
        const result = ordered.find((item) => item.id === connectorId)?.tenantMailbox
          ? await assignTenantMailboxAction({ connectorId, agentId, access: accessMode, confirmed: true })
          : await assignConnectorToAgent({ agentId, connectorId, accessMode })
        if (!result.success) {
          const name = ordered.find((item) => item.id === connectorId)?.name ?? connectorId
          failures.push(`${name}: ${result.error}`)
        }
      }
      if (failures.length > 0) {
        setError(failures.join(' '))
        if (failures.length < selectedIds.length) {
          onAssigned()
          router.refresh()
        }
        return
      }
      onAssigned()
      router.refresh()
      onClose()
    })
  }

  if (!mounted) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-ink/50 p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[min(40rem,92vh)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="font-display text-lg font-bold leading-tight text-ink">
              Kapcsolat hozzáadása
            </h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Jelöld ki a kötendő kapcsolatokat, állítsd a módot, majd egy gombbal kösd az agenthez.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Bezárás"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-ink-faint hover:bg-night-2 hover:text-ink"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {suggested.length > 0 ? (
            <p className="mb-3 rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-ink">
              Javasolt kapcsolatok felülre kerültek — csak akkor kötődnek, ha bepipálod.
            </p>
          ) : null}
          <ul className="space-y-2">
            {ordered.map((item) => {
              const checked = item.id in picks
              const active = previewId === item.id
              return (
                <li key={item.id}>
                  <div
                    className={`flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 transition-colors ${
                      active ? 'border-coral/50 bg-coral/5' : 'border-line/70'
                    }`}
                    onClick={() => setPreviewId(item.id)}
                    onFocusCapture={() => setPreviewId(item.id)}
                  >
                    <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1 shrink-0"
                        checked={checked}
                        onChange={(e) => togglePick(item.id, e.target.checked)}
                      />
                      <ConnectorListIcon
                        iconDataUrl={item.iconDataUrl}
                        provider={item.templateKey ?? item.type}
                      />
                      <span className="min-w-0">
                        <span className="font-medium text-ink">
                          {suggestedIds.has(item.id) ? 'Javasolt · ' : ''}
                          {item.name}
                        </span>
                        <span className="ml-1 text-xs text-ink-faint">({item.type})</span>
                      </span>
                    </label>
                    {checked ? (
                      <label className="text-xs text-ink-soft">
                        Mód
                        <select
                          className="ml-1 rounded-lg border border-line bg-paper px-2 py-1 text-sm text-ink"
                          value={picks[item.id]?.accessMode ?? 'read'}
                          onChange={(e) =>
                            setAccessMode(item.id, e.target.value as 'read' | 'write')
                          }
                        >
                          <option value="read">olvasás</option>
                          {item.tenantMailbox?.readOnly ? null : <option value="write">írás</option>}
                        </select>
                      </label>
                    ) : null}
                    {checked && item.tenantMailbox ? (
                      <p className="basis-full rounded-lg border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-ink">
                        {TENANT_MAILBOX_ASSIGN_WARNING}
                      </p>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
          {preview ? (
            <div className="mt-3 border-t border-line/60 pt-3">
              <ConnectorCatalogDetail connector={preview} />
            </div>
          ) : null}
          {error ? <p className="mt-3 text-sm text-coral-deep">{error}</p> : null}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink-soft hover:bg-night-2"
          >
            Mégse
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending || selectedIds.length === 0}
            className="rounded-lg bg-coral px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {pending ? 'Mentés…' : 'Kötés'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function AgentConnectorBindingForm({
  agentId,
  bindings,
  catalog = [],
  catalogDetails,
  knowledgeBases,
  suggestedConnectorNames,
  bare = false,
  canManageApprovers = false,
  onAssigned,
}: {
  agentId: string
  bindings: Binding[]
  catalog?: ConnectorCatalogOption[]
  /** Teljes katalógus — a már kötött kapcsolatok leírásához (a `catalog` csak a még szabad elemeket tartalmazza). */
  catalogDetails?: ConnectorCatalogOption[]
  /** A kötött tudásbázisok adatai. Ha hiányzik, a tudásbázis-sor csak az általános címkét mutatja. */
  knowledgeBases?: AgentKbBindingInfo[]
  suggestedConnectorNames?: string[]
  bare?: boolean
  /** Tenant admin: konnektoronkénti megnevezett jóváhagyó (kimenő eszközhívások). */
  canManageApprovers?: boolean
  onAssigned?: () => void
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [expandedBindingId, setExpandedBindingId] = useState<string | null>(null)
  const catalogById = useMemo(() => {
    const map = new Map<string, ConnectorCatalogOption>()
    for (const item of catalogDetails ?? catalog) map.set(item.id, item)
    for (const item of catalog) map.set(item.id, item)
    return map
  }, [catalog, catalogDetails])
  const kbCopy = useAgentKbCopy()
  const kbInfoById = useMemo(
    () => new Map((knowledgeBases ?? []).map((item) => [item.connectorId, item])),
    [knowledgeBases],
  )
  const suggested = useMemo(
    () => matchAssignableConnectorsByName(catalog, suggestedConnectorNames ?? []),
    [catalog, suggestedConnectorNames],
  )
  const ordered = useMemo(() => {
    if (suggested.length === 0) return catalog
    const suggestedIds = new Set(suggested.map((item) => item.id))
    return [...suggested, ...catalog.filter((item) => !suggestedIds.has(item.id))]
  }, [catalog, suggested])

  function refresh() {
    onAssigned?.()
    router.refresh()
  }

  const renderRow = (row: Binding) => {
    const expanded = expandedBindingId === row.connector.id
    const isKb = row.connector.type === 'knowledge_base'
    const kbInfo = isKb ? kbInfoById.get(row.connector.id) : undefined
    const kb = kbInfo ? kbCopy(kbInfo, row.accessMode) : null
    const displayName =
      kb?.title ?? connectorDisplayLabel(row.connector.type, row.connector.name, row.connector.config)
    const detailBase =
      catalogById.get(row.connector.id) ?? {
        id: row.connector.id,
        type: row.connector.type,
        name: row.connector.name,
        description: null,
      }
    const detail = { ...detailBase, name: displayName }
    const iconProvider = detail.templateKey ?? row.connector.type
    return (
      <li key={row.connector.id} className="rounded-lg border border-line/70 px-3 py-2.5 text-sm">
        <div className="flex items-start gap-3">
          {isKb ? (
            <KbBindingIcon />
          ) : (
            <ConnectorListIcon iconDataUrl={detail.iconDataUrl} provider={iconProvider} />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-start">
              <button
                type="button"
                className="min-w-0 rounded-md text-left"
                aria-expanded={expanded}
                onClick={() => setExpandedBindingId((prev) => (prev === row.connector.id ? null : row.connector.id))}
              >
                <span className="font-medium text-ink">{displayName}</span>
                {kb?.kindLabel ? <span className="ml-1.5 text-xs text-ink-faint">{kb.kindLabel}</span> : null}
                <span aria-hidden className={`ml-1.5 inline-block text-ink-faint transition-transform ${expanded ? 'rotate-90' : ''}`}>
                  ›
                </span>
              </button>
              {kb ? <HelpHint>{kb.help}</HelpHint> : null}
            </div>
            {kb ? (
              <KbBindingStatusLine agentId={agentId} copy={kb} />
            ) : (
              <p className="mt-0.5 text-xs text-ink-faint">
                {connectorSubtitle(row.connector.type, displayName, row.accessMode)}
              </p>
            )}
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              start(async () => {
                setError(null)
                setDone(null)
                const result = await unassignConnectorFromAgent({
                  agentId,
                  connectorId: row.connector.id,
                })
                if (!result.success) {
                  setError(result.error)
                  return
                }
                if (expandedBindingId === row.connector.id) setExpandedBindingId(null)
                setDone(`„${displayName}” leválasztva.`)
                refresh()
              })
            }}
            className="shrink-0 text-xs font-medium text-ink-faint hover:text-coral disabled:opacity-50"
          >
            Leválasztás
          </button>
        </div>
        {expanded ? (
          <div className="mt-2 space-y-3 border-t border-line/50 pt-2">
            {kb ? (
              <KbBindingOpenLink connectorId={row.connector.id} />
            ) : (
              <ConnectorCatalogDetail connector={detail} accessMode={row.accessMode} />
            )}
            {canManageApprovers || row.connector.approverUserId ? (
              <div className="rounded-lg border border-line/60 bg-panel/80 px-3 py-2">
                <p className="mb-2 text-xs font-semibold text-ink">Kimenő műveletek jóváhagyója</p>
                <p className="mb-2 text-xs text-ink-soft">
                  Ha be van állítva, az ezen a kapcsolaton (pl. blog API, Drive írás) keresztül induló
                  jóváhagyások ehhez a személyhez kerülnek — felülírja az agent memóriaírás-jóváhagyóját.
                </p>
                <UpdateApproverForm
                  entity={{ kind: 'connector', connectorId: row.connector.id }}
                  currentApproverUserId={row.connector.approverUserId ?? null}
                  canEdit={canManageApprovers}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </li>
    )
  }

  const kbBindings = bindings.filter((row) => row.connector.type === 'knowledge_base')
  const otherBindings = bindings.filter((row) => row.connector.type !== 'knowledge_base')

  const body = (
    <>
      {bindings.length === 0 ? <p className="text-sm text-ink-soft">Nincs kötött konnektor.</p> : null}
      {kbBindings.length > 0 ? (
        <section className="mb-4">
          <KbBindingGroupHeader agentId={agentId} />
          <ul className="space-y-2">{kbBindings.map(renderRow)}</ul>
        </section>
      ) : null}
      {otherBindings.length > 0 ? (
        <section>
          {kbBindings.length > 0 ? <h3 className="mb-2 text-sm font-semibold text-ink">Külső rendszerek</h3> : null}
          <ul className="space-y-2">{otherBindings.map(renderRow)}</ul>
        </section>
      ) : null}

      {ordered.length === 0 ? (
        <p className="mt-4 text-sm text-ink-soft">
          Nincs több hozzárendelhető aktív kapcsolat.{' '}
          <OpenInNewWindowLink href={CREATE_AGENT_WIZARD_EXTERNAL_HREFS.connections}>
            Új konnektor
          </OpenInNewWindowLink>
        </p>
      ) : (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => {
              setAddOpen(true)
              setError(null)
              setDone(null)
            }}
            className="rounded-lg border border-coral/40 bg-coral/10 px-4 py-2 text-sm font-semibold text-coral hover:bg-coral/15"
          >
            Kapcsolat hozzáadása
          </button>
        </div>
      )}

      {addOpen ? (
        <AddConnectorBindingsDialog
          agentId={agentId}
          ordered={ordered}
          suggested={suggested}
          onClose={() => setAddOpen(false)}
          onAssigned={() => {
            setDone('Kiválasztott kapcsolatok hozzárendelve.')
            refresh()
          }}
        />
      ) : null}

      {done ? (
        <p className="mt-2 rounded-lg border border-sage/30 bg-sage/10 px-3 py-2 text-xs text-sage">
          {done}
        </p>
      ) : null}
      {error ? <p className="mt-2 text-sm text-coral-deep">{error}</p> : null}
    </>
  )

  if (bare) return body
  return <Card title="Konnektorok">{body}</Card>
}
