'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import { Badge, Card } from '@/components/ui/shell'
import {
  activateConnector,
  assignConnectorToAgent,
  createConnectorDraft,
  draftConfigFromApiDoc,
  listConnectorCatalog,
  listProvisioningDrafts,
  reviewConnectorDraft,
  testConnectorDraft,
  validateConnectorDraft,
} from '@/app/actions/provisioning'

// A listProvisioningDrafts visszaadott alakja (provisioning-service.listDrafts).
type CheckStatus = 'passed' | 'warned' | 'failed'
type ValidationResult = {
  status: CheckStatus
  checks: Record<string, CheckStatus>
  warnings: string[]
  errors: string[]
}
type ProposedTool = {
  name: string
  method: string
  path: string
  access: 'read' | 'write'
  description?: string
}
type DraftConfig = {
  provider: string
  baseUrl: string
  egressHosts: string[]
  authMode: string
  auth: { type: string; headerName?: string; secretAliasSuggested?: string }
  scopesSuggested: string[]
  rateLimit?: { rps: number; burst: number }
  proposedTools: ProposedTool[]
} | null
type DraftRow = {
  draftId: string
  connectorId: string
  name: string
  lifecycleState: string
  reviewStatus: string
  validationResult: ValidationResult | null
  sandboxTestOk: boolean | null
  secretAliasSuggested: string | null
  config: DraftConfig
  sourceType: string
  sourceHash: string
  createdAt: string | Date
}

const EXAMPLE_CONFIG = JSON.stringify(
  {
    provider: 'acme-crm',
    baseUrl: 'https://api.acme-crm.example',
    egressHosts: ['api.acme-crm.example'],
    authMode: 'service',
    auth: {
      type: 'api_key_header',
      headerName: 'X-Api-Key',
      secretAliasSuggested: 'acme-crm-service-key',
    },
    scopesSuggested: ['contacts.read', 'deals.read'],
    rateLimit: { rps: 5, burst: 10 },
    proposedTools: [
      { name: 'acme_crm.search_contacts', method: 'GET', path: '/v1/contacts', access: 'read' },
      { name: 'acme_crm.get_deal', method: 'GET', path: '/v1/deals/{id}', access: 'read' },
    ],
  },
  null,
  2,
)

function statusTone(s?: CheckStatus): 'neutral' | 'success' | 'warning' | 'danger' {
  if (s === 'passed') return 'success'
  if (s === 'warned') return 'warning'
  if (s === 'failed') return 'danger'
  return 'neutral'
}
function reviewTone(s: string): 'neutral' | 'success' | 'warning' | 'danger' {
  if (s === 'approved') return 'success'
  if (s === 'rejected') return 'danger'
  if (s === 'changes_requested') return 'warning'
  return 'neutral'
}
function lifecycleTone(s: string): 'neutral' | 'success' | 'warning' | 'danger' {
  if (s === 'active') return 'success'
  if (s === 'blocked' || s === 'archived') return 'danger'
  return 'neutral'
}

