'use client'

import { type ChangeEvent, useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import { Badge, Card } from '@/components/ui/shell'
import {
  activateConnector,
  assignConnectorToAgent,
  createConnectorFromTemplateAction,
  createConnectorDraft,
  deprecateConnectorTemplateAction,
  decommissionConnector,
  deleteConnectorDraft,
  discoverConnectorFromName,
  draftConfigFromApiDoc,
  fetchApiDocFromUrl,
  extendEgressAllowlist,
  listConnectorTemplatesAction,
  listProvisioningAssignableAgents,
  listProvisioningDrafts,
  reopenConnector,
  reviewConnectorDraft,
  testConnectorDraft,
  testConnectorDraftWithCredentials,
  updateConnectorDraftConfig,
  upsertConnectorTemplateAction,
  validateConnectorDraft,
  type FetchApiDocFromUrlData,
} from '@/app/actions/provisioning'
import { startConnectorOAuth } from '@/app/actions/connector-grants'
import { isResolvableSecretAlias } from '@/domain/provisioning/secret-alias'

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
  provenance?: {
    sourceHash?: string
    extractedAt?: string
    templateId?: string
    templateKey?: string
    templateVersion?: number
    templateOrigin?: 'builtin' | 'custom'
    materializedAt?: string
  }
} | null
type HttpApiConfigView = {
  baseUrl?: string
  authScheme?: string
  isDelegated: boolean
  endpoints: Array<{ method: string; path: string }>
} | null
type GmailConfigView = {
  provider: string
  authUrl: string
  tokenUrl: string
  userInfoUrl?: string
  clientId?: string
  scopes: string[]
  scopeTransform: string
  provenance?: {
    templateId?: string
    templateKey?: string
    templateVersion?: number
    templateOrigin?: 'builtin' | 'custom'
    materializedAt?: string
  }
} | null
type DraftRow = {
  draftId: string
  connectorId: string
  tenantId: string | null
  name: string
  lifecycleState: string
  reviewStatus: string
  validationResult: ValidationResult | null
  sandboxTestOk: boolean | null
  secretAliasSuggested: string | null
  connectorType: string
  authMode: string
  config: DraftConfig
  httpApiView: HttpApiConfigView
  gmailView: GmailConfigView
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
type SensitivityReviewData = {
  level: 'clean' | 'sensitive' | 'forbidden'
  matchedCategory?: string
  findings: SensitivityFinding[]
}
type DraftConfigFromDocData =
  | { config: DraftConfig; requiresSensitivityReview: false; extractionMethod?: 'openapi' | 'llm' }
  | {
      requiresSensitivityReview: true
      sensitivity: SensitivityReviewData
    }

function SensitivityReviewBanner(props: {
  findings: SensitivityFinding[]
  pending: boolean
  busy: boolean
  onAccept: () => void
}) {
  return (
    <div className="mt-2 rounded-md border border-honey/40 bg-honey/10 p-3 text-xs text-ink">
      <p className="font-semibold text-honey">
        Érzékeny mintát találtunk a tartalomban (pl. email, TAJ, adószám).
      </p>
      <p className="mt-1 text-ink-soft">
        Alapból csak helyi modell dolgozhatná fel — de gyakran dummy/példa adat szerepel API-doksikban.
        Ha biztos vagy benne, hogy nem valódi érzékeny adat, folytathatod külső modelllel is.
      </p>
      <div className="mt-2 space-y-1">
        {props.findings.map((finding, index) => (
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
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={props.pending || props.busy}
          onClick={props.onAccept}
          className="rounded-md border border-honey/50 bg-paper px-3 py-1.5 font-semibold text-honey disabled:opacity-50"
        >
          Folytatás — dummy/példa adat
        </button>
      </div>
    </div>
  )
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
      sensitivity: SensitivityReviewData
    }

type CreateStep = 'basics' | 'source' | 'review'
type SourceMethod = 'discover' | 'document' | 'manual' | 'template'
type DraftManageStep = 'inspect' | 'validate' | 'review' | 'sandbox' | 'activate'
type ActiveManageStep = 'inspect' | 'assign' | 'revoke'

type TemplateDescriptor = {
  key: string
  displayName: string
  description?: string
  activationHelp?: string
  connectorType: 'gmail' | 'http_api'
  authMethods: Array<{ kind: 'api_key' | 'bearer' | 'basic' | 'service_oauth2' | 'user_delegated_oauth2' }>
  instanceFields: Array<{
    name: string
    label: string
    type: 'string' | 'secret' | 'scopeSelection' | 'endpointSelection' | 'enum'
    required?: boolean
    secretAliasHint?: string
    enumValues?: string[]
  }>
  scopeCatalog: Array<{ value: string; label: string; description?: string; default?: boolean }>
  endpoints: Array<{ name: string; method: string; path: string; access: 'read' | 'write'; description?: string; default?: boolean }>
}
type ConnectorTemplateRow = {
  id: string
  key: string
  version: number
  origin: 'builtin' | 'custom'
  displayName: string
  description: string | null
  tenantId: string | null
  status: 'active' | 'deprecated' | 'archived'
  descriptor: TemplateDescriptor
}

function templateLineKey(input: {
  key?: string
  origin?: 'builtin' | 'custom'
  tenantId?: string | null
}): string | null {
  if (!input.key) return null
  const origin = input.origin ?? 'builtin'
  return `${origin}:${input.tenantId ?? 'global'}:${input.key}`
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

const EXAMPLE_TEMPLATE_DESCRIPTOR = JSON.stringify(
  {
    key: 'custom-crm',
    displayName: 'Custom CRM',
    description: 'Tenant-scope-olt HTTP API sablon API-kulcsos hitelesítéssel.',
    activationHelp:
      'Írd le röviden, hol hoz létre a user API kulcsot, milyen scopes/jogok kellenek, és mit kell beállítania az aktiválás előtt.',
    baseUrl: 'https://api.custom-crm.example',
    egressHosts: ['api.custom-crm.example'],
    authMethods: [{ kind: 'api_key', header: 'X-Api-Key' }],
    scopeCatalog: [],
    endpoints: [
      {
        name: 'list_customers',
        method: 'GET',
        path: '/v1/customers',
        access: 'read',
        description: 'List customer records.',
        default: true,
      },
    ],
    instanceFields: [
      {
        name: 'apiToken',
        label: 'API token secret alias',
        type: 'secret',
        required: true,
        secretAliasHint: 'custom-crm-api-token',
        target: 'auth.secretAliasSuggested',
      },
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

function inferDocSourceType(sourceRef: string, contentType?: string): 'openapi' | 'api_doc' {
  const normalized = sourceRef.toLowerCase()
  if (/(openapi|swagger)/.test(normalized) || contentType?.includes('json')) {
    return 'openapi'
  }
  return 'api_doc'
}

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
  const [templates, setTemplates] = useState<ConnectorTemplateRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [pending, startTransition] = useTransition()

  // Create-form állapot
  const [name, setName] = useState('')
  const [sourceType, setSourceType] = useState<'api_doc' | 'openapi' | 'manual' | 'template'>('api_doc')
  const [configText, setConfigText] = useState('')
  const [createStep, setCreateStep] = useState<CreateStep>('basics')
  const [sourceMethod, setSourceMethod] = useState<SourceMethod>('discover')

  // F2-P-F: doksi → config-jelölt generálás állapota
  const [docText, setDocText] = useState('')
  const [docSourceRef, setDocSourceRef] = useState<string | null>(null)
  const [docUrl, setDocUrl] = useState('')
  const [docTruncated, setDocTruncated] = useState(false)
  const [fetchingDoc, setFetchingDoc] = useState(false)
  const [sensitivityFindings, setSensitivityFindings] = useState<SensitivityFinding[]>([])
  const [generating, setGenerating] = useState(false)

  // Kapcsolat felfedezése névből (WebFetch-Egress §12.2)
  const [knownDomain, setKnownDomain] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const [discoverySources, setDiscoverySources] = useState<DiscoverySource[]>([])

  // Custom connector-sablon szerkesztő láthatósága (alapból csak egy gomb)
  const [templateEditorOpen, setTemplateEditorOpen] = useState(false)

  // Connector sablon-katalógus
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [templateAuthMethod, setTemplateAuthMethod] =
    useState<TemplateDescriptor['authMethods'][number]['kind']>('api_key')
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({})
  const [templateSecretAliases, setTemplateSecretAliases] = useState<Record<string, string>>({})
  const [selectedScopes, setSelectedScopes] = useState<string[]>([])
  const [selectedEndpoints, setSelectedEndpoints] = useState<string[]>([])
  const [templateEditorText, setTemplateEditorText] = useState(EXAMPLE_TEMPLATE_DESCRIPTOR)
  const [templateTenantScoped, setTemplateTenantScoped] = useState(true)

  const applyTemplateSelection = useCallback((template: ConnectorTemplateRow) => {
    const descriptor = template.descriptor
    setSelectedTemplateId(template.id)
    setTemplateAuthMethod(descriptor.authMethods[0]?.kind ?? 'api_key')
    setSelectedScopes(descriptor.scopeCatalog.filter((s) => s.default).map((s) => s.value))
    setSelectedEndpoints(descriptor.endpoints.filter((e) => e.default !== false).map((e) => e.name))
    setTemplateValues({})
    setTemplateSecretAliases(
      descriptor.connectorType === 'gmail'
        ? {}
        : Object.fromEntries(
            descriptor.instanceFields
              .filter((field) => field.type === 'secret' && field.secretAliasHint)
              .map((field) => [field.name, field.secretAliasHint ?? '']),
          ),
    )
  }, [])

  const reload = useCallback(() => {
    startTransition(async () => {
      const [d, a, t] = await Promise.all([
        listProvisioningDrafts(),
        listProvisioningAssignableAgents(),
        listConnectorTemplatesAction(),
      ])
      if (d.success) setDrafts(d.data as DraftRow[])
      else setError(d.error)
      if (a.success) setAgents(a.data)
      if (t.success) {
        const rows = t.data as ConnectorTemplateRow[]
        setTemplates(rows)
        if (!selectedTemplateId && rows[0]) applyTemplateSelection(rows[0])
      }
      setLoadedOnce(true)
    })
  }, [applyTemplateSelection, selectedTemplateId])

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
          setNotice(
            'Érzékeny mintát találtunk a dokumentumban. Ha dummy/példa adat, folytathatod a gombbal.',
          )
          return
        }
        setSensitivityFindings([])
        setConfigText(JSON.stringify(data.config, null, 2))
        if (!name.trim() && data.config?.provider) {
          setName(data.config.provider)
        }
        if (data.extractionMethod === 'openapi') {
          setSourceType('openapi')
        }
        setNotice(
          data.extractionMethod === 'openapi'
            ? 'OpenAPI spec felismerve — config-jelölt determinisztikusan kinyerve (LLM nélkül). Nézd át, majd hozd létre a draftot.'
            : 'Config-jelölt generálva. Nézd át, majd hozd létre a draftot — a validátor a létrehozás után dönt.',
        )
        setCreateStep('review')
      } else {
        setError(res.error)
      }
    })
  }, [docText, name])

  const onFetchDocFromUrl = useCallback(() => {
    const url = docUrl.trim()
    if (!url) {
      setError('Add meg az API-doksi vagy OpenAPI URL-jét.')
      return
    }
    setError(null)
    setNotice(null)
    setFetchingDoc(true)
    startTransition(async () => {
      const res = await fetchApiDocFromUrl({ url })
      setFetchingDoc(false)
      if (res.success) {
        const data = res.data as FetchApiDocFromUrlData
        setDocText(data.docText)
        setDocSourceRef(data.sourceUrl)
        setDocTruncated(data.truncated)
        setSensitivityFindings([])
        setSourceType(inferDocSourceType(data.sourceUrl, data.contentType))
        setNotice(
          data.truncated
            ? 'Dokumentum letöltve (csonkolva a méretlimit miatt). Ellenőrizd a tartalmat, majd generálj config-jelöltet.'
            : 'Dokumentum letöltve. Ellenőrizd a tartalmat alább, majd kattints a Config-jelölt generálására.',
        )
      } else {
        setError(res.error)
      }
    })
  }, [docUrl])

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
          setNotice(
            'Érzékeny mintát találtunk a letöltött dokumentumban. Ha dummy/példa adat, folytathatod a gombbal.',
          )
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
        setCreateStep('review')
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
      setDocTruncated(false)
      setSensitivityFindings([])
      setSourceType(inferDocSourceType(file.name))
      setNotice(`${file.name} betöltve. A tartalom a generálási mezőbe került.`)
    } catch {
      setDocSourceRef(null)
      setError('Nem sikerült beolvasni a fájlt.')
    } finally {
      e.target.value = ''
    }
  }, [])

  const openDrafts = drafts.filter((d) => d.lifecycleState !== 'active')
  const activatedDrafts = drafts.filter((d) => d.lifecycleState === 'active')
  const latestTemplateVersions = useMemo(() => {
    const versions: Record<string, number> = {}
    for (const template of templates) {
      const key = templateLineKey(template)
      if (!key) continue
      versions[key] = Math.max(versions[key] ?? 0, template.version)
    }
    return versions
  }, [templates])
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? templates[0]
  const selectedTemplateDescriptor = selectedTemplate?.descriptor
  const isGmailTemplate = selectedTemplateDescriptor?.connectorType === 'gmail'
  const effectiveTemplateAuthMethod =
    selectedTemplateDescriptor?.authMethods.find((m) => m.kind === templateAuthMethod)?.kind ??
    selectedTemplateDescriptor?.authMethods[0]?.kind ??
    templateAuthMethod
  const templateRequiredFields = selectedTemplateDescriptor?.instanceFields.filter((f) => f.required !== false) ?? []
  const templateReady =
    sourceMethod === 'template' &&
    !!selectedTemplate &&
    !!name.trim() &&
    templateRequiredFields.every((field) => {
      const source = field.type === 'secret' ? templateSecretAliases : templateValues
      return !!source[field.name]?.trim()
    })

  const onCreate = useCallback(() => {
    if (sourceMethod === 'template') {
      if (!selectedTemplate) {
        setError('Válassz connector-sablont.')
        return
      }
      run(
        () =>
          createConnectorFromTemplateAction({
            templateId: selectedTemplate.id,
            name,
            authMethodKind: effectiveTemplateAuthMethod,
            instanceValues: templateValues,
            secretAliases: templateSecretAliases,
            selectedScopes,
            selectedEndpoints,
          }),
        'Sablonból draft connector létrehozva.',
      )
      return
    }
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
  }, [
    configText,
    docSourceRef,
    docText,
    effectiveTemplateAuthMethod,
    name,
    run,
    selectedEndpoints,
    selectedScopes,
    selectedTemplate,
    sourceMethod,
    sourceType,
    templateSecretAliases,
    templateValues,
  ])

  const stepOrder: CreateStep[] = ['basics', 'source', 'review']
  const activeStepIndex = stepOrder.indexOf(createStep)
  const canEnterSource = name.trim().length > 0
  const canEnterReview = canEnterSource && (sourceMethod === 'template' ? templateReady : configText.trim().length > 0)
  const setWizardStep = (step: CreateStep) => {
    if (step === 'source' && !canEnterSource) return
    if (step === 'review' && !canEnterReview) return
    setCreateStep(step)
  }
  const createDisabledReason = pending
    ? 'Folyamatban lévő művelet miatt várakozik.'
    : !name.trim()
      ? 'Adj nevet a draft connectornak.'
      : sourceMethod === 'template' && !selectedTemplate
        ? 'Válassz connector-sablont.'
      : sourceMethod === 'template' && !templateReady
        ? 'Töltsd ki a sablon kötelező mezőit.'
      : sourceMethod !== 'template' && !configText.trim()
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

      <ErrorDialog message={error} onClose={() => setError(null)} />
      {notice ? (
        <div className="rounded-lg border border-sage/40 bg-sage/10 px-4 py-3 text-sm text-sage">
          {notice}
        </div>
      ) : null}

      <Card title="Új draft connector">
        <div className="grid gap-5 lg:grid-cols-[15rem_1fr]">
          <ol className="space-y-2">
            {[
              { id: 'basics' as const, label: 'Alapadatok', hint: name.trim() || 'Connector neve' },
              {
                id: 'source' as const,
                label: 'Forrás',
                hint:
                  sourceMethod === 'template'
                    ? 'Sablon-katalógus'
                    : sourceMethod === 'discover'
                    ? 'Webes felfedezés'
                    : sourceMethod === 'document'
                      ? 'API-dokumentáció'
                      : 'Kézi JSON',
              },
              {
                id: 'review' as const,
                label: 'Ellenőrzés',
                hint: configText.trim() ? 'Config-jelölt kész' : 'Config-jelölt kell',
              },
            ].map((step, index) => {
              const active = createStep === step.id
              const complete =
                (step.id === 'basics' && canEnterSource) ||
                (step.id === 'source' && canEnterReview) ||
                (step.id === 'review' && !createDisabledReason)
              const locked =
                (step.id === 'source' && !canEnterSource) || (step.id === 'review' && !canEnterReview)
              return (
                <li key={step.id}>
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => setWizardStep(step.id)}
                    className={`flex w-full items-start gap-3 rounded-md border px-3 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
                      active
                        ? 'border-coral/45 bg-coral/8'
                        : complete
                          ? 'border-sage/35 bg-sage/8'
                          : 'border-ink/12 bg-paper hover:border-coral/25'
                    }`}
                  >
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                        complete ? 'bg-sage text-card' : active ? 'bg-coral text-card' : 'bg-night-2 text-ink-soft'
                      }`}
                    >
                      {complete ? '✓' : index + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{step.label}</span>
                      <span className="block truncate text-xs text-ink-soft">{step.hint}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>

          <div className="min-w-0 rounded-md border border-ink/12 bg-wash/35 p-4">
            {createStep === 'basics' ? (
              <div className="space-y-4">
                <div>
                  <h3 className="text-base font-semibold">1. Nevezd el a kapcsolatot</h3>
                  <p className="mt-1 text-xs text-ink-soft">
                    Ez alapján készül a draft azonosítható, admin által ellenőrizhető connectorrá.
                  </p>
                </div>
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
                      <option value="template">template</option>
                    </select>
                  </label>
                </div>
              </div>
            ) : null}

            {createStep === 'source' ? (
              <div className="space-y-4">
                <div>
                  <h3 className="text-base font-semibold">2. Válassz forrást</h3>
                  <p className="mt-1 text-xs text-ink-soft">
                    A folyamat egy config-jelöltig visz. A draftot csak a következő lépésben hozod létre.
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-4">
                  {[
                    { id: 'template' as const, label: 'Sablon', hint: 'Katalógusból' },
                    { id: 'discover' as const, label: 'Felfedezés', hint: 'Név és domain alapján' },
                    { id: 'document' as const, label: 'API-doksi', hint: 'Feltöltés vagy beillesztés' },
                    { id: 'manual' as const, label: 'Kézi JSON', hint: 'Saját deszkriptor' },
                  ].map((method) => (
                    <button
                      key={method.id}
                      type="button"
                      onClick={() => {
                        setSourceMethod(method.id)
                        if (method.id === 'template') setSourceType('template')
                        if (method.id === 'manual') setSourceType('manual')
                        if (method.id !== 'manual' && method.id !== 'template' && sourceType !== 'api_doc') setSourceType('api_doc')
                      }}
                      className={`rounded-md border px-3 py-3 text-left ${
                        sourceMethod === method.id
                          ? 'border-coral/45 bg-coral/8'
                          : 'border-ink/12 bg-paper hover:border-coral/25'
                      }`}
                    >
                      <span className="block text-sm font-semibold">{method.label}</span>
                      <span className="mt-1 block text-xs text-ink-soft">{method.hint}</span>
                    </button>
                  ))}
                </div>

                {sourceMethod === 'template' ? (
                  <div className="space-y-3 rounded-md border border-sage/25 bg-sage/5 p-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <span className="block text-sm font-semibold">Connector sablon-katalógus</span>
                        <p className="mt-1 text-xs text-ink-soft">
                          A sablon provider-metaadatból és instance-mezőkből önhordó draft configot készít.
                        </p>
                      </div>
                      <Badge tone="neutral">{templates.length} sablon</Badge>
                    </div>

                    {templates.length === 0 ? (
                      <p className="text-xs text-ink-soft">Nincs elérhető connector-sablon.</p>
                    ) : (
                      <>
                        <label className="block text-xs">
                          <span className="mb-1 block text-ink-soft">Sablon</span>
                          <select
                            className="w-full rounded-md border border-ink/15 bg-paper px-3 py-2"
                            value={selectedTemplate?.id ?? ''}
                            onChange={(e) => {
                              const template = templates.find((t) => t.id === e.target.value)
                              if (template) applyTemplateSelection(template)
                            }}
                          >
                            {templates.map((template) => (
                              <option key={template.id} value={template.id}>
                                {template.displayName} v{template.version} ({template.origin})
                              </option>
                            ))}
                          </select>
                        </label>

                        {selectedTemplateDescriptor ? (
                          <div className="space-y-3">
                            {selectedTemplate.description ? (
                              <p className="text-xs text-ink-soft">{selectedTemplate.description}</p>
                            ) : null}

                            <div>
                              <span className="mb-1 block text-xs font-semibold text-ink-soft">Auth method</span>
                              <div className="flex flex-wrap gap-2">
                                {selectedTemplateDescriptor.authMethods.map((method) => (
                                  <label
                                    key={method.kind}
                                    className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-semibold ${
                                      effectiveTemplateAuthMethod === method.kind
                                        ? 'border-coral/45 bg-coral/8'
                                        : 'border-ink/12 bg-paper'
                                    }`}
                                  >
                                    <input
                                      type="radio"
                                      checked={effectiveTemplateAuthMethod === method.kind}
                                      onChange={() => setTemplateAuthMethod(method.kind)}
                                    />
                                    {method.kind}
                                  </label>
                                ))}
                              </div>
                            </div>

                            {selectedTemplateDescriptor.instanceFields.length > 0 && !isGmailTemplate ? (
                              <div className="grid gap-3 sm:grid-cols-2">
                                {selectedTemplateDescriptor.instanceFields.map((field) => {
                                  const value =
                                    field.type === 'secret'
                                      ? templateSecretAliases[field.name] ?? ''
                                      : templateValues[field.name] ?? ''
                                  return (
                                    <label key={field.name} className="text-xs">
                                      <span className="mb-1 block text-ink-soft">
                                        {field.label}
                                        {field.required === false ? ' (opcionális)' : ''}
                                      </span>
                                      {field.type === 'enum' && field.enumValues ? (
                                        <select
                                          className="w-full rounded-md border border-ink/15 bg-paper px-3 py-2"
                                          value={value}
                                          onChange={(e) =>
                                            setTemplateValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                                          }
                                        >
                                          <option value="">Válassz…</option>
                                          {field.enumValues.map((option) => (
                                            <option key={option} value={option}>
                                              {option}
                                            </option>
                                          ))}
                                        </select>
                                      ) : (
                                        <input
                                          className="w-full rounded-md border border-ink/15 bg-paper px-3 py-2"
                                          value={value}
                                          onChange={(e) => {
                                            const setter =
                                              field.type === 'secret'
                                                ? setTemplateSecretAliases
                                                : setTemplateValues
                                            setter((prev) => ({ ...prev, [field.name]: e.target.value }))
                                          }}
                                          placeholder={
                                            field.type === 'secret'
                                              ? field.secretAliasHint ?? 'secret-alias'
                                              : field.name
                                          }
                                        />
                                      )}
                                    </label>
                                  )
                                })}
                              </div>
                            ) : null}

                            {selectedTemplateDescriptor.scopeCatalog.length > 0 ? (
                              <div>
                                <span className="mb-1 block text-xs font-semibold text-ink-soft">Scope-ok</span>
                                <div className="grid gap-2 sm:grid-cols-2">
                                  {selectedTemplateDescriptor.scopeCatalog.map((scope) => (
                                    <label
                                      key={scope.value}
                                      className="rounded-md border border-ink/12 bg-paper px-3 py-2 text-xs"
                                    >
                                      <span className="flex items-center gap-2 font-semibold">
                                        <input
                                          type="checkbox"
                                          checked={selectedScopes.includes(scope.value)}
                                          onChange={(e) =>
                                            setSelectedScopes((prev) =>
                                              e.target.checked
                                                ? [...new Set([...prev, scope.value])]
                                                : prev.filter((s) => s !== scope.value),
                                            )
                                          }
                                        />
                                        {scope.label}
                                      </span>
                                      <span className="mt-1 block font-mono text-[11px] text-ink-soft">
                                        {scope.value}
                                      </span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                            ) : null}

                            {selectedTemplateDescriptor.endpoints.length > 0 ? (
                              <div>
                                <span className="mb-1 block text-xs font-semibold text-ink-soft">Endpointok</span>
                                <div className="grid gap-2 sm:grid-cols-2">
                                  {selectedTemplateDescriptor.endpoints.map((endpoint) => (
                                    <label
                                      key={endpoint.name}
                                      className="rounded-md border border-ink/12 bg-paper px-3 py-2 text-xs"
                                    >
                                      <span className="flex items-center gap-2 font-semibold">
                                        <input
                                          type="checkbox"
                                          checked={selectedEndpoints.includes(endpoint.name)}
                                          onChange={(e) =>
                                            setSelectedEndpoints((prev) =>
                                              e.target.checked
                                                ? [...new Set([...prev, endpoint.name])]
                                                : prev.filter((name) => name !== endpoint.name),
                                            )
                                          }
                                        />
                                        {endpoint.name}
                                      </span>
                                      <span className="mt-1 block font-mono text-[11px] text-ink-soft">
                                        {endpoint.method} {endpoint.path}
                                      </span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}

                {sourceMethod === 'discover' ? (
                  <div className="rounded-md border border-sage/25 bg-sage/5 p-3">
                    <span className="mb-1 block text-sm font-semibold">
                      Kapcsolat felfedezése névből (web-egress role)
                    </span>
                    <p className="mb-2 text-xs text-ink-soft">
                      Add meg a kapcsolat nevét; a web-egress role agent csak official/vendor_doc
                      forrásból készít config-jelöltet.
                    </p>
                    <label className="mb-2 block text-xs">
                      <span className="mb-1 block text-ink-soft">
                        Ismert doksi-domain (opcionális, ajánlott)
                      </span>
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
                    {sensitivityFindings.length > 0 && sourceMethod === 'discover' ? (
                      <SensitivityReviewBanner
                        findings={sensitivityFindings}
                        pending={pending}
                        busy={discovering}
                        onAccept={() => onDiscover(true)}
                      />
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
                ) : null}

                {sourceMethod === 'document' ? (
                  <div className="rounded-md border border-ink/12 bg-paper p-3">
                    <span className="mb-1 block text-sm font-semibold">
                      Generálás API-doksiból (provisioning-asszisztens)
                    </span>
                    <div className="mb-3 rounded-md border border-sage/25 bg-sage/5 p-3">
                      <span className="mb-1 block text-xs font-semibold text-ink">
                        1. lépés — letöltés URL-ről
                      </span>
                      <p className="mb-2 text-xs text-ink-soft">
                        Add meg a publikus OpenAPI vagy API-doksi URL-t. A platform letölti, te
                        átnézed a tartalmat, majd a provisioning-asszisztens generál config-jelöltet.
                      </p>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <input
                          type="url"
                          className="min-w-0 flex-1 rounded-md border border-ink/15 bg-paper px-3 py-2 font-mono text-xs"
                          value={docUrl}
                          onChange={(e) => setDocUrl(e.target.value)}
                          placeholder="https://példa.app/api/v1/openapi.json"
                        />
                        <button
                          type="button"
                          disabled={pending || fetchingDoc || !docUrl.trim()}
                          onClick={onFetchDocFromUrl}
                          className="shrink-0 rounded-md border border-sage/40 bg-sage/10 px-3 py-1.5 text-xs font-semibold text-sage disabled:opacity-50"
                        >
                          {fetchingDoc ? 'Letöltés…' : 'Letöltés'}
                        </button>
                      </div>
                    </div>
                    <div className="mb-2 flex flex-col gap-1 text-xs text-ink-soft sm:flex-row sm:items-center sm:justify-between">
                      <span className="font-semibold text-ink">2. lépés — átnézés vagy fájlfeltöltés</span>
                      <label className="inline-flex w-fit cursor-pointer items-center rounded-md border border-ink/15 bg-paper px-3 py-1.5 font-semibold text-ink hover:border-sage/50">
                        <span>API-doksi fájl feltöltése</span>
                        <input
                          type="file"
                          accept={API_DOC_FILE_ACCEPT}
                          onChange={onApiDocFileChange}
                          className="sr-only"
                        />
                      </label>
                    </div>
                    <p className="mb-2 text-xs text-ink-soft">
                      OpenAPI JSON/YAML automatikusan felismerésre kerül és determinisztikusan
                      feldolgozódik; egyéb formátumoknál (Markdown, próza) az asszisztens LLM-et
                      használ. Támogatott: OpenAPI, Postman, RAML, GraphQL, WSDL/XML, HAR,
                      Markdown/HTML/TXT.
                    </p>
                    <textarea
                      className="h-40 w-full rounded-md border border-ink/15 bg-paper px-3 py-2 font-mono text-xs"
                      value={docText}
                      onChange={(e) => {
                        setDocText(e.target.value)
                        setDocSourceRef(null)
                        setDocTruncated(false)
                        setSensitivityFindings([])
                      }}
                      placeholder="Pl. 'Acme CRM API. Base URL: https://api.acme-crm.example. GET /v1/contacts...'"
                    />
                    {docSourceRef ? (
                      <p className="mt-1 text-xs text-ink-soft">
                        Forrás: {docSourceRef}
                        {docTruncated ? (
                          <span className="ml-2 font-semibold text-honey">
                            (csonkolva — a teljes spec túl nagy volt)
                          </span>
                        ) : null}
                      </p>
                    ) : null}
                    {sensitivityFindings.length > 0 && sourceMethod === 'document' ? (
                      <SensitivityReviewBanner
                        findings={sensitivityFindings}
                        pending={pending}
                        busy={generating}
                        onAccept={() => onGenerate(true)}
                      />
                    ) : null}
                    <button
                      type="button"
                      disabled={pending || generating || !docText.trim()}
                      onClick={() => onGenerate(false)}
                      className="mt-2 rounded-md border border-sage/40 bg-sage/10 px-3 py-1.5 text-xs font-semibold text-sage disabled:opacity-50"
                    >
                      {generating ? 'Generálás…' : '3. lépés — Config-jelölt generálása'}
                    </button>
                  </div>
                ) : null}

                {sourceMethod === 'manual' ? (
                  <div className="rounded-md border border-ink/12 bg-paper p-3">
                    <span className="mb-1 block text-sm font-semibold">Kézi config-deszkriptor</span>
                    <p className="mb-2 text-xs text-ink-soft">
                      Illeszd be a JSON-t, vagy töltsd be a példát, majd lépj tovább ellenőrzésre.
                    </p>
                    <button
                      type="button"
                      className="rounded-md border border-sage/40 bg-sage/10 px-3 py-1.5 text-xs font-semibold text-sage"
                      onClick={() => setConfigText(EXAMPLE_CONFIG)}
                    >
                      Példa betöltése
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {createStep === 'review' ? (
              <div className="space-y-3">
                <div>
                  <h3 className="text-base font-semibold">3. Ellenőrzés és létrehozás</h3>
                  <p className="mt-1 text-xs text-ink-soft">
                    A secret SOSEM kerül ide, csak a Secret Managerbe szánt alias neve javasolt.
                  </p>
                </div>
                {sourceMethod === 'template' && selectedTemplateDescriptor ? (
                  <div className="rounded-md border border-ink/12 bg-paper p-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{selectedTemplate?.displayName}</span>
                      <Badge tone="neutral">v{selectedTemplate?.version}</Badge>
                      <Badge tone={selectedTemplate?.origin === 'builtin' ? 'success' : 'warning'}>
                        {selectedTemplate?.origin}
                      </Badge>
                      <Badge tone="neutral">{effectiveTemplateAuthMethod}</Badge>
                    </div>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <div>
                        <h4 className="font-semibold">Mezők</h4>
                        <ul className="mt-1 space-y-1">
                          {selectedTemplateDescriptor.instanceFields.map((field) => (
                            <li key={field.name} className="flex justify-between gap-2">
                              <span className="text-ink-soft">{field.label}</span>
                              <code className="truncate">
                                {field.type === 'secret'
                                  ? templateSecretAliases[field.name] || '—'
                                  : templateValues[field.name] || '—'}
                              </code>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <h4 className="font-semibold">Kiválasztás</h4>
                        <p className="mt-1 text-ink-soft">
                          Scope: {selectedScopes.length || 0} · endpoint: {selectedEndpoints.length || 0}
                        </p>
                        <p className="mt-1 text-ink-soft">
                          A materializer szerveroldalon validálja a mezőket, majd ugyanazt a draft-kaput hívja.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <label className="block text-sm">
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
                      className="h-72 w-full rounded-md border border-ink/15 bg-paper px-3 py-2 font-mono text-xs"
                      value={configText}
                      onChange={(e) => setConfigText(e.target.value)}
                      placeholder={EXAMPLE_CONFIG}
                    />
                  </label>
                )}
                {createDisabledReason ? (
                  <p className="text-xs text-ink-soft">{createDisabledReason}</p>
                ) : null}
              </div>
            ) : null}

            <div className="mt-5 flex flex-col gap-2 border-t border-ink/10 pt-4 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="button"
                disabled={activeStepIndex === 0}
                onClick={() => setCreateStep(stepOrder[Math.max(0, activeStepIndex - 1)])}
                className="rounded-md border border-ink/20 px-3 py-2 text-sm font-semibold disabled:opacity-50"
              >
                Vissza
              </button>
              {createStep === 'review' ? (
                <button
                  type="button"
                  disabled={!!createDisabledReason}
                  onClick={onCreate}
                  className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-card disabled:opacity-50"
                >
                  Draft létrehozása
                </button>
              ) : (
                <button
                  type="button"
                  disabled={createStep === 'basics' ? !canEnterSource : !canEnterReview}
                  onClick={() => setCreateStep(stepOrder[Math.min(stepOrder.length - 1, activeStepIndex + 1)])}
                  className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-card disabled:opacity-50"
                >
                  Tovább
                </button>
              )}
            </div>
          </div>
        </div>
      </Card>

      {!templateEditorOpen ? (
        <div>
          <button
            type="button"
            onClick={() => setTemplateEditorOpen(true)}
            className="inline-flex items-center gap-2 rounded-md border border-ink/15 bg-card px-4 py-2 text-sm font-semibold text-ink transition hover:border-coral/40 hover:text-coral-deep"
          >
            Custom connector-sablonok
          </button>
        </div>
      ) : (
      <Card title="Custom connector-sablonok">
        <div className="mb-4 flex justify-end">
          <button
            type="button"
            onClick={() => setTemplateEditorOpen(false)}
            className="rounded-md border border-ink/15 px-3 py-1.5 text-xs font-semibold text-ink-soft transition hover:border-ink/30 hover:text-ink"
          >
            Bezárás
          </button>
        </div>
        <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-base font-semibold">Sablon descriptor</h3>
                <p className="mt-1 text-xs text-ink-soft">
                  Mentéskor új verzió jön létre, és lefut a materializer self-check.
                </p>
              </div>
              <button
                type="button"
                className="rounded-md border border-sage/40 bg-sage/10 px-3 py-1.5 text-xs font-semibold text-sage"
                onClick={() => setTemplateEditorText(EXAMPLE_TEMPLATE_DESCRIPTOR)}
              >
                Példa betöltése
              </button>
            </div>
            <textarea
              className="h-80 w-full rounded-md border border-ink/15 bg-paper px-3 py-2 font-mono text-xs"
              value={templateEditorText}
              onChange={(e) => setTemplateEditorText(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-2 text-xs font-semibold text-ink-soft">
                <input
                  type="checkbox"
                  checked={templateTenantScoped}
                  onChange={(e) => setTemplateTenantScoped(e.target.checked)}
                />
                Tenant-scope
              </label>
              <button
                type="button"
                disabled={pending || !templateEditorText.trim()}
                onClick={() => {
                  let descriptor: unknown
                  try {
                    descriptor = JSON.parse(templateEditorText)
                  } catch {
                    setError('A sablon descriptor nem érvényes JSON.')
                    return
                  }
                  run(
                    () =>
                      upsertConnectorTemplateAction({
                        descriptor,
                        tenantScoped: templateTenantScoped,
                      }),
                    'Connector-sablon mentve új verzióként.',
                  )
                }}
                className="rounded-md bg-ink px-4 py-2 text-xs font-semibold text-card disabled:opacity-50"
              >
                Sablon mentése
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-base font-semibold">Elérhető sablonok</h3>
            {templates.length === 0 ? (
              <p className="text-sm text-ink-soft">Nincs elérhető sablon.</p>
            ) : (
              templates.map((template) => (
                <div key={template.id} className="rounded-md border border-ink/12 bg-paper p-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{template.displayName}</span>
                    <Badge tone="neutral">v{template.version}</Badge>
                    <Badge tone={template.origin === 'builtin' ? 'success' : 'warning'}>
                      {template.origin}
                    </Badge>
                    <Badge tone={template.status === 'active' ? 'success' : 'warning'}>
                      {template.status}
                    </Badge>
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-ink-soft">{template.key}</p>
                  {template.description ? (
                    <p className="mt-1 text-ink-soft">{template.description}</p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="rounded-md border border-ink/20 px-2 py-1 font-semibold"
                      onClick={() => {
                        setTemplateEditorText(JSON.stringify(template.descriptor, null, 2))
                        setTemplateTenantScoped(template.tenantId !== null)
                      }}
                    >
                      Betöltés
                    </button>
                    {template.origin === 'custom' && template.status === 'active' ? (
                      <button
                        type="button"
                        disabled={pending}
                        className="rounded-md border border-honey/40 bg-honey/10 px-2 py-1 font-semibold text-honey disabled:opacity-50"
                        onClick={() =>
                          run(
                            () => deprecateConnectorTemplateAction({ templateId: template.id }),
                            'Connector-sablon deprecated állapotba került.',
                          )
                        }
                      >
                        Deprecate
                      </button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </Card>
      )}

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
                templates={templates}
                latestTemplateVersions={latestTemplateVersions}
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
                templates={templates}
                latestTemplateVersions={latestTemplateVersions}
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

function ErrorDialog({ message, onClose }: { message: string | null; onClose: () => void }) {
  useEffect(() => {
    if (!message) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [message, onClose])

  if (!message) return null

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Hiba"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/40 backdrop-blur-sm"
      />
      <div className="relative w-full max-w-md rounded-xl border border-coral/40 bg-card p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-coral/15 text-lg font-bold text-coral">
            !
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-ink">Hiba</h3>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-soft">{message}</p>
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            autoFocus
            onClick={onClose}
            className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-card"
          >
            Értem
          </button>
        </div>
      </div>
    </div>
  )
}

function DraftCard({
  draft,
  agents,
  templates,
  latestTemplateVersions,
  pending,
  run,
}: {
  draft: DraftRow
  agents: AgentOption[]
  templates: ConnectorTemplateRow[]
  latestTemplateVersions: Record<string, number>
  pending: boolean
  run: (fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [secretAlias, setSecretAlias] = useState(draft.secretAliasSuggested ?? '')
  const [apiKey, setApiKey] = useState('')
  const [clientId, setClientId] = useState(() => draft.gmailView?.clientId ?? '')
  const [approverId, setApproverId] = useState('')
  const [criticality, setCriticality] = useState<'L1' | 'L2' | 'L3'>('L1')
  const [agentId, setAgentId] = useState('')
  const [accessMode, setAccessMode] = useState<'read' | 'write'>('read')
  const [agentApiKey, setAgentApiKey] = useState('')
  const [draftStep, setDraftStep] = useState<DraftManageStep>('inspect')
  const [activeStep, setActiveStep] = useState<ActiveManageStep>('inspect')
  // Javítás: draft-config inline szerkesztése (a gate resetelődik mentéskor).
  const [editingConfig, setEditingConfig] = useState(false)
  const [configDraft, setConfigDraft] = useState('')
  // Takarítás / megszüntetés megerősítése.
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [decommReason, setDecommReason] = useState('')
  const [decommApprover, setDecommApprover] = useState('')
  const [decommCriticality, setDecommCriticality] = useState<'L1' | 'L2' | 'L3'>('L1')
  const [confirmDecomm, setConfirmDecomm] = useState(false)
  const [authTestDetail, setAuthTestDetail] = useState<string | null>(null)

  const v = draft.validationResult
  const cfg = draft.config
  const gmailView = draft.gmailView
  const provenance = cfg?.provenance ?? gmailView?.provenance
  const templateVersionKey = templateLineKey({
    key: provenance?.templateKey,
    origin: provenance?.templateOrigin,
    tenantId: provenance?.templateOrigin === 'custom' ? draft.tenantId : null,
  })
  const latestTemplateVersion = templateVersionKey
    ? latestTemplateVersions[templateVersionKey]
    : undefined
  const templateOutdated =
    typeof provenance?.templateVersion === 'number' &&
    typeof latestTemplateVersion === 'number' &&
    latestTemplateVersion > provenance.templateVersion
  const templateDescriptor =
    (provenance?.templateId
      ? templates.find((template) => template.id === provenance.templateId)
      : undefined)?.descriptor ??
    templates.find(
      (template) =>
        template.key === provenance?.templateKey &&
        template.origin === provenance?.templateOrigin &&
        template.version === provenance?.templateVersion &&
        (template.origin !== 'custom' || template.tenantId === null || template.tenantId === draft.tenantId),
    )?.descriptor ??
    (provenance?.templateKey
      ? templates.find((template) => template.key === provenance.templateKey)?.descriptor
      : undefined)
  const isGmailConnector = draft.connectorType === 'gmail'
  const activationHelp = templateDescriptor?.activationHelp?.trim() ?? ''
  const isActive = draft.lifecycleState === 'active'
  const isUserDelegated =
    isGmailConnector ||
    draft.authMode === 'user_delegated' ||
    cfg?.authMode === 'user_delegated' ||
    draft.httpApiView?.isDelegated === true
  // oauth2 (service VAGY delegált) → nem-titkos client_id-t kell megadni (config.auth.clientId).
  const isOauth2 =
    isGmailConnector ||
    isUserDelegated ||
    draft.httpApiView?.authScheme === 'oauth2' ||
    cfg?.auth?.type === 'oauth2'
  const hasActivationCredentials =
    !!apiKey.trim() ||
    (!!secretAlias.trim() && isResolvableSecretAlias(secretAlias.trim()))
  const hasInvalidSecretAlias =
    !apiKey.trim() && !!secretAlias.trim() && !isResolvableSecretAlias(secretAlias.trim())

  const buildActivationInput = (confirmKeyless?: boolean) => ({
    draftId: draft.draftId,
    ...(apiKey.trim()
      ? { apiKey: apiKey.trim() }
      : secretAlias.trim()
        ? { secretAlias: secretAlias.trim() }
        : {}),
    ...(confirmKeyless ? { confirmKeyless: true as const } : {}),
    ...(isOauth2 && clientId.trim() ? { clientId: clientId.trim() } : {}),
    criticality,
    approverId: approverId.trim() || undefined,
  })

  const handleActivate = () => {
    if (hasInvalidSecretAlias) return
    if (!hasActivationCredentials) {
      const confirmed = window.confirm(
        'Nem adtál meg API-kulcsot vagy érvényes titok-hivatkozást. Biztosan kulcs nélkül aktiválod? Az agent hívásai addig auth hibát fognak adni.',
      )
      if (!confirmed) return
      run(() => activateConnector(buildActivationInput(true)), 'Connector aktiválva (kulcs nélkül).')
      return
    }
    run(() => activateConnector(buildActivationInput()), 'Connector aktiválva.')
  }

  const writeTools = useMemo(
    () => (cfg?.proposedTools ?? []).filter((t) => t.access === 'write'),
    [cfg],
  )
  const selectedAgent = agents.find((agent) => agent.id === agentId)
  const validationReady = !!v && v.status !== 'failed'
  const reviewApproved = draft.reviewStatus === 'approved'
  const sandboxReady = draft.sandboxTestOk === true
  const activationReady = reviewApproved && validationReady && sandboxReady
  const draftSteps: Array<{ id: DraftManageStep; label: string; hint: string; done: boolean }> = [
    { id: 'inspect', label: 'Áttekintés', hint: 'Config és toolok', done: !!cfg || !!draft.httpApiView || !!gmailView },
    { id: 'validate', label: 'Validáció', hint: v ? v.status : 'Még nem futott', done: validationReady },
    { id: 'review', label: 'Review', hint: draft.reviewStatus, done: reviewApproved },
    {
      id: 'sandbox',
      label: 'Sandbox',
      hint: draft.sandboxTestOk === true ? 'ok' : draft.sandboxTestOk === false ? 'fail' : 'Még nem futott',
      done: sandboxReady,
    },
    {
      id: 'activate',
      label: 'Aktiválás',
      hint: activationReady ? 'Készen áll' : 'Előfeltételek kellenek',
      done: isActive,
    },
  ]
  const activeSteps: Array<{ id: ActiveManageStep; label: string; hint: string; done: boolean }> = [
    { id: 'inspect', label: 'Állapot', hint: 'Aktív connector', done: true },
    { id: 'assign', label: 'Hozzárendelés', hint: 'Agent jog', done: false },
    { id: 'revoke', label: 'Megszüntetés', hint: 'Leszerelés + archiválás', done: false },
  ]
  const visibleSteps = isActive ? activeSteps : draftSteps
  const selectedStep = isActive ? activeStep : draftStep
  const setSelectedStep = (step: DraftManageStep | ActiveManageStep) => {
    if (isActive) setActiveStep(step as ActiveManageStep)
    else setDraftStep(step as DraftManageStep)
  }
  const startConfigEdit = () => {
    if (!cfg) return
    setConfigDraft(JSON.stringify(cfg, null, 2))
    setEditingConfig(true)
  }
  const saveConfigEdit = () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(configDraft)
    } catch {
      run(async () => ({ success: false, error: 'A config nem érvényes JSON.' }), '')
      return
    }
    run(async () => {
      const res = await updateConnectorDraftConfig({
        draftId: draft.draftId,
        generatedConfig: parsed,
      })
      if (!res.success) return res
      setEditingConfig(false)
      setDraftStep('validate')
      return res
    }, 'Config frissítve — a validáció/review/sandbox resetelve, futtasd újra a kaput.')
  }
  const configEditor = !isActive && cfg ? (
    <div className="rounded-md border border-ink/12 bg-wash/40 p-3">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold">Config szerkesztése</h4>
        {!editingConfig ? (
          <button
            type="button"
            className="text-xs font-semibold text-sage hover:underline"
            onClick={startConfigEdit}
          >
            Szerkesztés
          </button>
        ) : null}
      </div>
      {editingConfig ? (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-honey">
            A mentés resetteli a kaput: a validáció, a review és a sandbox-teszt is újra
            lefut majd, mielőtt a connector aktiválható lenne.
          </p>
          <textarea
            className="h-64 w-full rounded-md border border-ink/15 bg-paper px-3 py-2 font-mono text-xs"
            value={configDraft}
            onChange={(e) => setConfigDraft(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={saveConfigEdit}
              className="rounded-md bg-ink px-3 py-1.5 text-xs font-semibold text-card disabled:opacity-50"
            >
              Config mentése
            </button>
            <button
              type="button"
              onClick={() => setEditingConfig(false)}
              className="rounded-md border border-ink/20 px-3 py-1.5 text-xs font-semibold"
            >
              Mégse
            </button>
          </div>
        </div>
      ) : null}
    </div>
  ) : null

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
        {isActive ? (
          <Badge tone="success">review: lezárt</Badge>
        ) : (
          <Badge tone={reviewTone(draft.reviewStatus)}>review: {draft.reviewStatus}</Badge>
        )}
        {v ? <Badge tone={statusTone(v.status)}>validation: {v.status}</Badge> : (
          <Badge tone="neutral">validation: —</Badge>
        )}
        {draft.sandboxTestOk === true ? <Badge tone="success">sandbox: ok</Badge> : null}
        {draft.sandboxTestOk === false ? <Badge tone="danger">sandbox: fail</Badge> : null}
        {writeTools.length > 0 ? <Badge tone="warning">{writeTools.length} write-tool</Badge> : null}
        {provenance?.templateKey ? (
          <Badge tone={templateOutdated ? 'warning' : 'neutral'}>
            {provenance.templateKey} v{provenance.templateVersion ?? '?'}
          </Badge>
        ) : null}
        {isActive ? (
          <button
            type="button"
            className="ml-auto rounded-md border border-coral/40 bg-coral/10 px-2.5 py-1 text-xs font-semibold text-coral"
            onClick={() => {
              setOpen(true)
              setActiveStep('revoke')
            }}
          >
            Megszüntetés
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="space-y-4 border-t border-ink/10 px-4 py-4 text-sm">
          <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
            <ol className="space-y-2">
              {visibleSteps.map((step, index) => {
                const active = selectedStep === step.id
                return (
                  <li key={step.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedStep(step.id)}
                      className={`flex w-full items-start gap-3 rounded-md border px-3 py-3 text-left transition ${
                        active
                          ? 'border-coral/45 bg-coral/8'
                          : step.done
                            ? 'border-sage/35 bg-sage/8'
                            : 'border-ink/12 bg-paper hover:border-coral/25'
                      }`}
                    >
                      <span
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                          step.done
                            ? 'bg-sage text-card'
                            : active
                              ? 'bg-coral text-card'
                              : 'bg-night-2 text-ink-soft'
                        }`}
                      >
                        {step.done ? '✓' : index + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold">{step.label}</span>
                        <span className="block truncate text-xs text-ink-soft">{step.hint}</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>

            <div className="min-w-0 space-y-4 rounded-md border border-ink/12 bg-wash/35 p-4">
          {selectedStep === 'inspect' ? (
            <>
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
          ) : gmailView ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h4 className="mb-1 font-semibold">Gmail OAuth</h4>
                <p className="text-xs text-ink-soft">
                  {draft.authMode} · provider: {gmailView.provider}
                </p>
                <ul className="mt-2 space-y-1 font-mono text-xs">
                  <li>
                    <span className="text-ink-soft">authUrl:</span> {gmailView.authUrl}
                  </li>
                  <li>
                    <span className="text-ink-soft">tokenUrl:</span> {gmailView.tokenUrl}
                  </li>
                  {gmailView.userInfoUrl ? (
                    <li>
                      <span className="text-ink-soft">userInfoUrl:</span> {gmailView.userInfoUrl}
                    </li>
                  ) : null}
                  <li>
                    <span className="text-ink-soft">clientId:</span>{' '}
                    {gmailView.clientId?.trim() ? (
                      <code>{gmailView.clientId}</code>
                    ) : (
                      <span className="text-honey">aktiváláskor megadandó</span>
                    )}
                  </li>
                </ul>
              </div>
              <div>
                <h4 className="mb-1 font-semibold">Scope-ok</h4>
                <div className="flex flex-wrap gap-1">
                  {gmailView.scopes.length === 0 ? (
                    <span className="text-xs text-ink-soft">—</span>
                  ) : (
                    gmailView.scopes.map((scope) => (
                      <Badge key={scope} tone="neutral">
                        {scope.replace('https://www.googleapis.com/auth/', '')}
                      </Badge>
                    ))
                  )}
                </div>
                <p className="mt-3 text-xs text-ink-soft">
                  scopeTransform: <code>{gmailView.scopeTransform}</code>
                </p>
                {gmailView.provenance?.templateKey ? (
                  <p className="mt-1 text-xs text-ink-soft">
                    sablon: {gmailView.provenance.templateKey}
                    {gmailView.provenance.templateVersion
                      ? ` v${gmailView.provenance.templateVersion}`
                      : ''}
                  </p>
                ) : null}
              </div>
            </div>
          ) : draft.httpApiView ? (
            // Fallback: a config nem provisioning-ConnectorConfig alakú (pl. az
            // „API-kapcsolat" szerkesztőn átírt http_api config). Secret-mentes read-only nézet.
            <div className="rounded-md bg-honey/5 p-3 text-xs">
              <p className="mb-2 text-ink-soft">
                Ez a kapcsolat az „API-kapcsolat&rdquo; szerkesztőn keresztül lett beállítva
                (http_api futásidejű config).
                {draft.httpApiView.isDelegated
                  ? ' Automatikus hozzájárulású (user-delegált) OAuth.'
                  : ''}
              </p>
              {draft.httpApiView.baseUrl ? (
                <p>
                  <span className="text-ink-soft">Base URL:</span>{' '}
                  <code>{draft.httpApiView.baseUrl}</code>
                </p>
              ) : null}
              {draft.httpApiView.authScheme ? (
                <p>
                  <span className="text-ink-soft">Auth:</span> {draft.authMode} ·{' '}
                  {draft.httpApiView.isDelegated ? 'oauth2 (auto-consent)' : draft.httpApiView.authScheme}
                </p>
              ) : null}
              {draft.httpApiView.endpoints.length > 0 ? (
                <ul className="mt-1 font-mono">
                  {draft.httpApiView.endpoints.map((e) => (
                    <li key={`${e.method} ${e.path}`}>
                      {e.method} {e.path}
                    </li>
                  ))}
                </ul>
              ) : null}
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

          <p className="text-xs text-ink-soft">
            forrás: {draft.sourceType} · hash: <code>{draft.sourceHash}</code>
          </p>

          {provenance?.templateKey ? (
            <div className="rounded-md border border-ink/12 bg-paper p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">Sablon provenance</span>
                <Badge tone={provenance.templateOrigin === 'builtin' ? 'success' : 'warning'}>
                  {provenance.templateOrigin ?? 'template'}
                </Badge>
                <Badge tone="neutral">v{provenance.templateVersion ?? '?'}</Badge>
                {templateOutdated ? (
                  <Badge tone="warning">újabb: v{latestTemplateVersion}</Badge>
                ) : null}
              </div>
              <p className="mt-2 font-mono text-[11px] text-ink-soft">
                {provenance.templateKey}
                {provenance.templateId ? ` · ${provenance.templateId}` : ''}
              </p>
              {provenance.materializedAt ? (
                <p className="mt-1 text-ink-soft">Materializálva: {provenance.materializedAt}</p>
              ) : null}
            </div>
          ) : null}

          {/* Javítás: aktív connector visszanyitása draftba szerkesztéshez (auditált). */}
          {isActive ? (
            <div className="rounded-md border border-ink/12 bg-wash/40 p-3">
              <h4 className="mb-1 font-semibold">Szerkesztés / javítás</h4>
              <p className="mb-2 text-xs text-ink-soft">
                Aktív connector configját nem lehet élesben átírni. A javításhoz nyisd vissza
                draftba: a connector offline lesz (a Tool Broker nem oldja fel), majd a módosítás
                után újra végig kell menni a valid→review→sandbox→aktiválás kapun. Az
                agent-hozzárendelések megmaradnak, és újraaktiváláskor visszaállnak.
              </p>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(
                    () => reopenConnector({ draftId: draft.draftId }),
                    'Connector visszanyitva draftba — szerkeszd, majd aktiváld újra.',
                  )
                }
                className="rounded-md border border-honey/50 bg-honey/10 px-3 py-1.5 text-xs font-semibold text-honey disabled:opacity-50"
              >
                Szerkesztés (visszanyitás draftba)
              </button>
            </div>
          ) : null}

          {/* Javítás: draft/validated config inline szerkesztése (a gate resetelődik). */}
          {configEditor}

          {/* Takarítás: sosem aktivált draft hard-delete-je (auditált). */}
          {!isActive &&
          (draft.lifecycleState === 'draft' || draft.lifecycleState === 'validated') ? (
            <div className="rounded-md border border-coral/30 bg-coral/5 p-3">
              <h4 className="mb-1 font-semibold text-coral">Draft törlése</h4>
              <p className="mb-2 text-xs text-ink-soft">
                Végleges hard-delete — csak sosem aktivált draftra. Az elrontott draft connector és
                a draft-sor véglegesen törlődik (a törlés ténye auditba kerül).
              </p>
              {!confirmDelete ? (
                <button
                  type="button"
                  className="rounded-md border border-coral/40 bg-coral/10 px-3 py-1.5 text-xs font-semibold text-coral"
                  onClick={() => setConfirmDelete(true)}
                >
                  Draft törlése
                </button>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-coral">Biztos? Ez nem visszavonható.</span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      run(
                        () => deleteConnectorDraft({ draftId: draft.draftId }),
                        'Draft törölve.',
                      )
                    }
                    className="rounded-md bg-coral px-3 py-1.5 text-xs font-semibold text-card disabled:opacity-50"
                  >
                    Igen, töröld
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="rounded-md border border-ink/20 px-3 py-1.5 text-xs font-semibold"
                  >
                    Mégse
                  </button>
                </div>
              )}
            </div>
          ) : null}
            </>
          ) : null}

          {!isActive && selectedStep === 'validate' ? (
            <>
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
              {v.warnings.length > 0 && cfg ? (
                <div className="mt-3 rounded border border-honey/40 bg-honey/5 p-2">
                  <p className="text-xs text-ink-soft">
                    A warningok egy része a draft configban javítható. A módosítás után a kapuk
                    újraindulnak, így az új configot újra kell validálni.
                  </p>
                  {!editingConfig ? (
                    <button
                      type="button"
                      className="mt-2 rounded-md border border-honey/50 bg-paper px-3 py-1.5 text-xs font-semibold text-honey"
                      onClick={startConfigEdit}
                    >
                      Config szerkesztése
                    </button>
                  ) : null}
                </div>
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
          ) : (
            <div>
              <h4 className="mb-1 font-semibold">Determinisztikus validáció</h4>
              <p className="text-xs text-ink-soft">
                A draft még nincs validálva. Futtasd le a validátort, mielőtt review vagy aktiválás
                következne.
              </p>
            </div>
          )}
          {configEditor}
            </>
          ) : null}

          {!isActive && selectedStep === 'validate' ? (
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
            </div>
          ) : null}

          {!isActive && selectedStep === 'review' ? (
            <div className="space-y-3 border-t border-ink/10 pt-3">
              <div>
                <h4 className="font-semibold">Review döntés</h4>
                <p className="mt-1 text-xs text-ink-soft">
                  Ez csak draft állapotban értelmezett kapu. Aktív connectornál visszavonás vagy
                  új verzió kell, nem utólagos review-átírás.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
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
              </div>
            </div>
          ) : null}

          {!isActive && selectedStep === 'sandbox' ? (
            <div className="space-y-3 border-t border-ink/10 pt-3">
              <div>
                <h4 className="font-semibold">Sandbox kapcsolat-teszt</h4>
                <p className="mt-1 text-xs text-ink-soft">
                  Szűk jogú, nem éles próbahívás. Sikeres teszt nélkül az aktiválás blokkolva marad.
                </p>
              </div>
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
          ) : null}

          {isActive && selectedStep === 'inspect' && draft.connectorType === 'http_api' && isUserDelegated ? (
            <div className="flex flex-wrap gap-2 border-t border-ink/10 pt-3">
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    const res = await startConnectorOAuth({ connectorId: draft.connectorId })
                    if (!res.success) return { success: false, error: res.error }
                    if (!('stub' in res.data && res.data.stub)) {
                      window.location.href = res.data.url
                    }
                    return { success: true }
                  }, 'Consent-flow elindítva.')
                }
                className="rounded-md border border-sage/40 bg-sage/10 px-3 py-1.5 text-xs font-semibold text-sage disabled:opacity-50"
              >
                Auto-consent kezdeményezése
              </button>
            </div>
          ) : null}

          {/* Aktiválás — emberi admin-aktus */}
          {!isActive && selectedStep === 'activate' ? (
            <div className="rounded-md border border-ink/12 bg-wash/40 p-3">
              <h4 className="mb-2 font-semibold">Aktiválás (emberi admin-aktus)</h4>
              {activationHelp ? (
                <div className="mb-3 rounded-md border border-sage/30 bg-sage/8 p-3 text-xs">
                  <p className="mb-1 font-semibold text-sage">Beállítási segítség ehhez az API-hoz</p>
                  <p className="whitespace-pre-line text-ink-soft">{activationHelp}</p>
                </div>
              ) : null}
              {!activationReady ? (
                <p className="mb-3 text-xs text-honey">
                  Az aktiválás feltétele: approved review, nem-failed validáció és sikeres
                  sandbox-teszt.
                </p>
              ) : null}
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs sm:col-span-2">
                  <span className="mb-1 block text-ink-soft">
                    {isUserDelegated ? 'OAuth client secret' : 'API kulcs'}
                  </span>
                  <input
                    type="password"
                    className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      isUserDelegated
                        ? 'A szolgáltatónál regisztrált OAuth-app client secret-je'
                        : 'A külső rendszerben generált nyers kulcs'
                    }
                  />
                  <span className="mt-1 block text-ink/50">
                    {isUserDelegated
                      ? 'A client secret a menedzselt titok-tárba kerül (secret-ref). '
                      : 'Csak a nyers kulcsot írd be — a „Bearer " előtagot a rendszer adja hozzá (bearer sémánál). '}
                    A kulcs titkosítva tárolódik, sosem kerül az adatbázisba.
                  </span>
                </label>
                <details className="text-xs sm:col-span-2">
                  <summary className="cursor-pointer text-ink-soft">
                    Meglévő titok hivatkozása (haladó)
                  </summary>
                  <div className="mt-2 rounded-md border border-ink/12 bg-wash/40 p-2">
                    <p className="mb-2 text-ink/60">
                      Ha a titkot már máshol tárolod, itt hivatkozhatsz rá kulcs beírása helyett.
                      Elfogadott formák: <code>env:NÉV</code>,{' '}
                      <code>secret-manager:projects/…/secrets/&lt;id&gt;</code>,{' '}
                      <code>secret-ref:&lt;id&gt;</code>. Egyébként hagyd üresen és írd be fent a kulcsot.
                    </p>
                    <input
                      className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5 disabled:opacity-40"
                      value={secretAlias}
                      onChange={(e) => setSecretAlias(e.target.value)}
                      placeholder="env:ACME_CRM_API_KEY"
                      disabled={!!apiKey.trim()}
                    />
                    {!apiKey.trim() && secretAlias.trim() && !isResolvableSecretAlias(secretAlias.trim()) ? (
                      <p className="mt-1 text-coral">
                        Nem elfogadott alias-forma. Használj <code>env:</code>,{' '}
                        <code>secret-manager:</code> vagy <code>secret-ref:</code> előtagot — vagy hagyd
                        üresen és írd be fent a kulcsot.
                      </p>
                    ) : null}
                  </div>
                </details>
                {isUserDelegated ? (
                  <div className="text-xs sm:col-span-2">
                    <span className="mb-1 block text-ink-soft">
                      Authorized redirect URI{' '}
                      <span className="text-ink/50">(add hozzá az OAuth-app beállításaihoz)</span>
                    </span>
                    <div className="flex items-center gap-1.5">
                      <code className="flex-1 rounded-md border border-ink/15 bg-wash px-2 py-1.5 font-mono text-xs select-all">
                        {(typeof window !== 'undefined'
                          ? window.location.origin
                          : process.env.NEXT_PUBLIC_APP_URL ?? '')}
                        /api/connectors/oauth/callback
                      </code>
                      <button
                        type="button"
                        className="shrink-0 rounded-md border border-ink/15 px-2 py-1.5 text-xs hover:bg-ink/5"
                        onClick={() =>
                          void navigator.clipboard.writeText(
                            `${typeof window !== 'undefined' ? window.location.origin : process.env.NEXT_PUBLIC_APP_URL ?? ''}/api/connectors/oauth/callback`,
                          )
                        }
                      >
                        Másolás
                      </button>
                    </div>
                  </div>
                ) : null}
                {isOauth2 ? (
                  <label className="text-xs sm:col-span-2">
                    <span className="mb-1 block text-ink-soft">
                      OAuth client ID (nem titok → config)
                      {isGmailConnector ? ' — Google Cloud OAuth client' : ''}
                    </span>
                    <input
                      className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      placeholder="a szolgáltatónál regisztrált OAuth-app client_id-ja"
                    />
                  </label>
                ) : null}
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
              {!hasActivationCredentials ? (
                <p className="mt-2 text-xs text-honey">
                  Kulcs nélkül is aktiválhatsz, de megerősítést kérünk — az agent addig nem fog
                  sikeresen hívni.
                </p>
              ) : null}
              {authTestDetail ? (
                <p className="mt-2 text-xs text-ink-soft">Kulcsos teszt: {authTestDetail}</p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {hasActivationCredentials && !isGmailConnector ? (
                  <button
                    type="button"
                    disabled={pending || !activationReady || hasInvalidSecretAlias}
                    onClick={() =>
                      run(async () => {
                        const res = await testConnectorDraftWithCredentials(buildActivationInput())
                        if (!res.success) return res
                        const detail = res.data.detail ?? (res.data.ok ? 'ok' : 'fail')
                        setAuthTestDetail(
                          res.data.ok
                            ? `sikeres (${res.data.statusCode ?? 200})`
                            : `sikertelen — ${detail}`,
                        )
                        return {
                          success: res.data.ok,
                          error: res.data.ok ? undefined : detail,
                        }
                      }, 'Kulcsos teszt sikeres.')
                    }
                    className="rounded-md border border-ink/20 px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                  >
                    Kulccsal teszt
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={pending || !activationReady || hasInvalidSecretAlias}
                  onClick={handleActivate}
                  className="rounded-md bg-ink px-3 py-1.5 text-xs font-semibold text-card disabled:opacity-50"
                >
                  Aktiválás
                </button>
                {isUserDelegated ? (
                  <button
                    type="button"
                    disabled={pending || !activationReady || hasInvalidSecretAlias}
                    onClick={() => {
                      if (!hasActivationCredentials) {
                        const confirmed = window.confirm(
                          'Nem adtál meg API-kulcsot vagy érvényes titok-hivatkozást. Biztosan kulcs nélkül aktiválod?',
                        )
                        if (!confirmed) return
                      }
                      run(async () => {
                        const activated = await activateConnector(
                          buildActivationInput(!hasActivationCredentials),
                        )
                        if (!activated.success) return { success: false, error: activated.error }

                        const consent = await startConnectorOAuth({ connectorId: draft.connectorId })
                        if (!consent.success) return { success: false, error: consent.error }
                        if (!('stub' in consent.data && consent.data.stub)) {
                          window.location.href = consent.data.url
                        }
                        return { success: true }
                      }, 'Connector aktiválva, consent-flow elindítva.')
                    }}
                    className="rounded-md border border-sage/40 bg-sage/10 px-3 py-1.5 text-xs font-semibold text-sage disabled:opacity-50"
                  >
                    Aktiválás és auto-consent indítása
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {isActive && selectedStep === 'assign' ? (
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
          ) : null}

          {isActive && selectedStep === 'revoke' ? (
            <div className="rounded-md border border-coral/30 bg-coral/5 p-3">
              <h4 className="mb-2 font-semibold text-coral">Megszüntetés (auditált leszerelés)</h4>
              <p className="text-xs text-ink-soft">
                Nem hard-delete: az agent-hozzárendelések levétele, az érintett agentek http_api
                capability-jeinek újraszámítása, az aktív user-grantek visszavonása és a
                menedzselt secret-ref törlése után a connector <code>archived</code> állapotba kerül
                — a connector-sor és az audit-előzmény megmarad. A művelet visszafordíthatatlan
                (újra kellene aktiválni). Bank-preset / L2–L3 esetén második jóváhagyó kell.
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <label className="text-xs sm:col-span-2">
                  <span className="mb-1 block text-ink-soft">Indok (auditba kerül)</span>
                  <input
                    className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5"
                    value={decommReason}
                    onChange={(e) => setDecommReason(e.target.value)}
                    placeholder="Pl. félrekonfigurált egress-host, lecserélt szolgáltató"
                  />
                </label>
                <label className="text-xs">
                  <span className="mb-1 block text-ink-soft">Kritikusság</span>
                  <select
                    className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5"
                    value={decommCriticality}
                    onChange={(e) => setDecommCriticality(e.target.value as typeof decommCriticality)}
                  >
                    <option value="L1">L1</option>
                    <option value="L2">L2 (dual-control)</option>
                    <option value="L3">L3 (dual-control)</option>
                  </select>
                </label>
                <label className="text-xs">
                  <span className="mb-1 block text-ink-soft">2. jóváhagyó (≠ te)</span>
                  <input
                    className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5"
                    value={decommApprover}
                    onChange={(e) => setDecommApprover(e.target.value)}
                    placeholder="user-id (dual-control esetén)"
                  />
                </label>
              </div>
              {!confirmDecomm ? (
                <button
                  type="button"
                  className="mt-3 rounded-md border border-coral/40 bg-coral/10 px-3 py-1.5 text-xs font-semibold text-coral"
                  onClick={() => setConfirmDecomm(true)}
                >
                  Megszüntetés
                </button>
              ) : (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-coral">
                    Biztos? A connector leszerelődik és archiválódik.
                  </span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      run(async () => {
                        const res = await decommissionConnector({
                          draftId: draft.draftId,
                          criticality: decommCriticality,
                          approverId: decommApprover.trim() || undefined,
                          reason: decommReason.trim() || undefined,
                        })
                        if (!res.success) return res
                        setConfirmDecomm(false)
                        return res
                      }, 'Connector megszüntetve (archived).')
                    }
                    className="rounded-md bg-coral px-3 py-1.5 text-xs font-semibold text-card disabled:opacity-50"
                  >
                    Igen, szüntesd meg
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDecomm(false)}
                    className="rounded-md border border-ink/20 px-3 py-1.5 text-xs font-semibold"
                  >
                    Mégse
                  </button>
                </div>
              )}
            </div>
          ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
