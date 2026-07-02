'use client'

import { type ChangeEvent, useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import { Badge, Card } from '@/components/ui/shell'
import {
  activateConnector,
  assignConnectorToAgent,
  createConnectorDraft,
  discoverConnectorFromName,
  draftConfigFromApiDoc,
  extendEgressAllowlist,
  listProvisioningAssignableAgents,
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
  /** §9: az allowlisten még nem szereplő egress-hostok — inline bővítés-akcióhoz. */
  unknownHosts?: string[]
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
type AgentOption = {
  id: string
  name: string
}
type SensitivityFinding = {
  level: 'clean' | 'sensitive' | 'forbidden'
  category: string
  line: number
  column: number
  snippet: string
}
type DraftConfigFromDocData =
  | { config: DraftConfig; requiresSensitivityReview: false }
  | {
      requiresSensitivityReview: true
      sensitivity: {
        level: 'forbidden'
        matchedCategory?: string
        findings: SensitivityFinding[]
      }
    }

type DiscoverySource = {
  urlHash: string
  host: string
  sourceType: 'official' | 'vendor_doc'
  contentHash: string
  bytes: number
  fetchedAt: string
}
type DiscoverData =
  | {
      requiresSensitivityReview: false
      config: DraftConfig
      provenance: { queryHash: string; sources: DiscoverySource[] }
    }
  | {
      requiresSensitivityReview: true
      sensitivity: { level: 'forbidden'; matchedCategory?: string; findings: SensitivityFinding[] }
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

const API_DOC_FILE_EXTENSIONS = [
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.markdown',
  '.txt',
  '.html',
  '.htm',
  '.xml',
  '.wsdl',
  '.raml',
  '.apib',
  '.graphql',
  '.gql',
  '.har',
] as const
const API_DOC_FILE_ACCEPT = API_DOC_FILE_EXTENSIONS.join(',')
const MAX_API_DOC_FILE_BYTES = 2 * 1024 * 1024

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
  const [agents, setAgents] = useState<AgentOption[]>([])
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
  const [docSourceRef, setDocSourceRef] = useState<string | null>(null)
  const [sensitivityFindings, setSensitivityFindings] = useState<SensitivityFinding[]>([])
  const [generating, setGenerating] = useState(false)

  // Kapcsolat felfedezése névből (WebFetch-Egress §12.2)
  const [knownDomain, setKnownDomain] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [discoverySources, setDiscoverySources] = useState<DiscoverySource[]>([])

  const reload = useCallback(() => {
    startTransition(async () => {
      const [d, a] = await Promise.all([listProvisioningDrafts(), listProvisioningAssignableAgents()])
      if (d.success) setDrafts(d.data as DraftRow[])
      else setError(d.error)
      if (a.success) setAgents(a.data)
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

  const onGenerate = useCallback((sensitivityReviewAccepted = false) => {
    setError(null)
    setNotice(null)
    setGenerating(true)
    startTransition(async () => {
      const res = await draftConfigFromApiDoc({
        docText,
        providerHint: name.trim() || undefined,
        sensitivityReviewAccepted,
      })
      setGenerating(false)
      if (res.success) {
        const data = res.data as DraftConfigFromDocData
        if (data.requiresSensitivityReview) {
          setSensitivityFindings(data.sensitivity.findings)
          setNotice(null)
          return
        }
        setSensitivityFindings([])
        setConfigText(JSON.stringify(data.config, null, 2))
        if (!name.trim() && data.config?.provider) {
          setName(data.config.provider)
        }
        setNotice(
          'Config-jelölt generálva. Nézd át, majd hozd létre a draftot — a validátor a létrehozás után dönt.',
        )
      } else {
        setError(res.error)
      }
    })
  }, [docText, name])

  const onDiscover = useCallback((sensitivityReviewAccepted = false) => {
    setError(null)
    setNotice(null)
    setDiscovering(true)
    startTransition(async () => {
      const res = await discoverConnectorFromName({
        connectorName: name.trim(),
        knownDomain: knownDomain.trim() || undefined,
        sensitivityReviewAccepted,
      })
      setDiscovering(false)
      if (res.success) {
        const data = res.data as DiscoverData
        if (data.requiresSensitivityReview) {
          setSensitivityFindings(data.sensitivity.findings)
          return
        }
        setSensitivityFindings([])
        setDiscoverySources(data.provenance.sources)
        setConfigText(JSON.stringify(data.config, null, 2))
        setSourceType('api_doc')
        if (data.config?.provider && !name.trim()) setName(data.config.provider)
        setNotice(
          'Felfedezés kész — config-jelölt a lenti JSON-mezőbe került. Nézd át; a validátor a draft létrehozása után dönt. Új egress-host esetén az aktiválás előtt allowlist-bővítés kell.',
        )
      } else {
        setError(res.error)
      }
    })
  }, [name, knownDomain])

  const onApiDocFileChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setError(null)
    setNotice(null)

    const normalizedName = file.name.toLowerCase()
    const supported = API_DOC_FILE_EXTENSIONS.some((ext) => normalizedName.endsWith(ext))
    if (!supported) {
      setDocSourceRef(null)
      setError(
        `Nem támogatott API-doksi fájltípus. Támogatott: ${API_DOC_FILE_EXTENSIONS.join(', ')}`,
      )
      e.target.value = ''
      return
    }
    if (file.size > MAX_API_DOC_FILE_BYTES) {
      setDocSourceRef(null)
      setError('A fájl túl nagy. Legfeljebb 2 MB-os API-dokumentáció tölthető be.')
      e.target.value = ''
      return
    }

    try {
      const text = await file.text()
      if (!text.trim()) {
        setDocSourceRef(null)
        setError('A kiválasztott fájl üres.')
        e.target.value = ''
        return
      }
      setDocText(text)
      setDocSourceRef(file.name)
      setSensitivityFindings([])
      if (/(openapi|swagger)/.test(normalizedName)) {
        setSourceType('openapi')
      } else {
        setSourceType('api_doc')
      }
      setNotice(`${file.name} betöltve. A tartalom a generálási mezőbe került.`)
    } catch {
      setDocSourceRef(null)
      setError('Nem sikerült beolvasni a fájlt.')
    } finally {
      e.target.value = ''
    }
  }, [])

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
          sourceRef: docSourceRef ?? undefined,
          sourceContent: docText.trim() || undefined,
          generatedConfig: parsed,
        }),
      'Draft létrehozva.',
    )
  }, [configText, docSourceRef, docText, name, sourceType, run])

  const openDrafts = drafts.filter((d) => d.lifecycleState !== 'active')
  const activatedDrafts = drafts.filter((d) => d.lifecycleState === 'active')
  const createDisabledReason = pending
    ? 'Folyamatban lévő művelet miatt várakozik.'
    : !name.trim()
      ? 'Adj nevet a draft connectornak.'
      : !configText.trim()
        ? 'Előbb generálj vagy adj meg config-deskriptort.'
        : null

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
        <div className="mt-3 rounded-md border border-sage/25 bg-sage/5 p-3">
          <span className="mb-1 block text-sm font-semibold">
            Kapcsolat felfedezése névből (web-egress role)
          </span>
          <p className="mb-2 text-xs text-ink-soft">
            Add meg a kapcsolat nevét — a web-egress role agent a weben megkeresi és{' '}
            <strong>adatként</strong> letölti a spec dokumentációját (csak <em>official/vendor_doc</em>{' '}
            forrás), és config-jelöltet ad. A letöltött tartalom sosem utasítás; a jelölt a lenti
            JSON-mezőbe kerül. Alapból kikapcsolt funkció (flag mögött).
          </p>
          <label className="mb-2 block text-xs">
            <span className="mb-1 block text-ink-soft">Ismert doksi-domain (opcionális, ajánlott)</span>
            <input
              className="w-full rounded-md border border-ink/15 bg-paper px-3 py-2"
              value={knownDomain}
              onChange={(e) => setKnownDomain(e.target.value)}
              placeholder="developers.google.com"
            />
          </label>
          <button
            type="button"
            disabled={pending || discovering || !name.trim()}
            onClick={() => onDiscover(false)}
            className="rounded-md border border-sage/40 bg-sage/10 px-3 py-1.5 text-xs font-semibold text-sage disabled:opacity-50"
          >
            {discovering ? 'Felfedezés…' : 'Felfedezés'}
          </button>
          {!name.trim() ? (
            <p className="mt-1 text-xs text-ink-soft">Adj nevet a fenti mezőben a felfedezéshez.</p>
          ) : null}
          {discoverySources.length > 0 ? (
            <div className="mt-2 space-y-1">
              <p className="text-xs font-semibold text-ink-soft">Források (provenance):</p>
              {discoverySources.map((s) => (
                <div
                  key={s.urlHash}
                  className="flex items-center gap-2 rounded border border-ink/12 bg-paper px-2 py-1 text-[11px]"
                >
                  <span
                    className={
                      s.sourceType === 'official'
                        ? 'rounded bg-sage/15 px-1.5 py-0.5 font-semibold text-sage'
                        : 'rounded bg-sky/15 px-1.5 py-0.5 font-semibold text-sky'
                    }
                  >
                    {s.sourceType}
                  </span>
                  <span className="font-mono text-ink">{s.host}</span>
                  <span className="text-ink-soft">{s.bytes} B</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="mt-3 rounded-md border border-ink/12 bg-wash/40 p-3">
          <span className="mb-1 block text-sm font-semibold">
            Generálás API-doksiból (provisioning-asszisztens)
          </span>
          <p className="mb-2 text-xs text-ink-soft">
            Illeszd be vagy töltsd fel az API-dokumentációt — az asszisztens{' '}
            <strong>adatként</strong> dolgozza fel (nem utasításként), és config-jelöltet ad
            vissza. Ez még <em>nem</em> draft: a jelölt a lenti JSON-mezőbe kerül, te nézed át és
            hozod létre.
          </p>
          <div className="mb-2 flex flex-col gap-1 text-xs text-ink-soft sm:flex-row sm:items-center sm:justify-between">
            <label className="inline-flex w-fit cursor-pointer items-center rounded-md border border-ink/15 bg-paper px-3 py-1.5 font-semibold text-ink hover:border-sage/50">
              <span>API-doksi fájl feltöltése</span>
              <input
                type="file"
                accept={API_DOC_FILE_ACCEPT}
                onChange={onApiDocFileChange}
                className="sr-only"
              />
            </label>
            <span>
              Támogatott: OpenAPI/Swagger JSON vagy YAML, Postman, RAML, API Blueprint, GraphQL,
              WSDL/XML, HAR, Markdown/HTML/TXT.
            </span>
          </div>
          <textarea
            className="h-32 w-full rounded-md border border-ink/15 bg-paper px-3 py-2 font-mono text-xs"
            value={docText}
            onChange={(e) => {
              setDocText(e.target.value)
              setDocSourceRef(null)
              setSensitivityFindings([])
            }}
            placeholder="Pl. 'Acme CRM API. Base URL: https://api.acme-crm.example. GET /v1/contacts — list contacts (scope: contacts.read)…'"
          />
          {docSourceRef ? (
            <p className="mt-1 text-xs text-ink-soft">Betöltött fájl: {docSourceRef}</p>
          ) : null}
          {sensitivityFindings.length > 0 ? (
            <div className="mt-2 rounded-md border border-honey/40 bg-honey/10 p-3 text-xs text-ink">
              <p className="font-semibold text-honey">
                A Gateway kockázatos mintát talált a dokumentumban.
              </p>
              <p className="mt-1 text-ink-soft">
                Ellenőrizd, hogy ezek valódi secret/érzékeny adatok-e. A részletek maszkolva
                jelennek meg; jóváhagyás esetén a döntés auditálva lesz.
              </p>
              <div className="mt-2 space-y-1">
                {sensitivityFindings.map((finding, index) => (
                  <div
                    key={`${finding.category}-${finding.line}-${finding.column}-${index}`}
                    className="rounded border border-honey/30 bg-paper px-2 py-1"
                  >
                    <span className="font-semibold">{finding.category}</span>
                    <span className="text-ink-soft">
                      {' '}
                      - {finding.line}. sor, {finding.column}. oszlop
                    </span>
                    <code className="mt-1 block break-all font-mono text-[11px] text-ink-soft">
                      {finding.snippet}
                    </code>
                  </div>
                ))}
              </div>
              <button
                type="button"
                disabled={pending || generating}
                onClick={() => onGenerate(true)}
                className="mt-2 rounded-md border border-honey/50 bg-paper px-3 py-1.5 font-semibold text-honey disabled:opacity-50"
              >
                Átnéztem, nem tartalmaz valódi secretet
              </button>
            </div>
          ) : null}
          <button
            type="button"
            disabled={pending || generating || !docText.trim()}
            onClick={() => onGenerate(false)}
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
          disabled={!!createDisabledReason}
          onClick={onCreate}
          className="mt-3 rounded-md bg-ink px-4 py-2 text-sm font-semibold text-card disabled:opacity-50"
        >
          Draft létrehozása
        </button>
        {createDisabledReason ? (
          <p className="mt-2 text-xs text-ink-soft">{createDisabledReason}</p>
        ) : null}
      </Card>

      <Card title={`Draftok (${openDrafts.length})`}>
        {!loadedOnce ? (
          <p className="text-sm text-ink-soft">Betöltés…</p>
        ) : openDrafts.length === 0 ? (
          <p className="text-sm text-ink-soft">Még nincs draft connector.</p>
        ) : (
          <div className="space-y-3">
            {openDrafts.map((d) => (
              <DraftCard
                key={d.draftId}
                draft={d}
                agents={agents}
                pending={pending}
                run={run}
              />
            ))}
          </div>
        )}
      </Card>

      <Card title={`Aktivált provisioning-kapcsolatok (${activatedDrafts.length})`}>
        {!loadedOnce ? (
          <p className="text-sm text-ink-soft">Betöltés…</p>
        ) : activatedDrafts.length === 0 ? (
          <p className="text-sm text-ink-soft">Nincs provisioningből aktivált kapcsolat.</p>
        ) : (
          <div className="space-y-3">
            {activatedDrafts.map((d) => (
              <DraftCard
                key={d.draftId}
                draft={d}
                agents={agents}
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
  agents,
  pending,
  run,
}: {
  draft: DraftRow
  agents: AgentOption[]
  pending: boolean
  run: (fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [secretAlias, setSecretAlias] = useState(draft.secretAliasSuggested ?? '')
  const [apiKey, setApiKey] = useState('')
  const [approverId, setApproverId] = useState('')
  const [criticality, setCriticality] = useState<'L1' | 'L2' | 'L3'>('L1')
  const [agentId, setAgentId] = useState('')
  const [accessMode, setAccessMode] = useState<'read' | 'write'>('read')
  const [agentApiKey, setAgentApiKey] = useState('')

  const v = draft.validationResult
  const cfg = draft.config
  const writeTools = useMemo(
    () => (cfg?.proposedTools ?? []).filter((t) => t.access === 'write'),
    [cfg],
  )
  const selectedAgent = agents.find((agent) => agent.id === agentId)

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
              {(v.checks.egressAllowlist === 'warned' || v.checks.egressAllowlist === 'failed') &&
              (v.unknownHosts?.length ?? 0) > 0 ? (
                <div className="mt-2 rounded border border-honey/40 bg-honey/5 p-2">
                  <p className="text-xs text-ink-soft">
                    Új egress-host(ok) — aktiválás előtt add hozzá az allowlisthez (§9, auditált
                    admin-aktus):
                  </p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {v.unknownHosts!.map((h) => (
                      <button
                        key={h}
                        type="button"
                        disabled={pending}
                        className="rounded border border-ink/20 bg-paper px-2 py-1 font-mono text-xs hover:bg-honey/20 disabled:opacity-50"
                        onClick={() =>
                          run(async () => {
                            const ext = await extendEgressAllowlist({ host: h, draftId: draft.draftId })
                            if (!ext.success) return ext
                            return validateConnectorDraft({ draftId: draft.draftId })
                          }, `Egress-host hozzáadva az allowlisthez: ${h} — újravalidálva.`)
                        }
                      >
                        + {h}
                      </button>
                    ))}
                  </div>
                </div>
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
                run(async () => {
                  const res = await testConnectorDraft({ draftId: draft.draftId })
                  if (!res.success) return { success: false, error: res.error ?? 'Sandbox-teszt sikertelen' }
                  const body = res.data as { ok?: boolean; detail?: string; statusCode?: number }
                  if (!body.ok) {
                    const extra = [
                      body.detail,
                      body.statusCode != null ? `HTTP ${body.statusCode}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                    return {
                      success: false,
                      error: `Sandbox-teszt sikertelen${extra ? `: ${extra}` : ''}`,
                    }
                  }
                  return { success: true }
                }, 'Sandbox-teszt sikeres.')
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
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs">
                  <span className="mb-1 block text-ink-soft">API kulcs</span>
                  <input
                    type="password"
                    className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Kulcs megadása → auto secret-ref"
                  />
                </label>
                <label className="text-xs">
                  <span className="mb-1 block text-ink-soft">
                    Secret-alias{apiKey.trim() ? ' (felülírva, ha kulcsot adsz meg)' : ''}
                  </span>
                  <input
                    className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5 disabled:opacity-40"
                    value={secretAlias}
                    onChange={(e) => setSecretAlias(e.target.value)}
                    placeholder="acme-crm-service-key"
                    disabled={!!apiKey.trim()}
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
                disabled={pending || (!apiKey.trim() && !secretAlias.trim())}
                onClick={() =>
                  run(
                    () =>
                      activateConnector({
                        draftId: draft.draftId,
                        ...(apiKey.trim()
                          ? { apiKey: apiKey.trim() }
                          : { secretAlias: secretAlias.trim() }),
                        criticality,
                        approverId: approverId.trim() || undefined,
                      }),
                    'Connector aktiválva.',
                  )
                }
                className="mt-2 rounded-md bg-ink px-3 py-1.5 text-xs font-semibold text-card disabled:opacity-50"
              >
                Aktiválás
              </button>
            </div>
          ) : (
            <div className="rounded-md border border-ink/12 bg-wash/40 p-3">
              <h4 className="mb-2 font-semibold">Hozzárendelés agenthez (emberi admin-aktus)</h4>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs">
                  <span className="mb-1 block text-ink-soft">Agent</span>
                  <select
                    className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5"
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                  >
                    <option value="">Válassz agentet…</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
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
                <label className="text-xs sm:col-span-2">
                  <span className="mb-1 block text-ink-soft">
                    Per-agent API kulcs{' '}
                    <span className="font-normal text-ink-soft/70">
                      (agent_owned — elhagyható, ha a connector megosztott kulcsát használod)
                    </span>
                  </span>
                  <input
                    type="password"
                    className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5"
                    value={agentApiKey}
                    onChange={(e) => setAgentApiKey(e.target.value)}
                    placeholder="Kulcs megadása → ez az agent saját kulcsát kapja"
                  />
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
                        ...(agentApiKey.trim() ? { apiKey: agentApiKey.trim() } : {}),
                      }),
                    selectedAgent ? `Hozzárendelve: ${selectedAgent.name}.` : 'Hozzárendelve.',
                  )
                }
                className="mt-2 rounded-md bg-ink px-3 py-1.5 text-xs font-semibold text-card disabled:opacity-50"
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