export function ProvisioningPanel() {
  const [drafts, setDrafts] = useState<DraftRow[]>([])
  const [catalog, setCatalog] = useState<Array<{ id: string; type: string; name: string }>>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [pending, startTransition] = useTransition()

  // Create-form állapot
  const [name, setName] = useState('')
  const [sourceType, setSourceType] = useState<'api_doc' | 'openapi' | 'manual'>('api_doc')
  const [configText, setConfigText] = useState('')

  // F2-P-F: doksi → config-jelölt generálás állapota
  const [docText, setDocText] = useState('')
  const [generating, setGenerating] = useState(false)

  const reload = useCallback(() => {
    startTransition(async () => {
      const [d, c] = await Promise.all([listProvisioningDrafts(), listConnectorCatalog()])
      if (d.success) setDrafts(d.data as DraftRow[])
      else setError(d.error)
      if (c.success) setCatalog(c.data)
      setLoadedOnce(true)
    })
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const run = useCallback(
    (fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) => {
      setError(null)
      setNotice(null)
      startTransition(async () => {
        const res = await fn()
        if (res.success) {
          setNotice(okMsg)
          reload()
        } else {
          setError(res.error ?? 'Ismeretlen hiba')
        }
      })
    },
    [reload],
  )

  const onGenerate = useCallback(() => {
    setError(null)
    setNotice(null)
    setGenerating(true)
    startTransition(async () => {
      const res = await draftConfigFromApiDoc({
        docText,
        providerHint: name.trim() || undefined,
      })
      setGenerating(false)
      if (res.success) {
        setConfigText(JSON.stringify(res.data.config, null, 2))
        setNotice(
          'Config-jelölt generálva. Nézd át, majd hozd létre a draftot — a validátor a létrehozás után dönt.',
        )
      } else {
        setError(res.error)
      }
    })
  }, [docText, name])

  const onCreate = useCallback(() => {
    let parsed: unknown
    try {
      parsed = JSON.parse(configText)
    } catch {
      setError('A config nem érvényes JSON.')
      return
    }
    run(
      () =>
        createConnectorDraft({
          name,
          sourceType,
          generatedConfig: parsed,
        }),
      'Draft létrehozva.',
    )
  }, [configText, name, sourceType, run])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Provisioning</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Connector-onboarding asszisztens — <strong>propose, ne apply</strong>. Az asszisztens
          draft connector-deskriptort állít elő; az aktiválás és az agenthez rendelés emberi
          admin-aktus marad (CR-MVP-002).
        </p>
      </div>

      {error ? (
        <div className="rounded-lg border border-coral/40 bg-coral/10 px-4 py-3 text-sm text-coral">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-lg border border-sage/40 bg-sage/10 px-4 py-3 text-sm text-sage">
          {notice}
        </div>
      ) : null}

      <Card title="Új draft connector">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-ink-soft">Név</span>
            <input
              className="w-full rounded-md border border-ink/15 bg-paper px-3 py-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme CRM"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-ink-soft">Forrás típusa</span>
            <select
              className="w-full rounded-md border border-ink/15 bg-paper px-3 py-2"
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value as typeof sourceType)}
            >
              <option value="api_doc">api_doc</option>
              <option value="openapi">openapi</option>
              <option value="manual">manual</option>
            </select>
          </label>
        </div>
        <div className="mt-3 rounded-md border border-ink/12 bg-wash/40 p-3">
          <span className="mb-1 block text-sm font-semibold">
            Generálás API-doksiból (provisioning-asszisztens)
          </span>
          <p className="mb-2 text-xs text-ink-soft">
            Illeszd be az API-dokumentációt — az asszisztens <strong>adatként</strong> dolgozza
            fel (nem utasításként), és config-jelöltet ad vissza. Ez még <em>nem</em> draft: a
            jelölt a lenti JSON-mezőbe kerül, te nézed át és hozod létre.
          </p>
          <textarea
            className="h-32 w-full rounded-md border border-ink/15 bg-paper px-3 py-2 font-mono text-xs"
            value={docText}
            onChange={(e) => setDocText(e.target.value)}
            placeholder="Pl. 'Acme CRM API. Base URL: https://api.acme-crm.example. GET /v1/contacts — list contacts (scope: contacts.read)…'"
          />
          <button
            type="button"
            disabled={pending || generating || !docText.trim()}
            onClick={onGenerate}
            className="mt-2 rounded-md border border-sage/40 bg-sage/10 px-3 py-1.5 text-xs font-semibold text-sage disabled:opacity-50"
          >
            {generating ? 'Generálás…' : 'Config-jelölt generálása'}
          </button>
        </div>

        <label className="mt-3 block text-sm">
          <span className="mb-1 flex items-center justify-between text-ink-soft">
            <span>Generált config-deskriptor (JSON, §4.3)</span>
            <button
              type="button"
              className="text-xs font-semibold text-sage hover:underline"
              onClick={() => setConfigText(EXAMPLE_CONFIG)}
            >
              Példa betöltése
            </button>
          </span>
          <textarea
            className="h-56 w-full rounded-md border border-ink/15 bg-paper px-3 py-2 font-mono text-xs"
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            placeholder={EXAMPLE_CONFIG}
          />
        </label>
        <p className="mt-1 text-xs text-ink-soft">
          A secret SOSEM kerül ide — csak a Secret Managerbe szánt alias <em>neve</em> javasolt.
        </p>
        <button
          type="button"
          disabled={pending || !name.trim() || !configText.trim()}
          onClick={onCreate}
          className="mt-3 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-paper disabled:opacity-50"
        >
          Draft létrehozása
        </button>
      </Card>

      <Card title={`Draftok (${drafts.length})`}>
        {!loadedOnce ? (
          <p className="text-sm text-ink-soft">Betöltés…</p>
        ) : drafts.length === 0 ? (
          <p className="text-sm text-ink-soft">Még nincs draft connector.</p>
        ) : (
          <div className="space-y-3">
            {drafts.map((d) => (
              <DraftCard
                key={d.draftId}
                draft={d}
                agents={catalog}
                pending={pending}
                run={run}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

function DraftCard({
  draft,
  pending,
  run,
}: {
  draft: DraftRow
  agents: Array<{ id: string; type: string; name: string }>
  pending: boolean
  run: (fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [secretAlias, setSecretAlias] = useState(draft.secretAliasSuggested ?? '')
  const [approverId, setApproverId] = useState('')
  const [criticality, setCriticality] = useState<'L1' | 'L2' | 'L3'>('L1')
  const [agentId, setAgentId] = useState('')
  const [accessMode, setAccessMode] = useState<'read' | 'write'>('read')

  const v = draft.validationResult
  const cfg = draft.config
  const writeTools = useMemo(
    () => (cfg?.proposedTools ?? []).filter((t) => t.access === 'write'),
    [cfg],
  )

  return (
    <div className="rounded-lg border border-ink/12 bg-paper">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button
          type="button"
          className="font-semibold hover:underline"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? '▾' : '▸'} {draft.name}
        </button>
        <Badge tone={lifecycleTone(draft.lifecycleState)}>{draft.lifecycleState}</Badge>
        <Badge tone={reviewTone(draft.reviewStatus)}>review: {draft.reviewStatus}</Badge>
        {v ? <Badge tone={statusTone(v.status)}>validation: {v.status}</Badge> : (
          <Badge tone="neutral">validation: —</Badge>
        )}
        {draft.sandboxTestOk === true ? <Badge tone="success">sandbox: ok</Badge> : null}
        {draft.sandboxTestOk === false ? <Badge tone="danger">sandbox: fail</Badge> : null}
        {writeTools.length > 0 ? <Badge tone="warning">{writeTools.length} write-tool</Badge> : null}
      </div>

      {open ? (
        <div className="space-y-4 border-t border-ink/10 px-4 py-4 text-sm">
          {/* Diff-nézet — a generált deskriptor (§4.3) */}
          {cfg ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h4 className="mb-1 font-semibold">Egress-célhostok</h4>
                <ul className="font-mono text-xs">
                  {cfg.egressHosts.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
                <h4 className="mb-1 mt-3 font-semibold">Auth</h4>
                <p className="text-xs text-ink-soft">
                  {cfg.authMode} · {cfg.auth.type}
                  {cfg.auth.headerName ? ` · ${cfg.auth.headerName}` : ''}
                  <br />
                  secret-alias (javasolt): <code>{cfg.auth.secretAliasSuggested ?? '—'}</code>
                </p>
              </div>
              <div>
                <h4 className="mb-1 font-semibold">Scope-ok</h4>
                <div className="flex flex-wrap gap-1">
                  {cfg.scopesSuggested.length === 0 ? (
                    <span className="text-xs text-ink-soft">—</span>
                  ) : (
                    cfg.scopesSuggested.map((s) => (
                      <Badge key={s} tone="neutral">
                        {s}
                      </Badge>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-coral">A tárolt config nem értelmezhető.</p>
          )}

          {cfg ? (
            <div>
              <h4 className="mb-1 font-semibold">Javasolt toolok</h4>
              <table className="w-full text-left text-xs">
                <thead className="text-ink-soft">
                  <tr>
                    <th className="py-1">Név</th>
                    <th>Method</th>
                    <th>Path</th>
                    <th>Access</th>
                  </tr>
                </thead>
                <tbody>
                  {cfg.proposedTools.map((t) => (
                    <tr
                      key={t.name}
                      className={t.access === 'write' ? 'bg-honey/10' : undefined}
                    >
                      <td className="py-1 font-mono">{t.name}</td>
                      <td>{t.method}</td>
                      <td className="font-mono">{t.path}</td>
                      <td>
                        <Badge tone={t.access === 'write' ? 'warning' : 'neutral'}>
                          {t.access}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {/* Validációs eredmény */}
          {v ? (
            <div>
              <h4 className="mb-1 font-semibold">Determinisztikus validáció</h4>
              <div className="flex flex-wrap gap-1">
                {Object.entries(v.checks).map(([k, s]) => (
                  <Badge key={k} tone={statusTone(s)}>
                    {k}: {s}
                  </Badge>
                ))}
              </div>
              {v.errors.length > 0 ? (
                <ul className="mt-2 list-disc pl-5 text-xs text-coral">
                  {v.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              ) : null}
              {v.warnings.length > 0 ? (
                <ul className="mt-2 list-disc pl-5 text-xs text-honey">
                  {v.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <p className="text-xs text-ink-soft">
            forrás: {draft.sourceType} · hash: <code>{draft.sourceHash}</code>
          </p>

          {/* Akciók */}
          <div className="flex flex-wrap gap-2 border-t border-ink/10 pt-3">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(() => validateConnectorDraft({ draftId: draft.draftId }), 'Validáció lefutott.')
              }
              className="rounded-md border border-ink/20 px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
            >
              Validálás
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(
                  () => reviewConnectorDraft({ draftId: draft.draftId, decision: 'approve' }),
                  'Jóváhagyva.',
                )
              }
              className="rounded-md border border-sage/40 bg-sage/10 px-3 py-1.5 text-xs font-semibold text-sage disabled:opacity-50"
            >
              Jóváhagyás
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    reviewConnectorDraft({ draftId: draft.draftId, decision: 'changes_requested' }),
                  'Módosítás kérve.',
                )
              }
              className="rounded-md border border-honey/40 bg-honey/10 px-3 py-1.5 text-xs font-semibold text-honey disabled:opacity-50"
            >
              Módosítás kérése
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(
                  () => reviewConnectorDraft({ draftId: draft.draftId, decision: 'reject' }),
                  'Elutasítva.',
                )
              }
              className="rounded-md border border-coral/40 bg-coral/10 px-3 py-1.5 text-xs font-semibold text-coral disabled:opacity-50"
            >
              Elutasítás
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(() => testConnectorDraft({ draftId: draft.draftId }), 'Sandbox-teszt lefutott.')
              }
              className="rounded-md border border-ink/20 px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
            >
              Sandbox-teszt
            </button>
          </div>

          {/* Aktiválás — emberi admin-aktus */}
          {draft.lifecycleState !== 'active' ? (
            <div className="rounded-md border border-ink/12 bg-wash/40 p-3">
              <h4 className="mb-2 font-semibold">Aktiválás (emberi admin-aktus)</h4>
              <div className="grid gap-2 sm:grid-cols-3">
                <label className="text-xs">
                  <span className="mb-1 block text-ink-soft">Secret-alias</span>
                  <input
                    className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5"
                    value={secretAlias}
                    onChange={(e) => setSecretAlias(e.target.value)}
                    placeholder="acme-crm-service-key"
                  />
                </label>
                <label className="text-xs">
                  <span className="mb-1 block text-ink-soft">Kritikusság</span>
                  <select
                    className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5"
                    value={criticality}
                    onChange={(e) => setCriticality(e.target.value as typeof criticality)}
                  >
                    <option value="L1">L1</option>
                    <option value="L2">L2 (dual-control)</option>
                    <option value="L3">L3 (dual-control)</option>
                  </select>
                </label>
                <label className="text-xs">
                  <span className="mb-1 block text-ink-soft">2. jóváhagyó (≠ reviewer)</span>
                  <input
                    className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5"
                    value={approverId}
                    onChange={(e) => setApproverId(e.target.value)}
                    placeholder="user-id (dual-control esetén)"
                  />
                </label>
              </div>
              <button
                type="button"
                disabled={pending || !secretAlias.trim()}
                onClick={() =>
                  run(
                    () =>
                      activateConnector({
                        draftId: draft.draftId,
                        secretAlias,
                        criticality,
                        approverId: approverId.trim() || undefined,
                      }),
                    'Connector aktiválva.',
                  )
                }
                className="mt-2 rounded-md bg-ink px-3 py-1.5 text-xs font-semibold text-paper disabled:opacity-50"
              >
                Aktiválás
              </button>
            </div>
          ) : (
            <div className="rounded-md border border-ink/12 bg-wash/40 p-3">
              <h4 className="mb-2 font-semibold">Hozzárendelés agenthez (emberi admin-aktus)</h4>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs">
                  <span className="mb-1 block text-ink-soft">Agent-id</span>
                  <input
                    className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5"
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    placeholder="agent-id"
                  />
                </label>
                <label className="text-xs">
                  <span className="mb-1 block text-ink-soft">Hozzáférés</span>
                  <select
                    className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5"
                    value={accessMode}
                    onChange={(e) => setAccessMode(e.target.value as typeof accessMode)}
                  >
                    <option value="read">read</option>
                    <option value="write">write</option>
                  </select>
                </label>
              </div>
              <button
                type="button"
                disabled={pending || !agentId.trim()}
                onClick={() =>
                  run(
                    () =>
                      assignConnectorToAgent({
                        connectorId: draft.connectorId,
                        agentId,
                        accessMode,
                      }),
                    'Hozzárendelve.',
                  )
                }
                className="mt-2 rounded-md bg-ink px-3 py-1.5 text-xs font-semibold text-paper disabled:opacity-50"
              >
                Hozzárendelés
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
