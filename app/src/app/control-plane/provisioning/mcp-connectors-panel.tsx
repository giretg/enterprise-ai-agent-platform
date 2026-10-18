'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { Card } from '@/components/ui/shell'
import { asTranslate, type TranslateFn } from '@/i18n/translate'
import {
  approveMcpTools,
  archiveMcpConnector,
  createMcpConnector,
  listMcpConnectors,
  syncMcpConnector,
  tryMcpTool,
} from '@/app/actions/mcp-connectors'
import { startConnectorOAuth } from '@/app/actions/connector-grants'

type Risk = 'read' | 'write' | 'danger'
type ToolRow = {
  name: string
  description: string
  inputSchema: unknown
  risk: Risk
  approved: boolean
  suggestedRisk: Risk
  writeLikeName: boolean
}
type Diff = { added: string[]; removed: string[]; schemaChanged: string[]; descriptionChanged: string[] }
export type McpConnectorsData = { allowedHosts: string[]; connectors: ConnectorRow[] }

type ConnectorRow = {
  id: string
  name: string
  serverUrl: string
  authMode: string
  domainAllowed: boolean
  hasOwnGrant: boolean
  usedByAgents: string[]
  active: { versionId: string | null; tools: ToolRow[] } | null
  proposed: { versionId: string; versionNo: number; tools: ToolRow[]; diff: Diff | null } | null
}

const input = 'w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm'
const button = 'rounded-lg border border-line px-3 py-1.5 text-sm text-ink disabled:opacity-50'
const primary = 'rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50'

function actionError(t: TranslateFn, raw: string): string {
  if (raw.startsWith('read_downgrade_confirm:')) {
    return t('confirmReadDowngrade', { names: raw.slice('read_downgrade_confirm:'.length) })
  }
  const translated = t(`errors.${raw}`)
  return translated === `errors.${raw}` ? t('errors.unknown') : translated
}

function Message({ value }: { value: { tone: 'ok' | 'err'; text: string } | null }) {
  if (!value) return null
  return (
    <p
      className={`rounded-lg border px-3 py-2 text-sm ${
        value.tone === 'ok'
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
          : 'border-coral/35 bg-coral/10 text-coral-deep'
      }`}
    >
      {value.text}
    </p>
  )
}

function diffText(t: TranslateFn, diff: Diff | null): string | null {
  if (!diff) return null
  const parts = [
    diff.added.length ? t('diffAdded', { count: diff.added.length }) : '',
    diff.removed.length ? t('diffRemoved', { count: diff.removed.length }) : '',
    diff.schemaChanged.length ? t('diffSchema', { count: diff.schemaChanged.length }) : '',
    diff.descriptionChanged.length ? t('diffDescription', { count: diff.descriptionChanged.length }) : '',
  ].filter(Boolean)
  return parts.length ? t('diffSummary', { parts: parts.join(', ') }) : null
}

/** Eszköztábla: pipa, név, teljes leírás, paraméterek, kockázat, kipróbálás (§6/2–3). */
function ToolReview({
  connectorId,
  versionId,
  tools,
  isActive,
  onDone,
}: {
  connectorId: string
  versionId: string
  tools: ToolRow[]
  isActive: boolean
  onDone: (text: string) => void
}) {
  const t = asTranslate(useTranslations('McpConnectors'))
  const [rows, setRows] = useState(tools)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [tryArgs, setTryArgs] = useState<Record<string, string>>({})
  const [tryResult, setTryResult] = useState<Record<string, string>>({})

  const update = (name: string, patch: Partial<ToolRow>) =>
    setRows((current) => current.map((row) => (row.name === name ? { ...row, ...patch } : row)))

  function save(confirmReadDowngrade = false) {
    setMessage(null)
    startTransition(async () => {
      const res = await approveMcpTools({
        connectorId,
        versionId,
        decisions: rows.map((row) => ({ name: row.name, risk: row.risk, approved: row.approved })),
        confirmReadDowngrade,
      })
      if (res.success) {
        onDone(t('approved', { count: res.data.approved }))
      } else if (!confirmReadDowngrade && res.error.startsWith('read_downgrade_confirm:')) {
        if (window.confirm(actionError(t, res.error))) save(true)
      } else {
        setMessage({ tone: 'err', text: actionError(t, res.error) })
      }
    })
  }

  function tryTool(name: string) {
    let parsedArgs: Record<string, unknown> = {}
    try {
      parsedArgs = tryArgs[name]?.trim() ? JSON.parse(tryArgs[name]) : {}
    } catch {
      setTryResult((current) => ({ ...current, [name]: t('invalidJson') }))
      return
    }
    startTransition(async () => {
      const res = await tryMcpTool({ connectorId, tool: name, arguments: parsedArgs })
      setTryResult((current) => ({
        ...current,
        [name]: res.success ? JSON.stringify(res.data, null, 2) : actionError(t, res.error),
      }))
    })
  }

  return (
    <div className="space-y-3">
      <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
        {t('untrustedBanner')}
      </p>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.name} className="rounded-lg border border-line p-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={row.approved}
                  onChange={(e) => update(row.name, { approved: e.target.checked })}
                />
                <code>{row.name}</code>
              </label>
              <select
                value={row.risk}
                onChange={(e) => update(row.name, { risk: e.target.value as Risk })}
                className="rounded-lg border border-line bg-panel px-2 py-1 text-sm"
                aria-label={t('riskAria', { name: row.name })}
              >
                {(['read', 'write', 'danger'] as const).map((risk) => (
                  <option key={risk} value={risk}>
                    {t(`risk.${risk}`)}
                  </option>
                ))}
              </select>
              <span className="text-xs text-ink-soft">{t('suggested', { risk: t(`risk.${row.suggestedRisk}`) })}</span>
              {row.writeLikeName && row.risk === 'read' ? (
                <span className="text-xs text-coral-deep">{t('writeLikeWarning')}</span>
              ) : null}
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm text-ink-soft">{row.description || t('noDescription')}</p>
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-ink-soft">{t('parameters')}</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded bg-paper p-2">
                {JSON.stringify(row.inputSchema, null, 2)}
              </pre>
            </details>
            {row.suggestedRisk === 'read' || (row.approved && row.risk === 'read') ? (
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-ink-soft">{t('tryTitle')}</summary>
                <textarea
                  className={`${input} mt-1 font-mono text-xs`}
                  rows={2}
                  placeholder={t('tryPlaceholder')}
                  value={tryArgs[row.name] ?? ''}
                  onChange={(e) => setTryArgs((current) => ({ ...current, [row.name]: e.target.value }))}
                />
                <button type="button" className={`${button} mt-1`} disabled={pending} onClick={() => tryTool(row.name)}>
                  {t('run')}
                </button>
                {tryResult[row.name] ? (
                  <pre className="mt-1 max-h-64 overflow-auto rounded bg-paper p-2">{tryResult[row.name]}</pre>
                ) : null}
              </details>
            ) : null}
          </div>
        ))}
      </div>
      <button type="button" className={primary} disabled={pending} onClick={() => save()}>
        {isActive ? t('saveRisk') : t('approveTools')}
      </button>
      <Message value={message} />
    </div>
  )
}

function ConnectorCard({ row, reload }: { row: ConnectorRow; reload: (text?: string) => void }) {
  const t = asTranslate(useTranslations('McpConnectors'))
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const delegated = row.authMode === 'user_delegated'
  const autoSynced = useRef(false)

  function sync() {
    setMessage(null)
    startTransition(async () => {
      const res = await syncMcpConnector({ connectorId: row.id })
      if (!res.success) return setMessage({ tone: 'err', text: actionError(t, res.error) })
      reload(res.data.changed ? t('syncChanged', { count: res.data.toolCount }) : t('syncUnchanged'))
    })
  }

  useEffect(() => {
    if (autoSynced.current) return
    if (!delegated || !row.hasOwnGrant || row.active || row.proposed) return
    autoSynced.current = true
    let cancelled = false
    // Belépés után egyszer: initialize + tools/list (§6/1). A setState az await után fut.
    void syncMcpConnector({ connectorId: row.id }).then((res) => {
      if (cancelled) return
      if (!res.success) {
        setMessage({ tone: 'err', text: actionError(t, res.error) })
        return
      }
      reload(res.data.changed ? t('syncChanged', { count: res.data.toolCount }) : t('syncUnchanged'))
    })
    return () => {
      cancelled = true
    }
    // t/reload szándékosan kimarad: a fetch egyszer fusson connectoronként.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delegated, row.hasOwnGrant, row.active, row.proposed, row.id])

  function login() {
    startTransition(async () => {
      const res = await startConnectorOAuth({ connectorId: row.id })
      if (res.success) window.location.href = res.data.url
      else setMessage({ tone: 'err', text: res.error })
    })
  }

  function archive() {
    if (!window.confirm(t('archiveConfirm', { name: row.name }))) return
    startTransition(async () => {
      const res = await archiveMcpConnector({ connectorId: row.id })
      if (res.success) reload(t('archived'))
      else setMessage({ tone: 'err', text: actionError(t, res.error) })
    })
  }

  const changeNote = row.proposed && row.active ? diffText(t, row.proposed.diff) : null
  const approvedCount = row.active ? row.active.tools.filter((tool) => tool.approved).length : 0

  return (
    <div className="space-y-3 rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="break-all text-xs text-ink-soft">{row.serverUrl}</p>
          <p className="mt-1 text-xs text-ink-soft">
            {delegated ? t('modeUser') : t('modeService')}
            {' · '}
            {row.active ? t('approvedCount', { count: approvedCount }) : t('noApprovedYet')}
            {row.usedByAgents.length ? ` · ${t('usedBy', { names: row.usedByAgents.join(', ') })}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {delegated ? (
            <button type="button" className={button} disabled={pending} onClick={login}>
              {row.hasOwnGrant ? t('relogin') : t('login')}
            </button>
          ) : null}
          <button type="button" className={button} disabled={pending || (delegated && !row.hasOwnGrant)} onClick={sync}>
            {row.active || row.proposed ? t('recheck') : t('fetchTools')}
          </button>
          <button type="button" className={button} disabled={pending} onClick={archive}>
            {t('archive')}
          </button>
        </div>
      </div>
      {!row.domainAllowed ? <p className="text-sm text-coral-deep">{t('domainRevoked')}</p> : null}
      {delegated && !row.hasOwnGrant && !row.active && !row.proposed ? (
        <p className="text-sm text-ink-soft">{t('loginHint')}</p>
      ) : null}
      {changeNote ? <p className="text-sm text-amber-200">{changeNote}</p> : null}
      {row.proposed ? (
        <ToolReview
          key={row.proposed.versionId}
          connectorId={row.id}
          versionId={row.proposed.versionId}
          tools={row.proposed.tools}
          isActive={false}
          onDone={(text) => reload(text)}
        />
      ) : row.active?.versionId ? (
        <details>
          <summary className="cursor-pointer text-sm text-ink-soft">{t('toolsAndRisk')}</summary>
          <div className="mt-2">
            <ToolReview
              key={row.active.versionId}
              connectorId={row.id}
              versionId={row.active.versionId}
              tools={row.active.tools}
              isActive
              onDone={(text) => reload(text)}
            />
          </div>
        </details>
      ) : null}
      <Message value={message} />
    </div>
  )
}

function CreateForm({
  allowedHosts,
  onCreated,
}: {
  allowedHosts: string[]
  onCreated: (text: string, connectorId: string) => void
}) {
  const t = asTranslate(useTranslations('McpConnectors'))
  const [form, setForm] = useState({
    name: '',
    serverUrl: '',
    authMode: 'service' as 'service' | 'user_delegated',
    token: '',
    clientId: '',
    clientSecret: '',
    scopes: '',
  })
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }))

  function submit() {
    setMessage(null)
    startTransition(async () => {
      const res = await createMcpConnector(form)
      if (!res.success) return setMessage({ tone: 'err', text: actionError(t, res.error) })
      onCreated(
        res.data.toolCount !== null
          ? t('createdWithTools', { count: res.data.toolCount })
          : t('createdDelegated'),
        res.data.connectorId,
      )
      setForm((current) => ({ ...current, name: '', serverUrl: '', token: '', clientSecret: '' }))
    })
  }

  return (
    <div className="space-y-3 rounded-xl border border-line p-4">
      <p className="font-medium">{t('createTitle')}</p>
      <input className={input} placeholder={t('namePlaceholder')} value={form.name} onChange={(e) => set({ name: e.target.value })} />
      <input
        className={input}
        placeholder={t('urlPlaceholder')}
        value={form.serverUrl}
        onChange={(e) => set({ serverUrl: e.target.value })}
      />
      <p className="text-xs text-ink-soft">
        {allowedHosts.length ? t('allowedHosts', { hosts: allowedHosts.join(', ') }) : t('noHosts')}
      </p>
      <fieldset className="space-y-1 text-sm">
        <legend className="mb-1 text-ink-soft">{t('actingAs')}</legend>
        <label className="flex items-center gap-2">
          <input type="radio" checked={form.authMode === 'service'} onChange={() => set({ authMode: 'service' })} />
          {t('modeServiceHint')}
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={form.authMode === 'user_delegated'} onChange={() => set({ authMode: 'user_delegated' })} />
          {t('modeUserHint')}
        </label>
      </fieldset>
      {form.authMode === 'service' ? (
        <input
          className={input}
          type="password"
          autoComplete="off"
          placeholder={t('tokenPlaceholder')}
          value={form.token}
          onChange={(e) => set({ token: e.target.value })}
        />
      ) : (
        <div className="space-y-2">
          <input
            className={input}
            placeholder={t('clientIdPlaceholder')}
            value={form.clientId}
            onChange={(e) => set({ clientId: e.target.value })}
          />
          <input
            className={input}
            type="password"
            autoComplete="off"
            placeholder={t('clientSecretPlaceholder')}
            value={form.clientSecret}
            onChange={(e) => set({ clientSecret: e.target.value })}
          />
          <input
            className={input}
            placeholder={t('scopesPlaceholder')}
            value={form.scopes}
            onChange={(e) => set({ scopes: e.target.value })}
          />
        </div>
      )}
      <button type="button" className={primary} disabled={pending || !form.name.trim() || !form.serverUrl.trim()} onClick={submit}>
        {pending ? t('checking') : t('checkAndSave')}
      </button>
      <Message value={message} />
    </div>
  )
}

/** #395: külső MCP-szerverek csatolása kódírás nélkül. */
export function McpConnectorsPanel({
  canManage,
  initial,
  initialError,
  mode = 'manage',
  onChanged,
}: {
  canManage: boolean
  initial: McpConnectorsData | null
  initialError?: string
  mode?: 'manage' | 'setup'
  onChanged?: () => void
}) {
  const t = asTranslate(useTranslations('McpConnectors'))
  const [data, setData] = useState(initial)
  const [createdConnectorId, setCreatedConnectorId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(
    initialError ? { tone: 'err', text: actionError(t, initialError) } : null,
  )

  async function reload(text?: string) {
    const res = await listMcpConnectors()
    if (res.success) {
      setData(res.data as McpConnectorsData)
      setMessage(text ? { tone: 'ok', text } : null)
      if (mode === 'setup') onChanged?.()
    } else {
      setMessage({ tone: 'err', text: actionError(t, res.error) })
    }
  }

  if (mode === 'setup') {
    const createdConnector = data?.connectors.find((row) => row.id === createdConnectorId)
    return (
      <div className="space-y-4">
        {message ? <Message value={message} /> : null}
        {!data && canManage ? (
          <button type="button" className={button} onClick={() => void reload()}>
            {t('refresh')}
          </button>
        ) : null}
        {canManage && data && !createdConnectorId ? (
          <CreateForm
            allowedHosts={data.allowedHosts}
            onCreated={(text, connectorId) => {
              setCreatedConnectorId(connectorId)
              void reload(text)
            }}
          />
        ) : null}
        {createdConnector ? (
          <>
            <ConnectorCard row={createdConnector} reload={(text) => void reload(text)} />
            {canManage ? (
              <button
                type="button"
                className={button}
                onClick={() => {
                  setCreatedConnectorId(null)
                  setMessage(null)
                }}
              >
                {t('addAnother')}
              </button>
            ) : null}
          </>
        ) : null}
        {createdConnectorId && !createdConnector ? (
          <button type="button" className={button} onClick={() => void reload()}>
            {t('refresh')}
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <Card title={t('title')}>
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">{t('intro')}</p>
        <Message value={message} />
        {data && data.connectors.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-3 text-sm text-ink-soft">{t('empty')}</p>
        ) : null}
        {data?.connectors.map((row) => (
          <ConnectorCard key={row.id} row={row} reload={(text) => void reload(text)} />
        ))}
        {canManage && data ? (
          <CreateForm
            allowedHosts={data.allowedHosts}
            onCreated={(text) => void reload(text)}
          />
        ) : null}
      </div>
    </Card>
  )
}
