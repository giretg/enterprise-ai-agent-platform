'use client'

import { activateConnector, approveSelfUpdatingVersion, syncSelfUpdatingConnector } from '@/lib/connector-update-publishing'

import { type ChangeEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { asTranslate, type TranslateFn } from '@/i18n/translate'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import { Badge, Card } from '@/components/ui/shell'
import { privacyCapabilityLevel, privacyCapabilityUi } from '@/domain/privacy/connector-privacy'
import {
  assignConnectorToAgent,
  createConnectorFromTemplateAction,
  createConnectorDraft,
  deprecateConnectorTemplateAction,
  decommissionActiveConnector,
  decommissionConnector,
  deleteConnectorDraft,
  draftConfigFromOpenApi,
  fetchApiDocFromUrl,
  extendEgressAllowlist,
  listConnectorTemplatesAction,
  listConnectorCatalog,
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
import { startConnectorOAuth, getGoogleOAuthConfiguredStatus, getGoogleDriveOAuthConfiguredStatus, getGoogleApiOAuthConfiguredStatus } from '@/app/actions/connector-grants'
import { isPlatformGoogleApiConnectorTemplateKey } from '@/lib/platform-google-api-connectors'
import { GoogleConnectorLevelsPanel, type GoogleAccountViewRow } from './google-connector-levels-panel'
import { listMcpConnectors } from '@/app/actions/mcp-connectors'
import {
  McpConnectorCard,
  McpConnectorsPanel,
  mcpHasApprovedTools,
  type McpConnectorsData,
} from './mcp-connectors-panel'
import { listTenants } from '@/app/actions/tenant'
import { navigateToOAuth } from '@/lib/oauth-navigation'
import {
  approveSelfUpdatingSource,
  createSelfUpdatingConnector,
  createSelfUpdatingConnectorsFromCatalog,
  listSelfUpdatingConnectors,
  previewSelfUpdatingCatalog,
  setTenantSelfUpdatingAutoApprove,
  trustSelfUpdatingPartner,
} from '@/app/actions/self-updating-connectors'
import { isResolvableSecretAlias } from '@/domain/provisioning/secret-alias'
import { ConnectorTemplateIcon } from '@/components/account/provider-icon'
import { OSTOROSBOR_CRM_DEFAULT_INSTANCE_VALUES } from '@/domain/connector-template/custom-template-seeds'
import { AGENTMAIL_TEMPLATE_KEY } from '@/domain/connector-template/builtin-templates'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  AdvancedDisclosure,
  AppIcon,
  BackButton,
  DetailHeader,
  DetailSection,
  FilterChip,
  HubRow,
  HubSection,
  IconStack,
  InfoRows,
  PillButton,
  type RowTone,
  SearchField,
  Toggle,
  ToolList,
  type ToolItem,
} from './connector-hub-ui'
import {
  SelfUpdatingConnectorCard,
  TenantAutoApproveSwitch,
  selfUpdatingSyncFeedback,
  type SelfUpdatingConnectorRow,
} from '@/app/control-plane/connectors/self-updating/self-updating-connectors-panel'

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
  idempotent?: boolean
}
type DraftConfig = {
  provider: string
  baseUrl: string
  egressHosts: string[]
  authMode: string
  auth: { type: string; headerName?: string; secretAliasSuggested?: string }
  scopesSuggested: string[]
  rateLimit?: { rps: number; burst: number }
  defaultActingUserEmail?: string
  proposedTools: ProposedTool[]
  privacy?: {
    structured_field_privacy: boolean
    stable_entity_ids: boolean
    entity_resolution: boolean
    free_text_hints: boolean
  }
  fields?: Record<string, { privacy?: string; entity_type?: string; type?: string }>
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
type DelegatedOauthConfigView = {
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
  delegatedOauthView: DelegatedOauthConfigView
  /** Google Ads / Analytics / Search Console: cég-szintű fiókkötés (secret-mentes). */
  googleAccountView?: GoogleAccountViewRow | null
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

function useProvT(): TranslateFn {
  return asTranslate(useTranslations('Provisioning'))
}

function SensitivityReviewBanner(props: {
  findings: SensitivityFinding[]
  pending: boolean
  busy: boolean
  onAccept: () => void
}) {
  const t = useProvT()
  return (
    <div className="mt-2 rounded-md border border-honey/40 bg-honey/10 p-3 text-xs text-ink">
      <p className="font-semibold text-honey">{t('sensitivityTitle')}</p>
      <p className="mt-1 text-ink-soft">{t('sensitivityBody')}</p>
      <div className="mt-2 space-y-1">
        {props.findings.map((finding, index) => (
          <div
            key={`${finding.category}-${finding.line}-${finding.column}-${index}`}
            className="rounded border border-honey/30 bg-paper px-2 py-1"
          >
            <span className="font-semibold">{finding.category}</span>
            <span className="text-ink-soft">
              {' '}
              {t('sensitivityLine', { line: finding.line, column: finding.column })}
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
          {t('continueDummy')}
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

type CreateStep = 'basics' | 'source' | 'review' | 'su_link' | 'su_trust' | 'su_sync' | 'su_version'
const SELF_UPDATING_ACTIVATION_STEPS: CreateStep[] = ['su_link', 'su_trust', 'su_sync', 'su_version']
type ConnectionKind = 'fixed' | 'self_updating'
type SourceMethod = 'document' | 'manual' | 'template'
type HubView =
  | { kind: 'hub' }
  | { kind: 'template'; templateId: string }
  | { kind: 'draft'; draftId: string }
  | { kind: 'self_updating'; id: string }
  | { kind: 'mcp'; id: string }
  | { kind: 'gap'; id: string }
  | { kind: 'catalog' }
type HubFilter = 'all' | 'connected' | 'pending' | 'available'

type TemplateDescriptor = {
  key: string
  displayName: string
  description?: string
  activationHelp?: string
  iconDataUrl?: string
  connectorType: 'gmail' | 'google_drive' | 'http_api'
  authMethods: Array<{ kind: 'api_key' | 'bearer' | 'basic' | 'service_oauth2' | 'user_delegated_oauth2' }>
  instanceFields: Array<{
    name: string
    label: string
    type: 'string' | 'secret' | 'scopeSelection' | 'endpointSelection' | 'enum'
    required?: boolean
    secretAliasHint?: string
    hiddenInProvisioning?: boolean
    enumValues?: string[]
    example?: string
  }>
  credentialFields?: Array<{ name: string; label: string; secret?: boolean }>
  scopeCatalog: Array<{ value: string; label: string; description?: string; default?: boolean }>
  endpoints: Array<{ name: string; method: string; path: string; access: 'read' | 'write'; description?: string; default?: boolean }>
}
function provisioningVisibleInstanceFields(
  fields: TemplateDescriptor['instanceFields'],
): TemplateDescriptor['instanceFields'] {
  return fields.filter((field) => !field.hiddenInProvisioning)
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

function WizardChoice({
  selected,
  title,
  hint,
  onClick,
}: {
  selected: boolean
  title: string
  hint: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`rounded-lg border px-4 py-3 text-left transition ${
        selected ? 'border-coral/45 bg-coral/8 ring-1 ring-coral/25' : 'border-ink/12 bg-paper hover:border-coral/30'
      }`}
    >
      <span className="block text-sm font-semibold">{title}</span>
      <span className="mt-1 block text-xs text-ink-soft">{hint}</span>
    </button>
  )
}

function authMethodLabel(kind: string, t: TranslateFn): string {
  switch (kind) {
    case 'api_key':
      return t('authApiKey')
    case 'bearer':
      return t('authBearer')
    case 'basic':
      return t('authBasic')
    case 'service_oauth2':
      return t('authServiceOauth')
    case 'user_delegated_oauth2':
      return t('authUserOauth')
    default:
      return kind
  }
}

function TemplateCatalogList({
  templates,
  pending,
  canManage,
  onLoad,
  onDeprecate,
}: {
  templates: ConnectorTemplateRow[]
  pending: boolean
  canManage: boolean
  onLoad?: (template: ConnectorTemplateRow) => void
  onDeprecate?: (templateId: string) => void
}) {
  const t = useProvT()
  return (
    <div className="space-y-2">
      <h3 className="text-base font-semibold">{t('availableTemplates')}</h3>
      {templates.length === 0 ? (
        <p className="text-sm text-ink-soft">{t('noTemplates')}</p>
      ) : (
        templates.map((template) => (
          <div key={template.id} className="rounded-md border border-ink/12 bg-paper p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-ink/10 bg-white">
                <ConnectorTemplateIcon
                  iconDataUrl={template.descriptor.iconDataUrl}
                  provider={template.key}
                  className="h-5 w-5"
                />
              </span>
              <span className="font-semibold">{template.displayName}</span>
              <Badge tone="neutral">v{template.version}</Badge>
              <Badge tone={template.origin === 'builtin' ? 'success' : 'warning'}>
                {template.origin}
              </Badge>
              <Badge tone={template.tenantId ? 'warning' : 'success'}>
                {template.tenantId ? 'tenant' : 'platform'}
              </Badge>
              <Badge tone={template.status === 'active' ? 'success' : 'warning'}>
                {template.status}
              </Badge>
            </div>
            <p className="mt-1 font-mono text-[11px] text-ink-soft">{template.key}</p>
            {template.description ? (
              <p className="mt-1 text-ink-soft">{template.description}</p>
            ) : null}
            {canManage ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-md border border-ink/20 px-2 py-1 font-semibold"
                  onClick={() => onLoad?.(template)}
                >
                  {t('load')}
                </button>
                {template.origin === 'custom' && template.status === 'active' ? (
                  <button
                    type="button"
                    disabled={pending}
                    className="rounded-md border border-honey/40 bg-honey/10 px-2 py-1 font-semibold text-honey disabled:opacity-50"
                    onClick={() => onDeprecate?.(template.id)}
                  >
                    Deprecate
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ))
      )}
    </div>
  )
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
    description: 'Platform-katalógus HTTP API sablon API-kulcsos hitelesítéssel.',
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

const API_DOC_FILE_EXTENSIONS = ['.json', '.yaml', '.yml'] as const
const API_DOC_FILE_ACCEPT = API_DOC_FILE_EXTENSIONS.join(',')
const MAX_API_DOC_FILE_BYTES = 2 * 1024 * 1024

function inferDocSourceType(sourceRef: string, contentType?: string): 'openapi' | 'api_doc' {
  const normalized = sourceRef.toLowerCase()
  if (/(openapi|swagger)/.test(normalized) || contentType?.includes('json')) {
    return 'openapi'
  }
  return 'api_doc'
}

function sourceMethodLabel(method: SourceMethod, t: TranslateFn): string {
  switch (method) {
    case 'template':
      return t('sourceTemplate')
    case 'document':
      return t('sourceOpenApi')
    case 'manual':
      return t('sourceManual')
  }
}

function draftSourceProvenanceLabel(
  sourceType: 'api_doc' | 'openapi' | 'manual' | 'template',
  sourceMethod: SourceMethod,
  t: TranslateFn,
): string | null {
  if (sourceMethod === 'document' && sourceType === 'openapi') {
    return t('openapiAuto')
  }
  return null
}

function subscribeNever() {
  return () => {}
}

function readInIframe() {
  return window.parent !== window
}

export function ProvisioningPanel({
  canManageCatalog,
  canManageMcp,
  isSuperadmin,
  activeTenantId,
  mcpInitial,
  mcpInitialError,
}: {
  canManageCatalog: boolean
  canManageMcp: boolean
  isSuperadmin: boolean
  activeTenantId: string | null
  mcpInitial: McpConnectorsData | null
  mcpInitialError?: string
}) {
  const t = useProvT()
  const [drafts, setDrafts] = useState<DraftRow[]>([])
  const [catalogRows, setCatalogRows] = useState<
    Array<{ id: string; name: string; type: string; connectorMode?: 'fixed' | 'self_updating' }>
  >([])
  const [selfUpdatingRows, setSelfUpdatingRows] = useState<SelfUpdatingConnectorRow[]>([])
  const [tenantAuto, setTenantAuto] = useState(false)
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [templates, setTemplates] = useState<ConnectorTemplateRow[]>([])
  const [googleOauthConfigured, setGoogleOauthConfigured] = useState(false)
  const [googleDriveOauthConfigured, setGoogleDriveOauthConfigured] = useState(false)
  const [googleApiOauthConfigured, setGoogleApiOauthConfigured] = useState(false)
  const [googleAdsDeveloperTokenConfigured, setGoogleAdsDeveloperTokenConfigured] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [pending, startTransition] = useTransition()
  // Panel-dobozban (iframe modal) a doboz fejléce már mutatja a címet — a belső
  // H1 ugyanazt ismételné, ezért ott elrejtjük; teljes oldalon megmarad.
  const inPanelModal = useSyncExternalStore(subscribeNever, readInIframe, () => false)

  // Create-form állapot
  const [name, setName] = useState('')
  const [connectionKind, setConnectionKind] = useState<ConnectionKind>('fixed')
  // A varázsló első lépése: semmi sincs előre kiválasztva.
  const [startPath, setStartPath] = useState<'own' | 'mcp' | null>(null)
  const [ownKind, setOwnKind] = useState<'openapi' | 'custom' | null>(null)
  const [selfUpdatingApiKey, setSelfUpdatingApiKey] = useState('')
  const [selfUpdatingSpecUrl, setSelfUpdatingSpecUrl] = useState('')
  // Katalógus-varázsló (gyűjtőindex → leafenkénti kapcsolatok) állapota
  type CatalogLeafRow = { name: string; specUrl: string; summary: string | null }
  type CatalogBatchRow = { name: string; specUrl: string; ok: boolean; error?: string }
  const [catalogChecking, setCatalogChecking] = useState(false)
  const [catalogChecked, setCatalogChecked] = useState(false)
  const [catalogIsCatalog, setCatalogIsCatalog] = useState(false)
  const [catalogLeaves, setCatalogLeaves] = useState<CatalogLeafRow[]>([])
  const [catalogSelected, setCatalogSelected] = useState<Record<string, boolean>>({})
  const [catalogNames, setCatalogNames] = useState<Record<string, string>>({})
  const [catalogKeyMode, setCatalogKeyMode] = useState<'none' | 'shared' | 'per_leaf'>('shared')
  const [catalogSharedKey, setCatalogSharedKey] = useState('')
  const [catalogLeafKeys, setCatalogLeafKeys] = useState<Record<string, string>>({})
  const [catalogBatch, setCatalogBatch] = useState<CatalogBatchRow[] | null>(null)
  const [suWizardConnectorId, setSuWizardConnectorId] = useState<string | null>(null)
  const [suWizardVersionId, setSuWizardVersionId] = useState<string | null>(null)
  const [suWizardRow, setSuWizardRow] = useState<SelfUpdatingConnectorRow | null>(null)
  const [suWizardMaxStepIndex, setSuWizardMaxStepIndex] = useState(1)
  const [sourceType, setSourceType] = useState<'api_doc' | 'openapi' | 'manual' | 'template'>('api_doc')
  const [configText, setConfigText] = useState('')
  const [createStep, setCreateStep] = useState<CreateStep>('basics')
  const [sourceMethod, setSourceMethod] = useState<SourceMethod>('document')

  // F2-P-F: doksi → config-jelölt generálás állapota
  const [docText, setDocText] = useState('')
  const [docSourceRef, setDocSourceRef] = useState<string | null>(null)
  const [docUrl, setDocUrl] = useState('')
  const [docTruncated, setDocTruncated] = useState(false)
  const [fetchingDoc, setFetchingDoc] = useState(false)
  const [sensitivityFindings, setSensitivityFindings] = useState<SensitivityFinding[]>([])
  const [generating, setGenerating] = useState(false)

  // Kapcsolat felfedezése névből (WebFetch-Egress §12.2)

  // Katalógus-szerkesztő láthatósága (csak superadmin, alapból csak egy gomb)
  const [templateEditorOpen, setTemplateEditorOpen] = useState(false)
  const [showCreateDraftForm, setShowCreateDraftForm] = useState(false)
  const [mcpData, setMcpData] = useState(mcpInitial)
  const router = useRouter()
  // Melyik nézet látszik: a lista, vagy egy alkalmazás részlet-oldala.
  const [view, setView] = useState<HubView>({ kind: 'hub' })
  const [hubFilter, setHubFilter] = useState<HubFilter>('all')
  const [hubQuery, setHubQuery] = useState('')
  const openView = useCallback((next: HubView) => {
    setView(next)
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 })
  }, [])

  // Connector sablon-katalógus
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [templateAuthMethod, setTemplateAuthMethod] =
    useState<TemplateDescriptor['authMethods'][number]['kind']>('api_key')
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({})
  const [templateSecretAliases, setTemplateSecretAliases] = useState<Record<string, string>>({})
  const [selectedScopes, setSelectedScopes] = useState<string[]>([])
  const [selectedEndpoints, setSelectedEndpoints] = useState<string[]>([])
  const [templateEditorText, setTemplateEditorText] = useState(EXAMPLE_TEMPLATE_DESCRIPTOR)
  // Sablon scope: platform (tenantId null) vagy tenant-szintű.
  const [templateScope, setTemplateScope] = useState<'platform' | 'tenant'>('platform')
  const [templateTenantId, setTemplateTenantId] = useState('')
  // Sablon ikon (feltöltött kép data URL-ként, a descriptorba mentve).
  const [templateIconDataUrl, setTemplateIconDataUrl] = useState<string | null>(null)
  const [templateIconTouched, setTemplateIconTouched] = useState(false)
  const [templateIconError, setTemplateIconError] = useState<string | null>(null)
  const [tenantOptions, setTenantOptions] = useState<Array<{ id: string; name: string }>>([])

  const applyTemplateSelection = useCallback((template: ConnectorTemplateRow) => {
    const descriptor = template.descriptor
    setSelectedTemplateId(template.id)
    setTemplateAuthMethod(descriptor.authMethods[0]?.kind ?? 'api_key')
    setSelectedScopes(descriptor.scopeCatalog.filter((s) => s.default).map((s) => s.value))
    setSelectedEndpoints(descriptor.endpoints.filter((e) => e.default !== false).map((e) => e.name))
    setTemplateValues(
      template.key.startsWith('ostorosbor-crm')
        ? { ...OSTOROSBOR_CRM_DEFAULT_INSTANCE_VALUES }
        : {},
    )
    setTemplateSecretAliases(
      descriptor.connectorType === 'gmail' || descriptor.connectorType === 'google_drive'
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
      const [d, a, t, g, gd, ga, su, catalog] = await Promise.all([
        listProvisioningDrafts(),
        listProvisioningAssignableAgents(),
        listConnectorTemplatesAction(),
        getGoogleOAuthConfiguredStatus(),
        getGoogleDriveOAuthConfiguredStatus(),
        getGoogleApiOAuthConfiguredStatus(),
        listSelfUpdatingConnectors(),
        listConnectorCatalog(),
      ])
      if (d.success) setDrafts(d.data as DraftRow[])
      else setError(d.error)
      if (a.success) setAgents(a.data)
      if (t.success) {
        const rows = t.data as ConnectorTemplateRow[]
        setTemplates(rows)
      }
      if (g.success) setGoogleOauthConfigured(g.data.configured)
      if (gd.success) setGoogleDriveOauthConfigured(gd.data.configured)
      if (ga.success) {
        setGoogleApiOauthConfigured(ga.data.configured)
        setGoogleAdsDeveloperTokenConfigured(ga.data.googleAdsDeveloperTokenConfigured)
      }
      if (su.success) {
        setSelfUpdatingRows(su.data.connectors as SelfUpdatingConnectorRow[])
        setTenantAuto(su.data.tenantAutoApproveEnabled)
      } else if (su.error) {
        setError(su.error)
      }
      if (catalog.success) {
        setCatalogRows(catalog.data)
      }
      if (isSuperadmin) {
        const tenants = await listTenants()
        if (tenants.success) {
          setTenantOptions(
            (tenants.data as Array<{ id: string; displayName: string }>).map((tn) => ({
              id: tn.id,
              name: tn.displayName,
            })),
          )
        }
      }
      setLoadedOnce(true)
    })
  }, [isSuperadmin])

  const reloadMcp = useCallback(async (text?: string) => {
    const res = await listMcpConnectors()
    if (res.success) {
      setMcpData(res.data as McpConnectorsData)
      if (text) setNotice(text)
    } else {
      setError(res.error ?? t('error'))
    }
  }, [t])

  useEffect(() => {
    reload()
  }, [reload])

  const run = useCallback(
    (
      fn: () => Promise<{ success: boolean; error?: string; data?: unknown }>,
      okMsg: string,
      onSuccess?: (result: { success: boolean; error?: string; data?: unknown }) => void,
    ) => {
      setError(null)
      setNotice(null)
      startTransition(async () => {
        const res = await fn()
        if (res.success) {
          setNotice(okMsg)
          onSuccess?.(res)
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
      const res = await draftConfigFromOpenApi({
        docText,
        providerHint: name.trim() || undefined,
      })
      setGenerating(false)
      if (res.success) {
        const data = res.data as DraftConfigFromDocData
        if (data.requiresSensitivityReview) {
          setSensitivityFindings(data.sensitivity.findings)
          setNotice(
            t('sensitiveFound'),
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
          t('openapiExtracted'),
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
      setError(t('needDocUrl'))
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
            ? t('docFetchedTrunc')
            : t('docFetched'),
        )
      } else {
        setError(res.error)
      }
    })
  }, [docUrl])

  const onApiDocFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > MAX_API_DOC_FILE_BYTES) {
      setError(t('fileTooBig'))
      return
    }
    const ext = `.${(file.name.split('.').pop() ?? '').toLowerCase()}`
    if (!(API_DOC_FILE_EXTENSIONS as readonly string[]).includes(ext)) {
      setError(t('onlyOpenApiFile'))
      return
    }
    setError(null)
    setNotice(null)
    void file.text().then((text) => {
      setDocText(text)
      setDocSourceRef(file.name)
      setDocTruncated(false)
      setSensitivityFindings([])
      setSourceType(inferDocSourceType(file.name, file.type))
      setNotice(t('fileLoaded'))
    })
  }, [])

  const openDrafts = drafts.filter((d) => d.lifecycleState !== 'active')
  const activatedDrafts = drafts.filter((d) => d.lifecycleState === 'active')
  // Üzemi értelemben csak a végigvitt kapcsolat aktív: link jóváhagyva + partner
  // megbízható + van átvett verzió. A csak lifecycleState-ben aktív, de még
  // jóváhagyásra váró sor külön kártyába kerül — különben az „Aktív" címke
  // azt sugallná, hogy használható agent-hozzárendelésre.
  const isSelfUpdatingReady = (row: SelfUpdatingConnectorRow) =>
    !row.loadError && row.urlApproved && row.trusted && !!row.activeSpecVersionId
  const catalogGaps = useMemo(() => {
    const listed = new Set([
      ...drafts.map((draft) => draft.connectorId),
      ...selfUpdatingRows.map((row) => row.id),
      ...(mcpData?.connectors ?? []).map((row) => row.id),
    ])
    return catalogRows.filter((row) => !listed.has(row.id))
  }, [catalogRows, drafts, mcpData, selfUpdatingRows])
  const activeSelfUpdatingRows = selfUpdatingRows.filter((row) => row.lifecycleState === 'active')
  const archivedSelfUpdatingRows = selfUpdatingRows
    .filter((row) => row.lifecycleState !== 'active')
    .sort((a, b) => a.name.localeCompare(b.name, 'hu'))
  const readySelfUpdatingRows = activeSelfUpdatingRows.filter(isSelfUpdatingReady)
  const pendingSelfUpdatingRows = activeSelfUpdatingRows
    .filter((row) => !isSelfUpdatingReady(row))
    .sort((a, b) => a.name.localeCompare(b.name, 'hu'))
  const mcpConnectors = mcpData?.connectors ?? []
  const inactiveMcpRows = mcpConnectors.filter((row) => !mcpHasApprovedTools(row))
  const activeMcpRows = mcpConnectors.filter((row) => mcpHasApprovedTools(row))
  const latestTemplateVersions = useMemo(() => {
    const versions: Record<string, number> = {}
    for (const template of templates) {
      const key = templateLineKey(template)
      if (!key) continue
      versions[key] = Math.max(versions[key] ?? 0, template.version)
    }
    return versions
  }, [templates])
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId)
  // Sablon-út: az 1. lépésben választott sablon; az alternatív úton nincs sablon.
  const isTemplatePath = view.kind === 'template'
  // Galéria: csak az aktív sablonok legfrissebb verziója.
  const galleryTemplates = templates.filter(
    (template) =>
      template.status === 'active' &&
      template.version === latestTemplateVersions[templateLineKey(template) ?? ''],
  )
  const selectedTemplateDescriptor = selectedTemplate?.descriptor
  const isGmailTemplate = selectedTemplateDescriptor?.connectorType === 'gmail'
  const isGoogleDriveTemplate = selectedTemplateDescriptor?.connectorType === 'google_drive'
  const isGoogleApiTemplate = isPlatformGoogleApiConnectorTemplateKey(selectedTemplateDescriptor?.key)
  const effectiveTemplateAuthMethod =
    selectedTemplateDescriptor?.authMethods.find((m) => m.kind === templateAuthMethod)?.kind ??
    selectedTemplateDescriptor?.authMethods[0]?.kind ??
    templateAuthMethod
  const templateRequiredFields = selectedTemplateDescriptor?.instanceFields.filter((f) => f.required !== false) ?? []
  const templateReady =
    isTemplatePath &&
    !!selectedTemplate &&
    templateRequiredFields.every((field) => {
      const source = field.type === 'secret' ? templateSecretAliases : templateValues
      return !!source[field.name]?.trim()
    })

  const closeCreateDraftForm = useCallback(() => {
    setShowCreateDraftForm(false)
    setName('')
    setCreateStep('basics')
    setConnectionKind('fixed')
    setStartPath(null)
    setOwnKind(null)
    setSelfUpdatingApiKey('')
    setSelfUpdatingSpecUrl('')
    setCatalogChecking(false)
    setCatalogChecked(false)
    setCatalogIsCatalog(false)
    setCatalogLeaves([])
    setCatalogSelected({})
    setCatalogNames({})
    setCatalogKeyMode('shared')
    setCatalogSharedKey('')
    setCatalogLeafKeys({})
    setCatalogBatch(null)
    setSuWizardConnectorId(null)
    setSuWizardVersionId(null)
    setSuWizardRow(null)
    setSuWizardMaxStepIndex(1)
  }, [])

  const refreshSuWizardRow = useCallback(async (connectorId: string) => {
    const result = await listSelfUpdatingConnectors()
    if (!result.success) return null
    const row = (result.data.connectors as SelfUpdatingConnectorRow[]).find((item) => item.id === connectorId) ?? null
    setSuWizardRow(row)
    return row
  }, [])

  const finishSuWizard = useCallback(
    (okMsg: string) => {
      setNotice(okMsg)
      closeCreateDraftForm()
      reload()
    },
    [closeCreateDraftForm, reload],
  )

  const checkCatalog = useCallback(() => {
    const url = selfUpdatingSpecUrl.trim()
    if (!url) {
      setError(t('needSpecUrl'))
      return
    }
    setError(null)
    setNotice(null)
    setCatalogBatch(null)
    setCatalogChecking(true)
    startTransition(async () => {
      const result = await previewSelfUpdatingCatalog({ catalogUrl: url })
      setCatalogChecking(false)
      if (!result.success) {
        setError(result.error ?? t('linkCheckFailed'))
        return
      }
      const data = result.data as { isCatalog: boolean; leaves: CatalogLeafRow[] }
      setCatalogChecked(true)
      setCatalogIsCatalog(data.isCatalog)
      if (!data.isCatalog) {
        setCatalogLeaves([])
        setNotice(t('singleNotCatalog'))
        return
      }
      setCatalogLeaves(data.leaves)
      setCatalogSelected(Object.fromEntries(data.leaves.map((leaf) => [leaf.specUrl, true])))
      // A leaf-kapcsolatok nevének eleje a gyűjtőkapcsolat neve (1. lépésben megadott név),
      // hogy a listában egyértelmű legyen az összetartozás (pl. „posnav – blogs").
      const prefix = name.trim()
      setCatalogNames(
        Object.fromEntries(
          data.leaves.map((leaf) => [leaf.specUrl, prefix ? `${prefix} – ${leaf.name}` : leaf.name]),
        ),
      )
      setNotice(t('catalogFound', { count: data.leaves.length }))
    })
  }, [selfUpdatingSpecUrl, name])

  const createFromCatalog = useCallback(() => {
    const selected = catalogLeaves.filter((leaf) => catalogSelected[leaf.specUrl])
    if (selected.length === 0) {
      setError(t('needAtLeastOne'))
      return
    }
    for (const leaf of selected) {
      if (!(catalogNames[leaf.specUrl] ?? '').trim()) {
        setError(t('needLeafNames'))
        return
      }
    }
    setError(null)
    setNotice(null)
    setCatalogBatch(null)
    startTransition(async () => {
      const result = await createSelfUpdatingConnectorsFromCatalog({
        items: selected.map((leaf) => ({
          name: (catalogNames[leaf.specUrl] ?? '').trim(),
          specUrl: leaf.specUrl,
          apiKey:
            catalogKeyMode === 'per_leaf' ? (catalogLeafKeys[leaf.specUrl] ?? '').trim() || undefined : undefined,
        })),
        sharedApiKey: catalogKeyMode === 'shared' ? catalogSharedKey.trim() || undefined : undefined,
      })
      if (!result.success) {
        setError(result.error ?? t('batchFailed'))
        return
      }
      const data = result.data as { items: CatalogBatchRow[] }
      setCatalogBatch(data.items)
      const okCount = data.items.filter((item) => item.ok).length
      setNotice(
        okCount === data.items.length
          ? t('batchAllOk', { count: okCount })
          : t('batchPartial', { ok: okCount, total: data.items.length }),
      )
      reload()
    })
  }, [catalogLeaves, catalogSelected, catalogNames, catalogKeyMode, catalogSharedKey, catalogLeafKeys, reload])

  const wizardSteps: Array<{ id: CreateStep; label: string }> = startPath === 'mcp'
    ? [
        { id: 'basics', label: t('stepKind') },
        { id: 'source', label: t('mcpSetupStep') },
      ]
    : connectionKind === 'self_updating'
      ? [
          { id: 'basics', label: t('stepKind') },
          { id: 'source', label: t('stepApiDoc') },
          { id: 'su_link', label: t('suLink') },
          { id: 'su_trust', label: t('suTrust') },
          { id: 'su_sync', label: t('suSync') },
          { id: 'su_version', label: t('suVersion') },
        ]
      : [
          { id: 'basics', label: t('stepKind') },
          { id: 'source', label: t('source') },
          { id: 'review', label: t('review') },
        ]
  const stepOrder = wizardSteps.map((step) => step.id)

  const onCreate = useCallback(() => {
    if (connectionKind === 'self_updating') {
      // Gyűjtőindexből nem születhet önálló kapcsolat: a leaf-választó a helyes út.
      if (catalogChecked && catalogIsCatalog) {
        setError(t('catalogNotSoloCreate'))
        return
      }
      setError(null)
      setNotice(null)
      startTransition(async () => {
        const result = await createSelfUpdatingConnector({
          name,
          apiKey: selfUpdatingApiKey,
          specUrl: selfUpdatingSpecUrl,
        })
        if (!result.success) {
          setError(result.error ?? t('createFailed'))
          return
        }
        const connectorId = (result.data as { connectorId: string }).connectorId
        setSuWizardConnectorId(connectorId)
        setSuWizardVersionId(null)
        setSuWizardMaxStepIndex(stepOrder.indexOf('su_link'))
        setCreateStep('su_link')
        setNotice(t('createdNeedLink'))
        await refreshSuWizardRow(connectorId)
      })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(configText)
    } catch {
      setError(t('invalidJson'))
      return
    }
    run(async () => {
      const result = await createConnectorDraft({
        name,
        sourceType,
        sourceRef: docSourceRef ?? undefined,
        sourceContent: docText.trim() || undefined,
        generatedConfig: parsed,
      })
      return result
    }, t('connectorCreated'), (result) => {
      closeCreateDraftForm()
      openView({ kind: 'draft', draftId: (result.data as { draftId: string }).draftId })
    })
  }, [
    catalogChecked,
    catalogIsCatalog,
    closeCreateDraftForm,
    configText,
    connectionKind,
    docSourceRef,
    docText,
    name,
    openView,
    run,
    selfUpdatingApiKey,
    selfUpdatingSpecUrl,
    sourceType,
    stepOrder,
    refreshSuWizardRow,
  ])

  // Katalógus-alkalmazás társítása: a sablonból létrejön a kapcsolat, és rögtön
  // a részlet-oldalára lépünk, ahol a bekapcsolás (kulcs / bejelentkezés) következik.
  const connectTemplate = () => {
    if (!selectedTemplate) {
      setError(t('pickTemplate'))
      return
    }
    run(
      () =>
        createConnectorFromTemplateAction({
          templateId: selectedTemplate.id,
          name: selectedTemplate.displayName,
          authMethodKind: effectiveTemplateAuthMethod,
          instanceValues: templateValues,
          secretAliases: templateSecretAliases,
          selectedScopes,
          selectedEndpoints,
        }),
      t('hubConnectedNext'),
      (result) => openView({ kind: 'draft', draftId: (result.data as { draftId: string }).draftId }),
    )
  }

  const activeStepIndex = stepOrder.indexOf(createStep)
  const suWizardProposal = suWizardRow?.versions.find((version) => version.id === suWizardVersionId) ?? null
  const canEnterSource =
    startPath === 'mcp' || (startPath === 'own' && ownKind !== null && name.trim().length > 0)
  const selfUpdatingReady =
    canEnterSource && !!selfUpdatingSpecUrl.trim()
  const canEnterReview =
    connectionKind === 'self_updating'
      ? selfUpdatingReady
      : canEnterSource && configText.trim().length > 0
  const setWizardStep = (step: CreateStep) => {
    if (step === 'source' && !canEnterSource) return
    if (step === 'review' && !canEnterReview) return
    if (SELF_UPDATING_ACTIVATION_STEPS.includes(step) && !suWizardConnectorId) return
    if (stepOrder.indexOf(step) > suWizardMaxStepIndex) return
    setCreateStep(step)
  }
  const createDisabledReason = startPath === 'mcp'
    ? null
    : pending
    ? t('pendingOp')
    : connectionKind !== 'self_updating' && !name.trim()
        ? t('needName')
        : connectionKind === 'self_updating' && !selfUpdatingSpecUrl.trim()
          ? t('needSpecUrl')
        : connectionKind === 'self_updating' && catalogChecked && catalogIsCatalog
          ? t('catalogNoSolo')
          : connectionKind === 'fixed' && !configText.trim()
            ? t('needConfig')
            : null
  const reviewProvenanceHint = draftSourceProvenanceLabel(
    sourceType,
    sourceMethod,
    t,
  )
  const templateDisabledReason = pending
    ? t('pendingOp')
    : !selectedTemplate
      ? t('pickTemplate')
      : !templateReady
        ? t('fillRequired')
        : null

  const advanceSuWizard = (step: CreateStep, noticeText: string) => {
    const nextIndex = stepOrder.indexOf(step)
    setSuWizardMaxStepIndex((current) => Math.max(current, nextIndex))
    setCreateStep(step)
    setNotice(noticeText)
  }

  const runSuActivateLink = () => {
    if (!suWizardConnectorId) return
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const result = await approveSelfUpdatingSource({ connectorId: suWizardConnectorId })
      if (!result.success) {
        setError(result.error ?? t('linkApproveFailed'))
        return
      }
      advanceSuWizard('su_trust', t('linkApproved'))
      await refreshSuWizardRow(suWizardConnectorId)
    })
  }

  const runSuActivateTrust = () => {
    if (!suWizardConnectorId) return
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const result = await trustSelfUpdatingPartner({ connectorId: suWizardConnectorId })
      if (!result.success) {
        setError(result.error ?? t('trustFailed'))
        return
      }
      advanceSuWizard('su_sync', t('trusted'))
      await refreshSuWizardRow(suWizardConnectorId)
    })
  }

  const runSuActivateSync = () => {
    if (!suWizardConnectorId) return
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const result = await syncSelfUpdatingConnector({ connectorId: suWizardConnectorId })
      if (!result.success) {
        setError(result.error ?? t('syncFailed'))
        return
      }
      const data = result.data as {
        kind: string
        autoApproved?: boolean
        versionId?: string
        reason?: string
      }
      const feedback = selfUpdatingSyncFeedback(data)
      if (data.kind === 'failed') {
        setError(feedback.message)
        return
      }
      const row = await refreshSuWizardRow(suWizardConnectorId)
      if (data.kind === 'proposed' && data.autoApproved) {
        finishSuWizard(t('openapiLive'))
        return
      }
      if (data.kind === 'proposed' && data.versionId) {
        setSuWizardVersionId(data.versionId)
        advanceSuWizard('su_version', feedback.message)
        return
      }
      if (row?.activeSpecVersionId) {
        finishSuWizard(t('openapiLive'))
        return
      }
      setNotice(feedback.message)
    })
  }

  const runSuActivateVersion = () => {
    if (!suWizardConnectorId || !suWizardVersionId) return
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const result = await approveSelfUpdatingVersion({
        connectorId: suWizardConnectorId,
        versionId: suWizardVersionId,
      })
      if (!result.success) {
        setError(result.error ?? t('applyFailed'))
        return
      }
      finishSuWizard(t('openapiLive'))
    })
  }

  // ── Főnézet adatai: minden kapcsolat egy sorként, állapot szerint csoportosítva ──
  const templateForKey = (key?: string | null) =>
    key ? (galleryTemplates.find((tpl) => tpl.key === key) ?? templates.find((tpl) => tpl.key === key)) : undefined
  const draftTemplateKey = (d: DraftRow) =>
    d.config?.provenance?.templateKey ?? d.delegatedOauthView?.provenance?.templateKey ?? null
  type HubItem = {
    key: string
    name: string
    searchText: string
    iconDataUrl?: string | null
    provider: string
    subtitle: string
    tone: RowTone
    action: string
    actionVariant?: 'primary' | 'soft' | 'success'
    target: HubView
  }
  const draftItem = (d: DraftRow, subtitle: string, tone: RowTone, action: string): HubItem => {
    const key = draftTemplateKey(d)
    return {
      key: `draft:${d.draftId}`,
      name: d.name,
      searchText: `${d.name} ${key ?? ''} ${d.connectorType}`,
      iconDataUrl: templateForKey(key)?.descriptor.iconDataUrl,
      provider: key ?? d.connectorType,
      subtitle,
      tone,
      action,
      target: { kind: 'draft', draftId: d.draftId },
    }
  }
  const connectedItems: HubItem[] = [
    ...activatedDrafts.map((d) => draftItem(d, t('hubStatusConnected'), 'success', t('hubManage'))),
    ...readySelfUpdatingRows.map((row) => ({
      key: `su:${row.id}`,
      name: row.name,
      searchText: `${row.name} openapi`,
      provider: 'openapi',
      subtitle: t('hubStatusConnectedAuto'),
      tone: 'success' as const,
      action: t('hubManage'),
      target: { kind: 'self_updating', id: row.id } as HubView,
    })),
    ...activeMcpRows.map((row) => ({
      key: `mcp:${row.id}`,
      name: row.name,
      searchText: `${row.name} mcp`,
      provider: 'mcp',
      subtitle: t('hubStatusConnected'),
      tone: 'success' as const,
      action: t('hubManage'),
      target: { kind: 'mcp', id: row.id } as HubView,
    })),
  ].sort((a, b) => a.name.localeCompare(b.name, 'hu'))
  const pendingDrafts = openDrafts.filter((d) => d.lifecycleState !== 'archived')
  const archivedDrafts = openDrafts.filter((d) => d.lifecycleState === 'archived')
  const pendingItems: HubItem[] = [
    ...pendingDrafts.map((d) =>
      draftItem(
        d,
        d.sourceType === 'template' ? t('hubStatusNeedsActivation') : t('hubStatusNeedsChecks'),
        'warning',
        t('hubContinue'),
      ),
    ),
    ...pendingSelfUpdatingRows.map((row) => ({
      key: `su:${row.id}`,
      name: row.name,
      searchText: `${row.name} openapi`,
      provider: 'openapi',
      subtitle: row.loadError ? t('hubStatusBroken') : t('hubStatusNeedsApproval'),
      tone: (row.loadError ? 'danger' : 'warning') as RowTone,
      action: t('hubContinue'),
      target: { kind: 'self_updating', id: row.id } as HubView,
    })),
    ...inactiveMcpRows.map((row) => ({
      key: `mcp:${row.id}`,
      name: row.name,
      searchText: `${row.name} mcp`,
      provider: 'mcp',
      subtitle: t('hubStatusMcpTools'),
      tone: 'warning' as const,
      action: t('hubContinue'),
      target: { kind: 'mcp', id: row.id } as HubView,
    })),
    ...catalogGaps.map((row) => ({
      key: `gap:${row.id}`,
      name: row.name,
      searchText: `${row.name} ${row.type}`,
      provider: row.type,
      subtitle: t('hubStatusUnmanaged'),
      tone: 'warning' as const,
      action: t('hubReview'),
      target: { kind: 'gap', id: row.id } as HubView,
    })),
  ].sort((a, b) => a.name.localeCompare(b.name, 'hu'))
  const offItems: HubItem[] = [
    ...archivedDrafts.map((d) => draftItem(d, t('hubStatusOff'), 'neutral', t('hubOpen'))),
    ...archivedSelfUpdatingRows.map((row) => ({
      key: `su:${row.id}`,
      name: row.name,
      searchText: `${row.name} openapi`,
      provider: 'openapi',
      subtitle: t('hubStatusOff'),
      tone: 'neutral' as const,
      action: t('hubOpen'),
      target: { kind: 'self_updating', id: row.id } as HubView,
    })),
  ].sort((a, b) => a.name.localeCompare(b.name, 'hu'))
  // Ami már be van kötve vagy folyamatban van, az nem szerepel újra az „Elérhető" listában.
  const usedTemplateKeys = new Set(
    [...activatedDrafts, ...pendingDrafts].map(draftTemplateKey).filter((key): key is string => !!key),
  )
  const availableItems: HubItem[] = galleryTemplates
    .filter((tpl) => !usedTemplateKeys.has(tpl.key))
    .map((tpl) => ({
      key: `tpl:${tpl.id}`,
      name: tpl.displayName,
      searchText: `${tpl.displayName} ${tpl.description ?? ''}`,
      iconDataUrl: tpl.descriptor.iconDataUrl,
      provider: tpl.key,
      subtitle: tpl.description ?? '',
      tone: 'neutral' as const,
      action: t('hubConnect'),
      target: { kind: 'template', templateId: tpl.id } as HubView,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'hu'))
  const hubQueryNorm = hubQuery.trim().toLowerCase()
  const matchesQuery = (item: HubItem) => !hubQueryNorm || item.searchText.toLowerCase().includes(hubQueryNorm)
  const hubSections: Array<{ id: HubFilter | 'off'; title: string; hint?: string; items: HubItem[] }> = [
    { id: 'pending' as const, title: t('hubSectionPending'), hint: t('hubSectionPendingHint'), items: pendingItems },
    { id: 'connected' as const, title: t('hubSectionConnected'), items: connectedItems },
    { id: 'available' as const, title: t('hubSectionAvailable'), hint: t('hubSectionAvailableHint'), items: availableItems },
    { id: 'off' as const, title: t('hubSectionOff'), hint: t('hubSectionOffHint'), items: offItems },
  ]
    .filter((section) => (hubFilter === 'all' ? true : section.id === hubFilter))
    .map((section) => ({ ...section, items: section.items.filter(matchesQuery) }))
    .filter((section) => section.items.length > 0)

  const openHubItem = (item: HubItem) => {
    if (item.target.kind === 'template') {
      const tpl = templates.find((row) => row.id === (item.target as { templateId: string }).templateId)
      if (!tpl) return
      // Az agent-postafiókoknak saját, egyszerűbb beállító oldala van.
      if (tpl.descriptor.key === AGENTMAIL_TEMPLATE_KEY) {
        router.push('/control-plane/provisioning/agentmail')
        return
      }
      applyTemplateSelection(tpl)
    }
    setNotice(null)
    openView(item.target)
  }
  const openOwnWizard = () => {
    closeCreateDraftForm()
    setShowCreateDraftForm(true)
    setNotice(null)
  }
  const backToHub = () => {
    setNotice(null)
    openView({ kind: 'hub' })
  }

  // Ha a megnyitott kapcsolatot közben törölték/megszüntették, visszatérünk a listához.
  const viewDraft = view.kind === 'draft' ? drafts.find((d) => d.draftId === view.draftId) : undefined
  const viewSelfUpdating = view.kind === 'self_updating' ? selfUpdatingRows.find((r) => r.id === view.id) : undefined
  const viewMcp = view.kind === 'mcp' ? mcpConnectors.find((r) => r.id === view.id) : undefined
  const viewGap = view.kind === 'gap' ? catalogGaps.find((r) => r.id === view.id) : undefined
  const viewMissing =
    loadedOnce &&
    !pending &&
    ((view.kind === 'draft' && !viewDraft) ||
      (view.kind === 'self_updating' && !viewSelfUpdating) ||
      (view.kind === 'mcp' && !viewMcp) ||
      (view.kind === 'gap' && !viewGap) ||
      (view.kind === 'template' && !selectedTemplate))
  const currentView: HubView['kind'] = viewMissing ? 'hub' : view.kind
  const connectedIconStack = connectedItems.map((item) => ({
    key: item.key,
    iconDataUrl: item.iconDataUrl,
    provider: item.provider,
  }))

  // Egy katalógus-alkalmazás oldala társítás előtt: mit tud, mihez fér hozzá, mit kell megadni.
  const renderTemplateDetail = (template: ConnectorTemplateRow, descriptor: TemplateDescriptor) => {
    const visibleFields = isGmailTemplate ? [] : provisioningVisibleInstanceFields(descriptor.instanceFields)
    const isGoogleAccountTemplate = isGmailTemplate || isGoogleDriveTemplate || isGoogleApiTemplate
    const endpointTools: ToolItem[] = descriptor.endpoints.map((endpoint) => ({
      key: endpoint.name,
      label: endpoint.description ?? endpoint.name,
      detail: `${endpoint.method} ${endpoint.path}`,
      access: endpoint.access,
      enabled: selectedEndpoints.includes(endpoint.name),
    }))
    return (
      <div className="space-y-7">
        <BackButton label={t('back')} onClick={backToHub} />
        <DetailHeader
          icon={<AppIcon iconDataUrl={descriptor.iconDataUrl} provider={template.key} size="lg" />}
          title={template.displayName}
          status={t('hubStatusNotConnected')}
          description={template.description ?? descriptor.description}
          actions={
            <PillButton
              variant="primary"
              disabled={!!templateDisabledReason}
              title={templateDisabledReason ?? undefined}
              onClick={connectTemplate}
            >
              {t('hubConnect')}
            </PillButton>
          }
        />

        {isGoogleDriveTemplate && !googleDriveOauthConfigured ? (
          <p className="rounded-2xl border border-honey/30 bg-honey/8 px-4 py-3 text-sm text-ink-soft">
            {t('driveOauthNeeded')}
          </p>
        ) : null}
        {isGoogleApiTemplate && !googleApiOauthConfigured ? (
          <p className="rounded-2xl border border-honey/30 bg-honey/8 px-4 py-3 text-sm text-ink-soft">
            {t('googleApiOauthNeeded')}
          </p>
        ) : null}

        <DetailSection title={t('hubHowItWorks')}>
          <ol className="space-y-2 text-sm text-ink-soft">
            <li>
              <span className="font-medium text-ink">1. </span>
              {t('hubHowStep1')}
            </li>
            <li>
              <span className="font-medium text-ink">2. </span>
              {isGoogleAccountTemplate ? t('hubHowStep2Google') : t('hubHowStep2Key')}
            </li>
            <li>
              <span className="font-medium text-ink">3. </span>
              {t('hubHowStep3')}
            </li>
          </ol>
          {descriptor.activationHelp ? (
            <p className="mt-3 whitespace-pre-line border-t border-ink/[0.07] pt-3 text-sm text-ink-soft">
              {descriptor.activationHelp}
            </p>
          ) : null}
        </DetailSection>

        {descriptor.authMethods.length > 1 || visibleFields.length > 0 ? (
          <DetailSection title={t('hubSetupTitle')} hint={t('hubSetupHint')}>
            <div className="space-y-4">
              {descriptor.authMethods.length > 1 ? (
                <fieldset>
                  <legend className="mb-2 text-sm font-medium text-ink">{t('authMethodLabel')}</legend>
                  <div className="flex flex-wrap gap-2">
                    {descriptor.authMethods.map((method) => (
                      <FilterChip
                        key={method.kind}
                        active={effectiveTemplateAuthMethod === method.kind}
                        onClick={() => setTemplateAuthMethod(method.kind)}
                      >
                        {authMethodLabel(method.kind, t)}
                      </FilterChip>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              {visibleFields.length > 0 ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  {visibleFields.map((field) => {
                    const value =
                      field.type === 'secret' ? templateSecretAliases[field.name] ?? '' : templateValues[field.name] ?? ''
                    return (
                      <label key={field.name} className="text-sm">
                        <span className="mb-1 block font-medium text-ink">
                          {field.label}
                          {field.required === false ? (
                            <span className="font-normal text-ink-soft">{t('optional')}</span>
                          ) : null}
                        </span>
                        {field.type === 'enum' && field.enumValues ? (
                          <select
                            className="w-full rounded-xl border border-ink/15 bg-paper px-3 py-2.5"
                            value={value}
                            onChange={(e) => setTemplateValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                          >
                            <option value="">{t('choose')}</option>
                            {field.enumValues.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            className="w-full rounded-xl border border-ink/15 bg-paper px-3 py-2.5"
                            value={value}
                            onChange={(e) => {
                              const setter = field.type === 'secret' ? setTemplateSecretAliases : setTemplateValues
                              setter((prev) => ({ ...prev, [field.name]: e.target.value }))
                            }}
                            placeholder={
                              field.type === 'secret' ? field.secretAliasHint ?? 'secret-alias' : field.example ?? field.name
                            }
                          />
                        )}
                      </label>
                    )
                  })}
                </div>
              ) : null}
            </div>
          </DetailSection>
        ) : null}

        {descriptor.scopeCatalog.length > 0 ? (
          <DetailSection title={t('accessTitle')} flush>
            <ul className="divide-y divide-ink/[0.07]">
              {descriptor.scopeCatalog.map((scope) => {
                const checked = selectedScopes.includes(scope.value)
                return (
                  <li key={scope.value} className="flex items-center gap-4 px-5 py-3.5" title={scope.value}>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] text-ink">{scope.label}</span>
                      {scope.description ? (
                        <span className="mt-0.5 block text-xs text-ink-soft">{scope.description}</span>
                      ) : null}
                    </span>
                    <Toggle
                      checked={checked}
                      label={scope.label}
                      onChange={(next) =>
                        setSelectedScopes((prev) =>
                          next ? [...new Set([...prev, scope.value])] : prev.filter((v) => v !== scope.value),
                        )
                      }
                    />
                  </li>
                )
              })}
            </ul>
          </DetailSection>
        ) : null}

        {endpointTools.length > 0 ? (
          <section className="space-y-2">
            <h3 className="px-1 text-sm font-medium text-ink-soft">{t('hubToolsTitle')}</h3>
            <ToolList
              tools={endpointTools}
              summary={t('hubToolsEnabled', { enabled: selectedEndpoints.length, total: endpointTools.length })}
              accessLabels={{ read: t('hubAccessRead'), write: t('hubAccessWrite') }}
              emptyText={t('hubToolsEmpty')}
              onToggle={(key, next) =>
                setSelectedEndpoints((prev) =>
                  next ? [...new Set([...prev, key])] : prev.filter((name) => name !== key),
                )
              }
            />
          </section>
        ) : null}

        <DetailSection title={t('hubInfoTitle')} flush>
          <InfoRows
            rows={[
              {
                label: t('hubInfoKind'),
                value: isGoogleAccountTemplate ? t('hubKindGoogle') : t('hubKindApi'),
              },
              {
                label: t('hubInfoAuth'),
                value: descriptor.authMethods.map((m) => authMethodLabel(m.kind, t)).join(', ') || '—',
              },
              {
                label: t('hubInfoPublisher'),
                value: template.tenantId ? t('hubPublisherTenant') : t('hubPublisherPlatform'),
              },
              { label: t('hubInfoVersion'), value: `v${template.version}` },
            ]}
          />
        </DetailSection>

        {templateDisabledReason && !pending ? (
          <p className="px-1 text-sm text-ink-soft">{templateDisabledReason}</p>
        ) : null}
      </div>
    )
  }

  const hubContent = (
    <div className="space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {inPanelModal ? (
          <span />
        ) : (
          <h1 className="font-display text-2xl font-semibold tracking-tight">{t('hubTitle')}</h1>
        )}
        {connectedItems.length > 0 ? (
          <button
            type="button"
            onClick={() => setHubFilter('connected')}
            className="inline-flex items-center gap-2.5 rounded-full py-1 pl-1 pr-2 text-sm text-ink-soft transition hover:bg-ink/[0.05] hover:text-ink"
          >
            <IconStack items={connectedIconStack} />
            {t('hubConnectedCount', { count: connectedItems.length })}
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
              <path d="m9 5 7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : null}
      </div>
      <p className="-mt-5 max-w-3xl text-sm text-ink-soft">{t('hubIntro')}</p>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchField value={hubQuery} onChange={setHubQuery} placeholder={t('hubSearch')} />
        <PillButton variant="soft" onClick={openOwnWizard} title={t('hubOwnConnectionHint')}>
          <span aria-hidden className="text-base leading-none">+</span>
          {t('hubOwnConnection')}
        </PillButton>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FilterChip active={hubFilter === 'all'} onClick={() => setHubFilter('all')}>
          {t('hubFilterAll')}
        </FilterChip>
        <FilterChip active={hubFilter === 'connected'} onClick={() => setHubFilter('connected')}>
          {t('hubFilterConnected', { count: connectedItems.length })}
        </FilterChip>
        {pendingItems.length > 0 ? (
          <FilterChip active={hubFilter === 'pending'} onClick={() => setHubFilter('pending')}>
            {t('hubFilterPending', { count: pendingItems.length })}
          </FilterChip>
        ) : null}
        <FilterChip active={hubFilter === 'available'} onClick={() => setHubFilter('available')}>
          {t('hubFilterAvailable')}
        </FilterChip>
        <div className="ml-auto flex flex-wrap items-center gap-1 text-sm">
          <button
            type="button"
            onClick={() => openView({ kind: 'catalog' })}
            className="rounded-full px-3 py-2 text-ink-soft transition hover:bg-ink/[0.05] hover:text-ink"
          >
            {t('hubCatalogLink')}
          </button>
          <Link
            href="/control-plane/provisioning/agentmail"
            className="rounded-full px-3 py-2 text-ink-soft transition hover:bg-ink/[0.05] hover:text-ink"
          >
            {t('hubAgentMailLink')}
          </Link>
        </div>
      </div>

      {!loadedOnce ? (
        <p className="text-sm text-ink-soft">{t('loading')}</p>
      ) : hubSections.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ink/15 px-6 py-10 text-center">
          <p className="text-[15px] font-medium text-ink">
            {hubQueryNorm ? t('hubEmptySearch') : hubFilter === 'connected' ? t('hubEmptyConnected') : t('hubEmpty')}
          </p>
          <p className="mt-1 text-sm text-ink-soft">{t('hubEmptyHint')}</p>
          <div className="mt-4 flex justify-center gap-2">
            {hubFilter !== 'all' || hubQueryNorm ? (
              <PillButton
                onClick={() => {
                  setHubFilter('all')
                  setHubQuery('')
                }}
              >
                {t('hubShowAll')}
              </PillButton>
            ) : null}
            <PillButton variant="primary" onClick={openOwnWizard}>
              {t('hubOwnConnection')}
            </PillButton>
          </div>
        </div>
      ) : (
        hubSections.map((section) => (
          <HubSection key={section.id} title={section.title} hint={section.hint}>
            {section.items.map((item) => (
              <HubRow
                key={item.key}
                icon={<AppIcon iconDataUrl={item.iconDataUrl} provider={item.provider} />}
                title={item.name}
                subtitle={item.subtitle}
                subtitleTone={item.tone}
                actionLabel={item.action}
                actionVariant={item.actionVariant}
                onOpen={() => openHubItem(item)}
              />
            ))}
          </HubSection>
        ))
      )}
    </div>
  )

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <ErrorDialog message={error} onClose={() => setError(null)} />
      {notice ? (
        <div className="rounded-2xl border border-sage/30 bg-sage/8 px-4 py-3 text-sm text-sage">
          {notice}
        </div>
      ) : null}

      {showCreateDraftForm ? (
      <div className="space-y-5">
        <BackButton label={t('back')} onClick={closeCreateDraftForm} />
        <div>
          <h2 className="font-display text-2xl font-semibold tracking-tight">{t('hubOwnTitle')}</h2>
          <p className="mt-1 text-sm text-ink-soft">{t('hubOwnBody')}</p>
        </div>
        <ol className="mb-5 flex flex-wrap items-center gap-2 text-sm">
          {wizardSteps.map((step, index) => {
            const active = createStep === step.id
            const complete =
              index < activeStepIndex ||
              (step.id === 'basics' && canEnterSource) ||
              (step.id === 'su_link' && Boolean(suWizardRow?.urlApproved)) ||
              (step.id === 'su_trust' && Boolean(suWizardRow?.trusted)) ||
              (step.id === 'su_sync' && Boolean(suWizardRow?.activeSpecVersionId || suWizardVersionId)) ||
              (step.id === 'su_version' && Boolean(suWizardRow?.activeSpecVersionId))
            const locked =
              (step.id === 'source' && !canEnterSource) ||
              (step.id === 'review' && !canEnterReview) ||
              (SELF_UPDATING_ACTIVATION_STEPS.includes(step.id) && !suWizardConnectorId) ||
              index > suWizardMaxStepIndex
            return (
              <li key={step.id} className="flex items-center gap-2">
                {index > 0 ? <span aria-hidden className="h-px w-5 bg-ink/15" /> : null}
                <button
                  type="button"
                  disabled={locked}
                  aria-current={active ? 'step' : undefined}
                  onClick={() => setWizardStep(step.id)}
                  className={`inline-flex items-center gap-2 font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    active ? 'text-ink' : complete ? 'text-sage' : 'text-ink-soft hover:text-ink'
                  }`}
                >
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                      active ? 'bg-coral text-card' : complete ? 'bg-sage text-card' : 'bg-night-2 text-ink-soft'
                    }`}
                  >
                    {complete && !active ? '✓' : index + 1}
                  </span>
                  {step.label}
                </button>
              </li>
            )
          })}
        </ol>

          <div className="min-w-0 rounded-2xl border border-ink/10 bg-paper p-4 sm:p-6">
            {createStep === 'basics' ? (
              <div className="space-y-4">
                <div>
                  <h3 className="text-base font-semibold">{t('step1Title')}</h3>
                  <p className="mt-1 text-sm text-ink-soft">{t('step1Body')}</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <WizardChoice
                    selected={startPath === 'own' && ownKind === 'openapi'}
                    title={t('openapiKind')}
                    hint={t('openapiKindHint')}
                    onClick={() => {
                      setStartPath('own')
                      setOwnKind('openapi')
                      setConnectionKind('self_updating')
                    }}
                  />
                  <WizardChoice
                    selected={startPath === 'own' && ownKind === 'custom'}
                    title={t('customConnection')}
                    hint={t('customConnectionHint')}
                    onClick={() => {
                      setStartPath('own')
                      setOwnKind('custom')
                      setConnectionKind('fixed')
                      setSourceMethod('document')
                      setSourceType('api_doc')
                    }}
                  />
                  {canManageMcp ? (
                    <WizardChoice
                      selected={startPath === 'mcp'}
                      title={t('pathMcp')}
                      hint={t('pathMcpHint')}
                      onClick={() => {
                        setStartPath('mcp')
                        setOwnKind(null)
                        setConnectionKind('fixed')
                        setCreateStep('source')
                      }}
                    />
                  ) : null}
                </div>

                {startPath === 'own' && ownKind ? (
                  <label className="block text-sm">
                    <span className="mb-1 block font-semibold">{t('connectionName')}</span>
                    <input
                      className="w-full rounded-xl border border-ink/15 bg-paper px-3 py-2.5"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Acme CRM"
                    />
                    <span className="mt-1 block text-xs text-ink-soft">{t('connectionNameHint')}</span>
                  </label>
                ) : null}
              </div>
            ) : null}

            {createStep === 'source' && connectionKind === 'self_updating' ? (
              <div className="space-y-4">
                <div>
                  <h3 className="text-base font-semibold">{t('step2ApiTitle')}</h3>
                  <p className="mt-1 text-xs text-ink-soft">
                    {t('step2ApiBody')}
                  </p>
                </div>
                <label className="block text-sm">
                  <span className="mb-1 block font-semibold">{t('accessKeyOptional')}</span>
                  <input
                    type="password"
                    value={selfUpdatingApiKey}
                    onChange={(e) => setSelfUpdatingApiKey(e.target.value)}
                    className="w-full rounded-md border border-ink/15 bg-paper px-3 py-2"
                    autoComplete="new-password"
                  />
                  <span className="mt-1 block text-xs text-ink-soft">
                    {t('accessKeyHint')}
                  </span>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block font-semibold">{t('specLink')}</span>
                  <input
                    value={selfUpdatingSpecUrl}
                    onChange={(e) => {
                      setSelfUpdatingSpecUrl(e.target.value)
                      setCatalogChecked(false)
                      setCatalogBatch(null)
                    }}
                    className="w-full rounded-md border border-ink/15 bg-paper px-3 py-2"
                    placeholder="https://partner.example/openapi.json"
                  />
                  <span className="mt-1 block text-xs text-ink-soft">
                    {t('capabilityOnSync')}
                  </span>
                </label>
                <div className="rounded-md border border-ink/12 bg-card p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={catalogChecking || !selfUpdatingSpecUrl.trim()}
                      onClick={checkCatalog}
                      className="rounded-md border border-ink/20 px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                    >
                      {catalogChecking ? t('checking') : t('checkCatalog')}
                    </button>
                    <span className="text-xs text-ink-soft">
                      {t('catalogHelp')}
                    </span>
                  </div>

                  {catalogChecked && !catalogIsCatalog ? (
                    <p className="mt-2 text-xs text-ink-soft">
                      {t('singleApi')}
                    </p>
                  ) : null}

                  {catalogChecked && catalogIsCatalog ? (
                    <div className="mt-3 space-y-3">
                      <p className="text-xs font-semibold">
                        {t('catalogLeaves', { count: catalogLeaves.length })}
                      </p>
                      <div className="max-h-64 space-y-2 overflow-y-auto">
                        {catalogLeaves.map((leaf) => (
                          <div key={leaf.specUrl} className="rounded-md border border-ink/10 p-2">
                            <label className="flex items-start gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={catalogSelected[leaf.specUrl] ?? false}
                                onChange={(e) =>
                                  setCatalogSelected((prev) => ({ ...prev, [leaf.specUrl]: e.target.checked }))
                                }
                                className="mt-1"
                              />
                              <span className="flex-1">
                                <input
                                  value={catalogNames[leaf.specUrl] ?? leaf.name}
                                  onChange={(e) =>
                                    setCatalogNames((prev) => ({ ...prev, [leaf.specUrl]: e.target.value }))
                                  }
                                  className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1 text-sm font-semibold"
                                  aria-label={`Kapcsolat neve (${leaf.specUrl})`}
                                />
                                <span className="mt-0.5 block break-all font-mono text-[11px] text-ink-soft">
                                  {leaf.specUrl}
                                </span>
                                {leaf.summary ? (
                                  <span className="mt-0.5 block text-xs text-ink-soft">{leaf.summary}</span>
                                ) : null}
                              </span>
                            </label>
                            {catalogKeyMode === 'per_leaf' && (catalogSelected[leaf.specUrl] ?? false) ? (
                              <label className="mt-2 block text-xs">
                                <span className="mb-1 block text-ink-soft">{t('leafKey')}</span>
                                <input
                                  type="password"
                                  value={catalogLeafKeys[leaf.specUrl] ?? ''}
                                  onChange={(e) =>
                                    setCatalogLeafKeys((prev) => ({ ...prev, [leaf.specUrl]: e.target.value }))
                                  }
                                  autoComplete="new-password"
                                  className="w-full rounded-md border border-ink/15 bg-paper px-2 py-1"
                                />
                              </label>
                            ) : null}
                          </div>
                        ))}
                      </div>

                      <div className="space-y-2 text-sm">
                        <span className="block text-xs font-semibold">{t('accessKeys')}</span>
                        <label className="flex items-start gap-2 text-xs">
                          <input
                            type="radio"
                            checked={catalogKeyMode === 'shared'}
                            onChange={() => setCatalogKeyMode('shared')}
                            className="mt-0.5"
                          />
                          <span>
                            <strong>{t('sharedKey')}</strong>
                            <span className="block text-ink-soft">
                              {t('sharedKeyHint')}
                            </span>
                          </span>
                        </label>
                        {catalogKeyMode === 'shared' ? (
                          <input
                            type="password"
                            value={catalogSharedKey}
                            onChange={(e) => setCatalogSharedKey(e.target.value)}
                            autoComplete="new-password"
                            placeholder={t('sharedKeyPlaceholder')}
                            className="w-full rounded-md border border-ink/15 bg-paper px-3 py-2 text-sm"
                          />
                        ) : null}
                        <label className="flex items-start gap-2 text-xs">
                          <input
                            type="radio"
                            checked={catalogKeyMode === 'per_leaf'}
                            onChange={() => setCatalogKeyMode('per_leaf')}
                            className="mt-0.5"
                          />
                          <span>
                            <strong>{t('perLeafKey')}</strong>
                            <span className="block text-ink-soft">{t('perLeafKeyHint')}</span>
                          </span>
                        </label>
                        <label className="flex items-start gap-2 text-xs">
                          <input
                            type="radio"
                            checked={catalogKeyMode === 'none'}
                            onChange={() => setCatalogKeyMode('none')}
                            className="mt-0.5"
                          />
                          <span>
                            <strong>{t('noKey')}</strong>
                            <span className="block text-ink-soft">{t('noKeyHint')}</span>
                          </span>
                        </label>
                      </div>

                      <button
                        type="button"
                        disabled={pending || catalogChecking}
                        onClick={createFromCatalog}
                        className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-card disabled:opacity-50"
                      >
                        {t('createSelected')}
                      </button>

                      {catalogBatch ? (
                        <ul className="space-y-1 text-xs">
                          {catalogBatch.map((item) => (
                            <li
                              key={item.specUrl}
                              className={`rounded-md border px-2 py-1.5 ${
                                item.ok ? 'border-sage/35 bg-sage/8' : 'border-coral/40 bg-coral/8'
                              }`}
                            >
                              {item.ok ? (
                                <span>✓ {t('itemCreated', { name: item.name })}</span>
                              ) : (
                                <span>✗ {t('itemFailed', { name: item.name, error: item.error ?? t('failedFallback') })}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <p className="rounded-md border border-honey/35 bg-honey/8 p-3 text-xs">
                  {t('dualControlHint')}
                </p>
              </div>
            ) : null}

            {startPath === 'mcp' ? (
              <div hidden={createStep !== 'source'} className="space-y-3">
                <div>
                  <h3 className="text-base font-semibold">{t('mcpSetupTitle')}</h3>
                  <p className="mt-1 text-sm text-ink-soft">{t('mcpSetupBody')}</p>
                </div>
                <McpConnectorsPanel
                  mode="setup"
                  canManage={canManageMcp}
                  initial={mcpData}
                  initialError={mcpInitialError}
                  onCreatedConnector={(connectorId, text) => {
                    void reloadMcp().then(() => {
                      closeCreateDraftForm()
                      openView({ kind: 'mcp', id: connectorId })
                      setNotice(text)
                    })
                  }}
                />
              </div>
            ) : null}

            {createStep === 'su_link' && connectionKind === 'self_updating' ? (
              <div className="space-y-4">
                <div>
                  <h3 className="text-base font-semibold">{t('step3Link')}</h3>
                  <p className="mt-1 text-xs text-ink-soft">
                    {t('step3LinkBody')}
                  </p>
                </div>
                <p className="break-all rounded-md border border-ink/12 bg-card px-3 py-2 font-mono text-xs">
                  {suWizardRow?.specUrl ?? selfUpdatingSpecUrl}
                </p>
                {suWizardRow?.urlApproved ? (
                  <p className="text-xs text-sage">{t('linkAlready')}</p>
                ) : null}
              </div>
            ) : null}

            {createStep === 'su_trust' && connectionKind === 'self_updating' ? (
              <div className="space-y-4">
                <div>
                  <h3 className="text-base font-semibold">{t('step4Trust')}</h3>
                  <p className="mt-1 text-xs text-ink-soft">
                    {t('step4TrustBody')}
                  </p>
                </div>
                {suWizardRow?.trusted ? (
                  <p className="text-xs text-sage">{t('trustAlready')}</p>
                ) : null}
              </div>
            ) : null}

            {createStep === 'su_sync' && connectionKind === 'self_updating' ? (
              <div className="space-y-4">
                <div>
                  <h3 className="text-base font-semibold">{t('step5Sync')}</h3>
                  <p className="mt-1 text-xs text-ink-soft">
                    {t('step5SyncBody')}
                  </p>
                </div>
                {suWizardRow?.activeSpecVersionId ? (
                  <p className="text-xs text-sage">{t('versionAlready')}</p>
                ) : null}
              </div>
            ) : null}

            {createStep === 'su_version' && connectionKind === 'self_updating' ? (
              <div className="space-y-4">
                <div>
                  <h3 className="text-base font-semibold">{t('step6Apply')}</h3>
                  <p className="mt-1 text-xs text-ink-soft">
                    {t('step6ApplyBody')}
                  </p>
                </div>
                {suWizardProposal ? (
                  <div className="rounded-md border border-ink/12 bg-card p-3 text-xs">
                    <p className="font-semibold">
                      {t('proposedVersion', { version: suWizardProposal.versionNo })}
                    </p>
                    <p className="mt-1 text-ink-soft">
                      {t('capabilityCount', { count: suWizardProposal.capabilities.length })}
                      {suWizardProposal.diffSummary?.added.length
                        ? t('addedCount', { count: suWizardProposal.diffSummary.added.length })
                        : ''}
                      {suWizardProposal.diffSummary?.breaking.length
                        ? t('breakingCount', { count: suWizardProposal.diffSummary.breaking.length })
                        : ''}
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-ink-soft">{t('runSyncFirst')}</p>
                )}
              </div>
            ) : null}

              {createStep === 'source' && connectionKind === 'fixed' && startPath === 'own' ? (
                <div className="space-y-4">
                  <div>
                    <h3 className="text-base font-semibold">{t('step2Custom')}</h3>
                    <p className="mt-1 text-xs text-ink-soft">
                      {t('step2CustomBody')}
                    </p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {[
                      { id: 'document' as const, label: t('openapi'), hint: t('openapiHint') },
                      { id: 'manual' as const, label: t('sourceManual'), hint: t('manualJsonHint') },
                    ].map((method) => (
                      <button
                        key={method.id}
                        type="button"
                        onClick={() => {
                          setSourceMethod(method.id)
                          if (method.id === 'manual') {
                            setSourceType('manual')
                          } else {
                            setSourceType('api_doc')
                          }
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

                {sourceMethod === 'document' ? (
                  <div className="rounded-md border border-ink/12 bg-paper p-3">
                    <span className="mb-1 block text-sm font-semibold">
                      {t('fromDoc')}
                    </span>
                    <div className="mb-3 rounded-md border border-sage/25 bg-sage/5 p-3">
                      <span className="mb-1 block text-xs font-semibold text-ink">
                        {t('fetchStep')}
                      </span>
                      <p className="mb-2 text-xs text-ink-soft">
                        {t('fetchStepBody')}
                      </p>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <input
                          type="url"
                          className="min-w-0 flex-1 rounded-md border border-ink/15 bg-paper px-3 py-2 font-mono text-xs"
                          value={docUrl}
                          onChange={(e) => setDocUrl(e.target.value)}
                          placeholder={t('docUrlPlaceholder')}
                        />
                        <button
                          type="button"
                          disabled={pending || fetchingDoc || !docUrl.trim()}
                          onClick={onFetchDocFromUrl}
                          className="shrink-0 rounded-md border border-sage/40 bg-sage/10 px-3 py-1.5 text-xs font-semibold text-sage disabled:opacity-50"
                        >
                          {fetchingDoc ? t('fetching') : t('fetch')}
                        </button>
                      </div>
                    </div>
                    <div className="mb-2 flex flex-col gap-1 text-xs text-ink-soft sm:flex-row sm:items-center sm:justify-between">
                      <span className="font-semibold text-ink">{t('reviewOrUpload')}</span>
                      <label className="inline-flex w-fit cursor-pointer items-center rounded-md border border-ink/15 bg-paper px-3 py-1.5 font-semibold text-ink hover:border-sage/50">
                        <span>{t('uploadApiDoc')}</span>
                        <input
                          type="file"
                          accept={API_DOC_FILE_ACCEPT}
                          onChange={onApiDocFileChange}
                          className="sr-only"
                        />
                      </label>
                    </div>
                    <p className="mb-2 text-xs text-ink-soft">
                      {t('onlyOpenApi')}
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
                        {t('docSource', { ref: docSourceRef })}
                        {docTruncated ? (
                          <span className="ml-2 font-semibold text-honey">
                            {t('truncated')}
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
                      {generating ? t('generating') : t('generateConfig')}
                    </button>
                  </div>
                ) : null}

                {sourceMethod === 'manual' ? (
                  <div className="rounded-md border border-ink/12 bg-paper p-3">
                    <span className="mb-1 block text-sm font-semibold">{t('manualDescriptor')}</span>
                    <p className="mb-2 text-xs text-ink-soft">
                      {t('manualDescriptorHint')}
                    </p>
                    <button
                      type="button"
                      className="rounded-md border border-sage/40 bg-sage/10 px-3 py-1.5 text-xs font-semibold text-sage"
                      onClick={() => setConfigText(EXAMPLE_CONFIG)}
                    >
                      {t('loadExample')}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {createStep === 'review' ? (
              <div className="space-y-3">
                <div>
                  <h3 className="text-base font-semibold">{t('step3Review')}</h3>
                  <p className="mt-1 text-xs text-ink-soft">
                    {t('secretNeverHere')}
                  </p>
                </div>
                <dl className="grid gap-2 rounded-md border border-ink/12 bg-paper px-3 py-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-ink-soft">Konnektor neve</dt>
                    <dd className="font-semibold">{name.trim() || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-soft">{t('source')}</dt>
                    <dd className="font-semibold">
                      {sourceMethodLabel(sourceMethod, t)}
                    </dd>
                    {reviewProvenanceHint ? (
                      <dd className="mt-0.5 text-ink-soft">{reviewProvenanceHint}</dd>
                    ) : null}
                  </div>
                </dl>
                  <label className="block text-sm">
                    <span className="mb-1 flex items-center justify-between text-ink-soft">
                      <span>{t('generatedJson')}</span>
                      <button
                        type="button"
                        className="text-xs font-semibold text-sage hover:underline"
                        onClick={() => setConfigText(EXAMPLE_CONFIG)}
                      >
                        {t('loadExample')}
                      </button>
                    </span>
                    <textarea
                      className="h-72 w-full rounded-md border border-ink/15 bg-paper px-3 py-2 font-mono text-xs"
                      value={configText}
                      onChange={(e) => setConfigText(e.target.value)}
                      placeholder={EXAMPLE_CONFIG}
                    />
                  </label>
                {createDisabledReason ? (
                  <p className="text-xs text-ink-soft">{createDisabledReason}</p>
                ) : null}
              </div>
            ) : null}

            <div className="mt-5 flex flex-col gap-2 border-t border-ink/10 pt-4 sm:flex-row sm:items-center sm:justify-between">
              {activeStepIndex > 0 ? (
                <button
                  type="button"
                  onClick={() => setCreateStep(stepOrder[Math.max(0, activeStepIndex - 1)])}
                  className="rounded-md border border-ink/20 px-3 py-2 text-sm font-semibold"
                >
                  Vissza
                </button>
              ) : (
                <span />
              )}
              {startPath === 'mcp' && createStep === 'source' ? (
                <span />
              ) : createStep === 'review' ||
              (createStep === 'source' && connectionKind === 'self_updating') ? (
                <button
                  type="button"
                  disabled={!!createDisabledReason || pending}
                  onClick={onCreate}
                  className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-card disabled:opacity-50"
                >
                  {connectionKind === 'self_updating' ? t('createAndActivate') : t('createConnector')}
                </button>
              ) : createStep === 'su_link' ? (
                suWizardRow?.urlApproved ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => advanceSuWizard('su_trust', '')}
                    className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-card disabled:opacity-50"
                  >
                    {t('next')}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={pending || !suWizardConnectorId}
                    onClick={runSuActivateLink}
                    className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-card disabled:opacity-50"
                  >
                    {t('approveLink')}
                  </button>
                )
              ) : createStep === 'su_trust' ? (
                suWizardRow?.trusted ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => advanceSuWizard('su_sync', '')}
                    className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-card disabled:opacity-50"
                  >
                    {t('next')}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={pending || !suWizardConnectorId}
                    onClick={runSuActivateTrust}
                    className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-card disabled:opacity-50"
                  >
                    {t('trustPartner')}
                  </button>
                )
              ) : createStep === 'su_sync' ? (
                suWizardRow?.activeSpecVersionId ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => finishSuWizard(t('openapiLive'))}
                    className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-card disabled:opacity-50"
                  >
                    {t('finish')}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={pending || !suWizardConnectorId}
                    onClick={runSuActivateSync}
                    className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-card disabled:opacity-50"
                  >
                    {t('searchUpdates')}
                  </button>
                )
              ) : createStep === 'su_version' ? (
                <button
                  type="button"
                  disabled={pending || !suWizardConnectorId || !suWizardVersionId}
                  onClick={runSuActivateVersion}
                  className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-card disabled:opacity-50"
                >
                  {t('approveChanges')}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={createStep === 'basics' ? !canEnterSource : !canEnterReview}
                  onClick={() => setCreateStep(stepOrder[Math.min(stepOrder.length - 1, activeStepIndex + 1)])}
                  className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-card disabled:opacity-50"
                >
                  {t('next')}
                </button>
              )}
            </div>
          </div>
      </div>
      ) : currentView === 'template' && selectedTemplate && selectedTemplateDescriptor ? (
        renderTemplateDetail(selectedTemplate, selectedTemplateDescriptor)
      ) : currentView === 'draft' && viewDraft ? (
        <DraftCard
          key={viewDraft.draftId}
          draft={viewDraft}
          onBack={backToHub}
          agents={agents}
          templates={templates}
          latestTemplateVersions={latestTemplateVersions}
          googleOauthConfigured={googleOauthConfigured}
          googleDriveOauthConfigured={googleDriveOauthConfigured}
          googleApiOauthConfigured={googleApiOauthConfigured}
          googleAdsDeveloperTokenConfigured={googleAdsDeveloperTokenConfigured}
          pending={pending}
          run={run}
          isSuperadmin={isSuperadmin}
        />
      ) : currentView === 'self_updating' && viewSelfUpdating ? (
        <div className="space-y-6">
          <BackButton label={t('back')} onClick={backToHub} />
          <DetailHeader
            icon={<AppIcon provider="openapi" size="lg" />}
            title={viewSelfUpdating.name}
            status={
              viewSelfUpdating.lifecycleState !== 'active'
                ? t('hubStatusOff')
                : isSelfUpdatingReady(viewSelfUpdating)
                  ? t('hubStatusConnectedAuto')
                  : t('hubStatusNeedsApproval')
            }
            statusTone={
              viewSelfUpdating.lifecycleState !== 'active'
                ? 'neutral'
                : isSelfUpdatingReady(viewSelfUpdating)
                  ? 'success'
                  : 'warning'
            }
            description={t('suDetailDescription')}
          />
          <SelfUpdatingConnectorCard
            row={viewSelfUpdating}
            pending={pending}
            run={run}
            onReload={reload}
            isSuperadmin={isSuperadmin}
            defaultOpen
          />
          <DetailSection title={t('suOrgSetting')}>
            <TenantAutoApproveSwitch
              tenantAuto={tenantAuto}
              pending={pending}
              onToggle={(enabled) =>
                run(
                  () => setTenantSelfUpdatingAutoApprove({ enabled }),
                  enabled ? t('autoApproveOn') : t('autoApproveOff'),
                )
              }
            />
          </DetailSection>
        </div>
      ) : currentView === 'mcp' && viewMcp ? (
        <div className="space-y-6">
          <BackButton label={t('back')} onClick={backToHub} />
          <DetailHeader
            icon={<AppIcon provider="mcp" size="lg" />}
            title={viewMcp.name}
            status={mcpHasApprovedTools(viewMcp) ? t('hubStatusConnected') : t('hubStatusMcpTools')}
            statusTone={mcpHasApprovedTools(viewMcp) ? 'success' : 'warning'}
            description={t('mcpDetailDescription')}
          />
          <McpConnectorCard row={viewMcp} reload={(text) => void reloadMcp(text)} />
        </div>
      ) : currentView === 'gap' && viewGap ? (
        <div className="space-y-6">
          <BackButton label={t('back')} onClick={backToHub} />
          <DetailHeader
            icon={<AppIcon provider={viewGap.type} size="lg" />}
            title={viewGap.name}
            status={t('hubStatusUnmanaged')}
            statusTone="warning"
            description={t('unmanagedHint')}
          />
          <CatalogGapCard row={viewGap} pending={pending} run={run} />
        </div>
      ) : currentView === 'catalog' ? (
        <div className="space-y-6">
          <BackButton label={t('back')} onClick={backToHub} />
          <div>
            <h2 className="font-display text-2xl font-semibold tracking-tight">{t('templateCard')}</h2>
            <p className="mt-1 text-sm text-ink-soft">
              {canManageCatalog
                ? isSuperadmin
                  ? t('tabTemplatesSuper')
                  : t('tabTemplatesAdmin')
                : t('tabTemplatesView')}
            </p>
          </div>
      {canManageCatalog && !templateEditorOpen ? (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setTemplateEditorOpen(true)}
            className="inline-flex items-center gap-2 rounded-md border border-ink/15 bg-card px-4 py-2 text-sm font-semibold text-ink transition hover:border-coral/40 hover:text-coral-deep"
          >
            {t('editCatalog')}
          </button>
          <Card title={t('templateCard')}>
            <TemplateCatalogList templates={templates} pending={pending} canManage={false} />
          </Card>
        </div>
      ) : null}
      {canManageCatalog && templateEditorOpen ? (
      <Card title={t('templateCard')}>
        <div className="mb-4 flex justify-end">
          <button
            type="button"
            onClick={() => setTemplateEditorOpen(false)}
            className="rounded-md border border-ink/15 px-3 py-1.5 text-xs font-semibold text-ink-soft transition hover:border-ink/30 hover:text-ink"
          >
            {t('close')}
          </button>
        </div>
        <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-base font-semibold">{t('templateDescriptor')}</h3>
                <p className="mt-1 text-xs text-ink-soft">
                  {isSuperadmin
                    ? t('templateScopeSuper')
                    : t('templateScopeTenant')}
                </p>
              </div>
              <button
                type="button"
                className="rounded-md border border-sage/40 bg-sage/10 px-3 py-1.5 text-xs font-semibold text-sage"
                onClick={() => setTemplateEditorText(EXAMPLE_TEMPLATE_DESCRIPTOR)}
              >
                {t('loadExample')}
              </button>
            </div>
            {isSuperadmin ? (
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <label className="inline-flex items-center gap-2 font-semibold">
                  <input
                    type="radio"
                    checked={templateScope === 'platform'}
                    onChange={() => setTemplateScope('platform')}
                  />
                  {t('platformScope')}
                </label>
                <label className="inline-flex items-center gap-2 font-semibold">
                  <input
                    type="radio"
                    checked={templateScope === 'tenant'}
                    onChange={() => setTemplateScope('tenant')}
                  />
                  {t('tenantScope')}
                </label>
                {templateScope === 'tenant' ? (
                  <select
                    className="rounded-md border border-ink/15 bg-paper px-3 py-2"
                    value={templateTenantId}
                    onChange={(e) => setTemplateTenantId(e.target.value)}
                  >
                    <option value="">{t('chooseTenant')}</option>
                    {tenantOptions.map((tn) => (
                      <option key={tn.id} value={tn.id}>
                        {tn.name}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-ink/12 bg-wash/40 p-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-ink/10 bg-white">
                <ConnectorTemplateIcon
                  iconDataUrl={templateIconDataUrl}
                  provider=""
                  className="h-6 w-6"
                />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold">{t('templateIcon')}</p>
                <p className="text-xs text-ink-soft">{t('templateIconHint')}</p>
                {templateIconError ? (
                  <p className="text-xs text-coral">{templateIconError}</p>
                ) : null}
              </div>
              <label className="cursor-pointer rounded-md border border-ink/20 px-3 py-1.5 text-xs font-semibold">
                {t('templateIconUpload')}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (!file) return
                    if (!file.type.startsWith('image/')) {
                      setTemplateIconError(t('templateIconInvalid'))
                      return
                    }
                    if (file.size > 150 * 1024) {
                      setTemplateIconError(t('templateIconTooBig'))
                      return
                    }
                    setTemplateIconError(null)
                    const reader = new FileReader()
                    reader.onload = () => {
                      if (typeof reader.result !== 'string') return
                      const dataUrl = reader.result
                      setTemplateIconDataUrl(dataUrl)
                      setTemplateIconTouched(true)
                      setTemplateEditorText((prev) => {
                        try {
                          const parsed = JSON.parse(prev) as Record<string, unknown>
                          return JSON.stringify({ ...parsed, iconDataUrl: dataUrl }, null, 2)
                        } catch {
                          return prev
                        }
                      })
                    }
                    reader.readAsDataURL(file)
                  }}
                />
              </label>
              {templateIconDataUrl ? (
                <button
                  type="button"
                  className="rounded-md border border-ink/20 px-3 py-1.5 text-xs font-semibold"
                  onClick={() => {
                    setTemplateIconDataUrl(null)
                    setTemplateIconTouched(true)
                    setTemplateEditorText((prev) => {
                      try {
                        const parsed = JSON.parse(prev) as Record<string, unknown>
                        delete parsed.iconDataUrl
                        return JSON.stringify(parsed, null, 2)
                      } catch {
                        return prev
                      }
                    })
                  }}
                >
                  {t('templateIconRemove')}
                </button>
              ) : null}
            </div>
            <textarea
              className="h-80 w-full rounded-md border border-ink/15 bg-paper px-3 py-2 font-mono text-xs"
              value={templateEditorText}
              onChange={(e) => setTemplateEditorText(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={
                  pending ||
                  !templateEditorText.trim() ||
                  (isSuperadmin && templateScope === 'tenant' && !templateTenantId)
                }
                onClick={() => {
                  let descriptor: unknown
                  try {
                    descriptor = JSON.parse(templateEditorText)
                  } catch {
                    setError(t('invalidTemplateJson'))
                    return
                  }
                  if (isSuperadmin && templateScope === 'tenant' && !templateTenantId) {
                    setError(t('pickTenantForTemplate'))
                    return
                  }
                  if (templateIconTouched && typeof descriptor === 'object' && descriptor !== null) {
                    if (templateIconDataUrl) {
                      ;(descriptor as Record<string, unknown>).iconDataUrl = templateIconDataUrl
                    } else {
                      delete (descriptor as Record<string, unknown>).iconDataUrl
                    }
                  }
                  run(
                    () =>
                      upsertConnectorTemplateAction({
                        descriptor,
                        tenantId: isSuperadmin
                          ? templateScope === 'tenant'
                            ? templateTenantId
                            : null
                          : (activeTenantId ?? null),
                      }),
                    t('templateSaved'),
                  )
                }}
                className="rounded-md bg-ink px-4 py-2 text-xs font-semibold text-card disabled:opacity-50"
              >
                {t('saveTemplate')}
              </button>
            </div>
          </div>

          <TemplateCatalogList
            templates={templates}
            pending={pending}
            canManage
            onLoad={(template) => {
              setTemplateEditorText(JSON.stringify(template.descriptor, null, 2))
              setTemplateIconDataUrl(template.descriptor.iconDataUrl ?? null)
              setTemplateIconTouched(true)
              setTemplateIconError(null)
            }}
            onDeprecate={(templateId) =>
              run(
                () => deprecateConnectorTemplateAction({ templateId }),
                t('templateDeprecated'),
              )
            }
          />
        </div>
      </Card>
      ) : null}
      {!canManageCatalog ? (
        <Card title={t('templateCard')}>
          <p className="mb-4 text-sm text-ink-soft">
            {t('templatesFromThese')}
          </p>
          <TemplateCatalogList templates={templates} pending={pending} canManage={false} />
        </Card>
      ) : null}
        </div>
      ) : currentView !== 'hub' && !loadedOnce ? (
        <p className="text-sm text-ink-soft">{t('loading')}</p>
      ) : (
        hubContent
      )}
    </div>
  )
}

function ErrorDialog({ message, onClose }: { message: string | null; onClose: () => void }) {
  const t = useProvT()
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
            <h3 className="text-base font-semibold text-ink">{t('error')}</h3>
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
            {t('gotIt')}
          </button>
        </div>
      </div>
    </div>
  )
}

function CatalogGapCard({
  row,
  pending,
  run,
}: {
  row: { id: string; name: string; type: string; connectorMode?: 'fixed' | 'self_updating' }
  pending: boolean
  run: (fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) => void
}) {
  const [confirmDecomm, setConfirmDecomm] = useState(false)
  const [decommReason, setDecommReason] = useState('')
  const t = useProvT()

  return (
    <div className="space-y-3 rounded-2xl border border-coral/30 bg-coral/5 p-5">
      <h3 className="text-[15px] font-semibold text-coral">{t('decommissionTitle')}</h3>
      <p className="text-sm text-ink-soft">{t('decommissionGapBody')}</p>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-ink">{t('reason')}</span>
        <input
          className="w-full rounded-xl border border-ink/15 bg-paper px-3 py-2.5"
          value={decommReason}
          onChange={(e) => setDecommReason(e.target.value)}
          placeholder={t('reasonGapPlaceholder')}
        />
      </label>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {confirmDecomm ? (
          <>
            <span className="mr-auto text-sm font-medium text-coral">{t('confirmDecommNamed', { name: row.name })}</span>
            <PillButton onClick={() => setConfirmDecomm(false)}>{t('cancel')}</PillButton>
            <PillButton
              variant="danger"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const res = await decommissionActiveConnector({
                    connectorId: row.id,
                    reason: decommReason.trim() || 'provisioning: kezelés nélküli aktív kapcsolat megszüntetése',
                  })
                  if (!res.success) return res
                  setConfirmDecomm(false)
                  return res
                }, t('decommissionedArchived'))
              }
            >
              {t('yesDecommission')}
            </PillButton>
          </>
        ) : (
          <PillButton variant="danger" onClick={() => setConfirmDecomm(true)}>
            {t('decommission')}
          </PillButton>
        )}
      </div>
    </div>
  )
}

function DraftCard({
  draft,
  onBack,
  agents,
  templates,
  latestTemplateVersions,
  googleOauthConfigured,
  googleDriveOauthConfigured,
  googleApiOauthConfigured,
  googleAdsDeveloperTokenConfigured,
  pending,
  run,
  isSuperadmin,
}: {
  draft: DraftRow
  onBack: () => void
  agents: AgentOption[]
  templates: ConnectorTemplateRow[]
  latestTemplateVersions: Record<string, number>
  googleOauthConfigured: boolean
  googleDriveOauthConfigured: boolean
  googleApiOauthConfigured: boolean
  googleAdsDeveloperTokenConfigured: boolean
  pending: boolean
  run: (fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) => void
  isSuperadmin: boolean
}) {
  const t = useProvT()
  const revokeRef = useRef<HTMLDivElement>(null)
  const [secretAlias, setSecretAlias] = useState(draft.secretAliasSuggested ?? '')
  const [apiKey, setApiKey] = useState('')
  const [clientId, setClientId] = useState(() => draft.delegatedOauthView?.clientId ?? '')
  const [agentId, setAgentId] = useState('')
  const [accessMode, setAccessMode] = useState<'read' | 'write'>('read')
  const [agentApiKey, setAgentApiKey] = useState('')
  const templateFastPath = draft.sourceType === 'template'
  // Javítás: draft-config inline szerkesztése (a gate resetelődik mentéskor).
  const [editingConfig, setEditingConfig] = useState(false)
  const [configDraft, setConfigDraft] = useState('')
  // Kikapcsolás (megszüntetés) megerősítése.
  const [showRevoke, setShowRevoke] = useState(false)
  const [decommReason, setDecommReason] = useState('')
  const [confirmDecomm, setConfirmDecomm] = useState(false)
  const [authTestDetail, setAuthTestDetail] = useState<string | null>(null)
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({})

  const v = draft.validationResult
  const cfg = draft.config
  const [actingUserEmail, setActingUserEmail] = useState(() => cfg?.defaultActingUserEmail ?? '')
  const delegatedOauthView = draft.delegatedOauthView
  const provenance = cfg?.provenance ?? delegatedOauthView?.provenance
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
  const isGoogleDriveConnector = draft.connectorType === 'google_drive'
  const isPlatformGoogleApiConnector = isPlatformGoogleApiConnectorTemplateKey(provenance?.templateKey)
  const isPlatformGoogleConnector =
    isGmailConnector || isGoogleDriveConnector || isPlatformGoogleApiConnector
  const activationHelp = templateDescriptor?.activationHelp?.trim() ?? ''
  const credentialFields = templateDescriptor?.credentialFields
  const isActive = draft.lifecycleState === 'active'
  const isUserDelegated =
    isPlatformGoogleConnector ||
    draft.authMode === 'user_delegated' ||
    cfg?.authMode === 'user_delegated' ||
    draft.httpApiView?.isDelegated === true
  // oauth2 (service VAGY delegált) → nem-titkos client_id-t kell megadni (config.auth.clientId).
  const isOauth2 =
    isPlatformGoogleConnector ||
    isUserDelegated ||
    draft.httpApiView?.authScheme === 'oauth2' ||
    cfg?.auth?.type === 'oauth2'
  const isOstorosborCrm =
    provenance?.templateKey?.startsWith('ostorosbor-crm') === true ||
    cfg?.provider?.startsWith('ostorosbor-crm') === true
  const hasActivationCredentials = isPlatformGoogleConnector
    ? isGmailConnector
      ? googleOauthConfigured
      : isGoogleDriveConnector
        ? googleDriveOauthConfigured
        : googleApiOauthConfigured
    : !!apiKey.trim() ||
      (!!secretAlias.trim() && isResolvableSecretAlias(secretAlias.trim()))
  const hasInvalidSecretAlias =
    !isPlatformGoogleConnector &&
    !apiKey.trim() &&
    !!secretAlias.trim() &&
    !isResolvableSecretAlias(secretAlias.trim())

  // Google Ads / Analytics / Search Console: a cégnek ki kell választania a fiókot, Ads-nél
  // a platformon kell developer token (vagy egy régi, cég-szintű tartalék).
  const googleAccountView = draft.googleAccountView ?? null
  const googleAccountBlocker = !googleAccountView
    ? null
    : !googleAccountView.bound
      ? t('googleBindingRequired')
      : googleAccountView.provider === 'google-ads' &&
          !googleAdsDeveloperTokenConfigured &&
          !googleAccountView.legacyDeveloperToken
        ? t('googleAdsTokenRequired')
        : null

  const buildActivationInput = (confirmKeyless?: boolean) => ({
    draftId: draft.draftId,
    ...(isGmailConnector || isGoogleDriveConnector || isPlatformGoogleApiConnector
      ? {}
      : apiKey.trim()
        ? { apiKey: apiKey.trim() }
        : secretAlias.trim()
          ? { secretAlias: secretAlias.trim() }
          : {}),
    ...(confirmKeyless && !isPlatformGoogleConnector ? { confirmKeyless: true as const } : {}),
    ...(isOauth2 && !isPlatformGoogleConnector && clientId.trim() ? { clientId: clientId.trim() } : {}),
    ...(isOstorosborCrm && actingUserEmail.trim()
      ? { defaultActingUserEmail: actingUserEmail.trim() }
      : {}),
  })

  const handleActivate = () => {
    if (hasInvalidSecretAlias) return
    if (isGmailConnector && !googleOauthConfigured) return
    if (isGoogleDriveConnector && !googleDriveOauthConfigured) return
    if (isPlatformGoogleApiConnector && !googleApiOauthConfigured) return
    if (googleAccountBlocker) return
    if (!isPlatformGoogleConnector && !hasActivationCredentials) {
      void (async () => {
        const confirmed = await confirmDialog({
          title: t('activateKeylessTitle'),
          description:
            t('activateKeylessBody'),
          confirmLabel: t('activate'),
          tone: 'danger',
        })
        if (!confirmed) return
        run(() => activateConnector(buildActivationInput(true)), t('activatedKeyless'))
      })()
      return
    }
    run(() => activateConnector(buildActivationInput()), t('activated'))
  }

  const selectedAgent = agents.find((agent) => agent.id === agentId)
  const validationReady = !!v && v.status !== 'failed'
  const reviewApproved = draft.reviewStatus === 'approved'
  const sandboxReady = draft.sandboxTestOk === true
  const activationReady = templateFastPath
    ? v?.status !== 'failed'
    : validationReady && sandboxReady && reviewApproved
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
      run(async () => ({ success: false, error: t('invalidJson') }), '')
      return
    }
    run(async () => {
      const res = await updateConnectorDraftConfig({
        draftId: draft.draftId,
        generatedConfig: parsed,
      })
      if (!res.success) return res
      setEditingConfig(false)
      return res
    }, t('configUpdated'))
  }

  const isArchived = draft.lifecycleState === 'archived'
  const canDeleteDraft =
    !isActive &&
    (draft.lifecycleState === 'draft' ||
      draft.lifecycleState === 'validated' ||
      (isSuperadmin && isArchived))
  const handleDelete = async () => {
    const confirmed = await confirmDialog({
      title: t('deleteConnectorTitle'),
      description: t('deleteNeverActivated'),
      confirmLabel: t('delete'),
      tone: 'danger',
    })
    if (!confirmed) return
    run(() => deleteConnectorDraft({ draftId: draft.draftId }), t('connectorDeleted'))
  }
  const openRevoke = () => {
    setShowRevoke(true)
    requestAnimationFrame(() => revokeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  }

  const activationBlocked =
    pending ||
    !activationReady ||
    hasInvalidSecretAlias ||
    (isOstorosborCrm && !actingUserEmail.trim()) ||
    (isGmailConnector && !googleOauthConfigured) ||
    (isGoogleDriveConnector && !googleDriveOauthConfigured) ||
    (isPlatformGoogleApiConnector && !googleApiOauthConfigured) ||
    Boolean(googleAccountBlocker)

  const activateAndConsent = () => {
    void (async () => {
      if (!isPlatformGoogleConnector && !hasActivationCredentials) {
        const confirmed = await confirmDialog({
          title: t('activateKeylessTitle'),
          description: t('activateKeylessShort'),
          confirmLabel: t('activate'),
          tone: 'danger',
        })
        if (!confirmed) return
      }
      run(async () => {
        const activated = await activateConnector(
          buildActivationInput(!isGmailConnector && !hasActivationCredentials),
        )
        if (!activated.success) return { success: false, error: activated.error }
        const consent = await startConnectorOAuth({ connectorId: draft.connectorId })
        if (!consent.success) return { success: false, error: consent.error }
        if (!('stub' in consent.data && consent.data.stub)) {
          navigateToOAuth(consent.data.url)
        }
        return { success: true }
      }, t('activatedConsent'))
    })()
  }

  const startConsent = () =>
    run(async () => {
      const res = await startConnectorOAuth({ connectorId: draft.connectorId })
      if (!res.success) return { success: false, error: res.error }
      if (!('stub' in res.data && res.data.stub)) {
        navigateToOAuth(res.data.url)
      }
      return { success: true }
    }, t('consentStarted'))

  const testWithKey = () =>
    run(async () => {
      const res = await testConnectorDraftWithCredentials(buildActivationInput())
      if (!res.success) return res
      const detail = res.data.detail ?? (res.data.ok ? 'ok' : 'fail')
      setAuthTestDetail(
        res.data.ok
          ? t('keyTestOk', { code: res.data.statusCode ?? 200 })
          : t('keyTestFail', { detail }),
      )
      return { success: res.data.ok, error: res.data.ok ? undefined : detail }
    }, t('keyTestSuccess'))

  const runSandbox = () =>
    run(async () => {
      const res = await testConnectorDraft({ draftId: draft.draftId })
      if (!res.success) return { success: false, error: res.error ?? t('sandboxFailed') }
      const body = res.data as { ok?: boolean; detail?: string; statusCode?: number }
      if (!body.ok) {
        const extra = [body.detail, body.statusCode != null ? `HTTP ${body.statusCode}` : null]
          .filter(Boolean)
          .join(' · ')
        return { success: false, error: extra ? t('sandboxFailedDetail', { extra }) : t('sandboxFailed') }
      }
      return { success: true }
    }, t('sandboxOk'))

  // Az alkalmazás eszközei: a javasolt műveletek, vagy (régi/OAuth kapcsolatnál) a végpontok / hozzáférések.
  const toolItems: ToolItem[] = cfg
    ? cfg.proposedTools.map((tool) => ({
        key: tool.name,
        label: tool.description?.trim() || tool.name,
        detail: `${tool.method} ${tool.path}`,
        access: tool.access,
        enabled: true,
      }))
    : draft.httpApiView
      ? draft.httpApiView.endpoints.map((endpoint) => ({
          key: `${endpoint.method} ${endpoint.path}`,
          label: `${endpoint.method} ${endpoint.path}`,
          enabled: true,
        }))
      : delegatedOauthView
        ? delegatedOauthView.scopes.map((scope) => ({
            key: scope,
            label: scope.replace('https://www.googleapis.com/auth/', ''),
            enabled: true,
          }))
        : []
  const writeCount = toolItems.filter((tool) => tool.access === 'write').length
  const toolSummary =
    writeCount > 0
      ? t('hubToolsSummaryWrite', { count: toolItems.length, write: writeCount })
      : t('hubToolsSummary', { count: toolItems.length })

  const statusText = isActive
    ? t('hubStatusConnected')
    : isArchived
      ? t('hubStatusOff')
      : templateFastPath
        ? t('hubStatusNeedsActivation')
        : t('hubStatusNeedsChecks')
  const statusToneValue: RowTone = isActive ? 'success' : isArchived ? 'neutral' : 'warning'
  const kindLabel = isGmailConnector
    ? 'Gmail'
    : isGoogleDriveConnector
      ? 'Google Drive'
      : isPlatformGoogleApiConnector
        ? t('hubKindGoogle')
        : t('hubKindApi')
  const sourceLabel = provenance?.templateKey
    ? t('hubSourceTemplate', { version: provenance.templateVersion ?? '?' })
    : draft.sourceType === 'openapi' || draft.sourceType === 'api_doc'
      ? t('sourceOpenApi')
      : t('sourceManual')
  const privacyUi = cfg ? privacyCapabilityUi(privacyCapabilityLevel(cfg.privacy)) : null
  const redirectUri = `${typeof window !== 'undefined' ? window.location.origin : process.env.NEXT_PUBLIC_APP_URL ?? ''}/api/connectors/oauth/callback`
  const inputClass = 'w-full rounded-xl border border-ink/15 bg-paper px-3 py-2.5 text-sm'

  const activationFields = isGmailConnector || isGoogleDriveConnector || isPlatformGoogleApiConnector ? (
    <div className="space-y-1 text-sm">
      {(isGmailConnector ? googleOauthConfigured : isGoogleDriveConnector ? googleDriveOauthConfigured : googleApiOauthConfigured) ? (
        <p className="flex items-center gap-2 text-sage">
          <span aria-hidden className="h-2 w-2 rounded-full bg-sage" />
          {isGmailConnector ? t('gmailOauthOk') : isGoogleDriveConnector ? t('driveOauthOk') : t('googleApiOauthOk')}
        </p>
      ) : (
        <p className="text-honey">
          {isGmailConnector ? t('gmailOauthNeed') : isGoogleDriveConnector ? t('driveOauthNeed') : t('googleApiOauthNeed')}
        </p>
      )}
      {googleAccountBlocker ? <p className="text-honey">{googleAccountBlocker}</p> : null}
    </div>
  ) : (
    <div className="grid gap-4">
      {credentialFields?.map((field) => (
        <label key={field.name} className="text-sm">
          <span className="mb-1 block font-medium text-ink">{field.label}</span>
          <input
            type={field.secret ? 'password' : 'text'}
            autoComplete="off"
            className={inputClass}
            value={credentialValues[field.name] ?? ''}
            onChange={(e) => {
              const next = { ...credentialValues, [field.name]: e.target.value }
              setCredentialValues(next)
              setApiKey(credentialFields.every((f) => next[f.name]?.trim()) ? JSON.stringify(next) : '')
            }}
          />
        </label>
      ))}
      {credentialFields ? null : (
        <label className="text-sm">
          <span className="mb-1 block font-medium text-ink">
            {isUserDelegated ? t('oauthClientSecret') : t('apiKey')}
          </span>
          <input
            type="password"
            autoComplete="new-password"
            className={inputClass}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={isUserDelegated ? t('oauthSecretPlaceholder') : t('rawKeyPlaceholder')}
          />
          <span className="mt-1 block text-xs text-ink-soft">
            {isUserDelegated ? t('oauthSecretHint') : t('rawKeyHint')}
          </span>
        </label>
      )}
      {isOauth2 ? (
        <label className="text-sm">
          <span className="mb-1 block font-medium text-ink">{t('oauthClientId')}</span>
          <input
            className={inputClass}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={t('clientIdPlaceholder')}
          />
        </label>
      ) : null}
      {isUserDelegated ? (
        <div className="text-sm">
          <span className="mb-1 block font-medium text-ink">
            {t('redirectUriLabel')} <span className="font-normal text-ink-soft">{t('addToOauthApp')}</span>
          </span>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 select-all truncate rounded-xl border border-ink/15 bg-wash/50 px-3 py-2.5 font-mono text-xs">
              {redirectUri}
            </code>
            <PillButton onClick={() => void navigator.clipboard.writeText(redirectUri)}>{t('copy')}</PillButton>
          </div>
        </div>
      ) : null}
      {isOstorosborCrm ? (
        <label className="text-sm">
          <span className="mb-1 block font-medium text-ink">{t('actingUser')}</span>
          <input
            type="email"
            className={inputClass}
            value={actingUserEmail}
            onChange={(e) => setActingUserEmail(e.target.value)}
            placeholder="pl. ertekesito@ceg.hu"
          />
          {!actingUserEmail.trim() ? <span className="mt-1 block text-xs text-honey">{t('actingUserNeeded')}</span> : null}
        </label>
      ) : null}
      <details className="text-sm">
        <summary className="cursor-pointer text-ink-soft">{t('existingSecret')}</summary>
        <div className="mt-2 space-y-2">
          <p className="text-xs text-ink-soft">{t('existingSecretHint')}</p>
          <input
            className={`${inputClass} disabled:opacity-40`}
            value={secretAlias}
            onChange={(e) => setSecretAlias(e.target.value)}
            placeholder="env:ACME_CRM_API_KEY"
            disabled={!!apiKey.trim()}
          />
          {hasInvalidSecretAlias ? <p className="text-xs text-coral">{t('badAlias')}</p> : null}
        </div>
      </details>
    </div>
  )

  return (
    <div className="space-y-7">
      <BackButton label={t('back')} onClick={onBack} />
      <DetailHeader
        icon={
          <AppIcon
            iconDataUrl={templateDescriptor?.iconDataUrl}
            provider={provenance?.templateKey ?? draft.connectorType ?? ''}
            size="lg"
          />
        }
        title={draft.name}
        status={statusText}
        statusTone={statusToneValue}
        description={templateDescriptor?.description}
        actions={
          <>
            {isActive ? (
              <PillButton onClick={openRevoke}>{t('hubTurnOff')}</PillButton>
            ) : null}
            {canDeleteDraft ? (
              <PillButton disabled={pending} onClick={() => void handleDelete()}>
                {t('hubRemove')}
              </PillButton>
            ) : null}
          </>
        }
      />

      {googleAccountView && !isArchived ? (
        <GoogleConnectorLevelsPanel
          draftId={draft.draftId}
          view={googleAccountView}
          googleApiOauthConfigured={googleApiOauthConfigured}
          googleAdsDeveloperTokenConfigured={googleAdsDeveloperTokenConfigured}
          pending={pending}
          run={run}
        />
      ) : null}

      {/* Kapcsolat: élő állapot, vagy a bekapcsoláshoz szükséges adatok */}
      <DetailSection title={t('hubConnectionTitle')}>
        {isActive ? (
          <div className="flex flex-wrap items-center gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-[15px] text-ink">{t('hubConnectionLive')}</p>
              <p className="mt-0.5 text-sm text-ink-soft">
                {isUserDelegated ? t('hubConnectionLiveDelegated') : t('hubConnectionLiveShared')}
              </p>
            </div>
            {draft.connectorType === 'http_api' && isUserDelegated ? (
              <PillButton variant="success" disabled={pending} onClick={startConsent}>
                {t('startAutoConsent')}
              </PillButton>
            ) : (
              <span className="text-sm font-medium text-sage">{t('hubStatusConnected')}</span>
            )}
          </div>
        ) : isArchived ? (
          <p className="text-[15px] text-ink-soft">{t('hubConnectionOff')}</p>
        ) : (
          <div className="space-y-5">
            {!templateFastPath ? (
              <div className="space-y-1">
                <p className="text-sm font-medium text-ink">{t('hubChecksTitle')}</p>
                <p className="text-xs text-ink-soft">{t('hubChecksHint')}</p>
                <ul className="mt-2 divide-y divide-ink/[0.07] rounded-xl border border-ink/10">
                  <CheckRow
                    done={validationReady}
                    failed={v?.status === 'failed'}
                    label={t('hubCheckValidate')}
                    hint={
                      !v
                        ? t('hubCheckValidateHint')
                        : v.status === 'failed'
                          ? t('hubCheckValidateFailed')
                          : v.status === 'warned'
                            ? t('hubCheckValidateWarned')
                            : t('hubCheckOk')
                    }
                    action={
                      <PillButton
                        disabled={pending}
                        onClick={() => run(() => validateConnectorDraft({ draftId: draft.draftId }), t('validated'))}
                      >
                        {v ? t('hubRunAgain') : t('runValidate')}
                      </PillButton>
                    }
                  >
                    {v && (v.errors.length > 0 || v.warnings.length > 0 || (v.unknownHosts?.length ?? 0) > 0) ? (
                      <div className="mt-2 space-y-2 text-xs">
                        {v.errors.length > 0 ? (
                          <ul className="list-disc pl-5 text-coral">
                            {v.errors.map((e, i) => (
                              <li key={i}>{e}</li>
                            ))}
                          </ul>
                        ) : null}
                        {v.warnings.length > 0 ? (
                          <ul className="list-disc pl-5 text-honey">
                            {v.warnings.map((w, i) => (
                              <li key={i}>{w}</li>
                            ))}
                          </ul>
                        ) : null}
                        {(v.checks.egressAllowlist === 'warned' || v.checks.egressAllowlist === 'failed') &&
                        (v.unknownHosts?.length ?? 0) > 0 ? (
                          <div>
                            <p className="text-ink-soft">{t('newEgressHosts')}</p>
                            <div className="mt-1 flex flex-wrap gap-2">
                              {v.unknownHosts!.map((h) => (
                                <button
                                  key={h}
                                  type="button"
                                  disabled={pending}
                                  className="rounded-full border border-ink/15 bg-paper px-3 py-1 font-mono text-xs hover:bg-honey/15 disabled:opacity-50"
                                  onClick={() =>
                                    run(async () => {
                                      const ext = await extendEgressAllowlist({ host: h, draftId: draft.draftId })
                                      if (!ext.success) return ext
                                      return validateConnectorDraft({ draftId: draft.draftId })
                                    }, t('egressAdded', { host: h }))
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
                  </CheckRow>
                  <CheckRow
                    done={sandboxReady}
                    failed={draft.sandboxTestOk === false}
                    label={t('hubCheckSandbox')}
                    hint={
                      draft.sandboxTestOk === true
                        ? t('hubCheckOk')
                        : draft.sandboxTestOk === false
                          ? t('hubCheckSandboxFailed')
                          : t('hubCheckSandboxHint')
                    }
                    action={
                      <PillButton disabled={pending} onClick={runSandbox}>
                        {draft.sandboxTestOk == null ? t('sandboxTest') : t('hubRunAgain')}
                      </PillButton>
                    }
                  />
                  <CheckRow
                    done={reviewApproved}
                    failed={draft.reviewStatus === 'rejected'}
                    label={t('hubCheckReview')}
                    hint={
                      reviewApproved
                        ? t('hubCheckOk')
                        : draft.reviewStatus === 'rejected'
                          ? t('hubCheckReviewRejected')
                          : draft.reviewStatus === 'changes_requested'
                            ? t('hubCheckReviewChanges')
                            : t('hubCheckReviewHint')
                    }
                    action={
                      reviewApproved ? null : (
                        <div className="flex flex-wrap gap-2">
                          <PillButton
                            variant="success"
                            disabled={pending}
                            onClick={() =>
                              run(
                                () => reviewConnectorDraft({ draftId: draft.draftId, decision: 'approve' }),
                                t('approved'),
                              )
                            }
                          >
                            {t('approve')}
                          </PillButton>
                          <PillButton
                            disabled={pending}
                            onClick={() =>
                              run(
                                () =>
                                  reviewConnectorDraft({ draftId: draft.draftId, decision: 'changes_requested' }),
                                t('changesRequested'),
                              )
                            }
                          >
                            {t('requestChanges')}
                          </PillButton>
                        </div>
                      )
                    }
                  />
                </ul>
              </div>
            ) : null}

            {activationHelp ? (
              <div className="rounded-xl bg-wash/60 px-4 py-3 text-sm">
                <p className="font-medium text-ink">{t('setupHelp')}</p>
                <p className="mt-1 whitespace-pre-line text-ink-soft">{activationHelp}</p>
              </div>
            ) : null}

            {templateFastPath && v?.status === 'failed' ? (
              <div className="text-sm text-coral">
                <p>{t('catalogActivateBlocked')}</p>
                {v.errors.length > 0 ? (
                  <ul className="mt-2 list-disc pl-5">
                    {v.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {activationFields}

            {!isPlatformGoogleConnector && !hasActivationCredentials ? (
              <p className="text-xs text-honey">{t('keylessWarn')}</p>
            ) : null}
            {authTestDetail ? <p className="text-xs text-ink-soft">{t('keyTest', { detail: authTestDetail })}</p> : null}
            {!templateFastPath && !activationReady ? (
              <p className="text-xs text-ink-soft">{t('activatePrereqs')}</p>
            ) : null}

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ink/[0.07] pt-4">
              {hasActivationCredentials && !isPlatformGoogleConnector ? (
                <PillButton disabled={activationBlocked} onClick={testWithKey}>
                  {t('testWithKey')}
                </PillButton>
              ) : null}
              {isUserDelegated ? (
                <>
                  <PillButton disabled={activationBlocked} onClick={handleActivate}>
                    {t('activate')}
                  </PillButton>
                  <PillButton variant="primary" disabled={activationBlocked} onClick={activateAndConsent}>
                    {t('activateAndConsent')}
                  </PillButton>
                </>
              ) : (
                <PillButton variant="primary" disabled={activationBlocked} onClick={handleActivate}>
                  {t('activate')}
                </PillButton>
              )}
            </div>
          </div>
        )}
      </DetailSection>

      <section className="space-y-2">
        <h3 className="px-1 text-sm font-medium text-ink-soft">{t('hubToolsTitle')}</h3>
        <ToolList
          tools={toolItems}
          summary={toolSummary}
          accessLabels={{ read: t('hubAccessRead'), write: t('hubAccessWrite') }}
          emptyText={t('hubToolsEmpty')}
        />
      </section>

      {isActive ? (
        <DetailSection title={t('hubAgentsTitle')} hint={t('hubAgentsHint')}>
          {agents.length === 0 ? (
            <p className="text-sm text-ink-soft">{t('hubAgentsEmpty')}</p>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
                <label className="text-sm">
                  <span className="mb-1 block font-medium text-ink">{t('agent')}</span>
                  <select className={inputClass} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                    <option value="">{t('chooseAgent')}</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </label>
                <fieldset className="text-sm">
                  <legend className="mb-1 block font-medium text-ink">{t('access')}</legend>
                  <div className="flex gap-2">
                    <FilterChip active={accessMode === 'read'} onClick={() => setAccessMode('read')}>
                      {t('hubAccessReadOnly')}
                    </FilterChip>
                    <FilterChip active={accessMode === 'write'} onClick={() => setAccessMode('write')}>
                      {t('hubAccessReadWrite')}
                    </FilterChip>
                  </div>
                </fieldset>
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer text-ink-soft">{t('perAgentKey')}</summary>
                <div className="mt-2 space-y-1">
                  <input
                    type="password"
                    autoComplete="new-password"
                    className={inputClass}
                    value={agentApiKey}
                    onChange={(e) => setAgentApiKey(e.target.value)}
                    placeholder={t('agentOwnedKey')}
                  />
                  <p className="text-xs text-ink-soft">{t('perAgentKeyHint')}</p>
                </div>
              </details>
              <div className="flex justify-end">
                <PillButton
                  variant="primary"
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
                      selectedAgent ? t('assignedNamed', { name: selectedAgent.name }) : t('assigned'),
                    )
                  }
                >
                  {t('assign')}
                </PillButton>
              </div>
            </div>
          )}
        </DetailSection>
      ) : null}

      {isActive && showRevoke ? (
        <div ref={revokeRef} className="space-y-3 rounded-2xl border border-coral/30 bg-coral/5 p-5">
          <h3 className="text-[15px] font-semibold text-coral">{t('decommissionTitle')}</h3>
          <p className="text-sm text-ink-soft">{t('decommissionActiveBody')}</p>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-ink">{t('reason')}</span>
            <input
              className={inputClass}
              value={decommReason}
              onChange={(e) => setDecommReason(e.target.value)}
              placeholder={t('reasonActivePlaceholder')}
            />
          </label>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <PillButton
              onClick={() => {
                setShowRevoke(false)
                setConfirmDecomm(false)
              }}
            >
              {t('cancel')}
            </PillButton>
            {!confirmDecomm ? (
              <PillButton variant="danger" onClick={() => setConfirmDecomm(true)}>
                {t('hubTurnOff')}
              </PillButton>
            ) : (
              <PillButton
                variant="danger"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    const res = await decommissionConnector({
                      draftId: draft.draftId,
                      reason: decommReason.trim() || undefined,
                    })
                    if (!res.success) return res
                    setConfirmDecomm(false)
                    setShowRevoke(false)
                    return res
                  }, t('connectorDecommissioned'))
                }
              >
                {t('yesDecommission')}
              </PillButton>
            )}
          </div>
        </div>
      ) : null}

      <DetailSection title={t('hubInfoTitle')} flush>
        <InfoRows
          rows={[
            { label: t('status'), value: statusText },
            { label: t('hubInfoKind'), value: kindLabel },
            {
              label: t('hubInfoAuth'),
              value: isUserDelegated ? t('hubAuthPerUser') : t('hubAuthShared'),
            },
            {
              label: t('hubInfoSource'),
              value: templateOutdated
                ? `${sourceLabel} · ${t('newerTemplate', { version: latestTemplateVersion ?? '' })}`
                : sourceLabel,
            },
            ...(privacyUi ? [{ label: t('hubInfoPrivacy'), value: privacyUi.label, title: privacyUi.title }] : []),
            { label: t('hubInfoCreated'), value: new Date(draft.createdAt).toLocaleString('hu-HU') },
          ]}
        />
      </DetailSection>

      <AdvancedDisclosure title={t('hubAdvanced')} hint={t('hubAdvancedHint')}>
        {cfg ? (
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h4 className="mb-1 font-medium">{t('egressHosts')}</h4>
              <ul className="font-mono text-xs text-ink-soft">
                {cfg.egressHosts.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
              <h4 className="mb-1 mt-3 font-medium">{t('hubAdvancedAuth')}</h4>
              <p className="text-xs text-ink-soft">
                {cfg.authMode} · {cfg.auth.type}
                {cfg.auth.headerName ? ` · ${cfg.auth.headerName}` : ''}
                {cfg.auth.secretAliasSuggested ? (
                  <>
                    <br />
                    secret-alias: <code>{cfg.auth.secretAliasSuggested}</code>
                  </>
                ) : null}
              </p>
            </div>
            <div>
              <h4 className="mb-1 font-medium">{t('hubAdvancedScopes')}</h4>
              <div className="flex flex-wrap gap-1">
                {cfg.scopesSuggested.length === 0 ? (
                  <span className="text-xs text-ink-soft">—</span>
                ) : (
                  cfg.scopesSuggested.map((scope) => (
                    <Badge key={scope} tone="neutral">
                      {scope}
                    </Badge>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : delegatedOauthView ? (
          <ul className="space-y-1 font-mono text-xs text-ink-soft">
            <li>provider: {delegatedOauthView.provider}</li>
            <li>authUrl: {delegatedOauthView.authUrl}</li>
            <li>tokenUrl: {delegatedOauthView.tokenUrl}</li>
            {delegatedOauthView.userInfoUrl ? <li>userInfoUrl: {delegatedOauthView.userInfoUrl}</li> : null}
            <li>
              clientId:{' '}
              {delegatedOauthView.clientId?.trim() ? delegatedOauthView.clientId : t('platformGoogleOauth')}
            </li>
            <li>scopeTransform: {delegatedOauthView.scopeTransform}</li>
          </ul>
        ) : draft.httpApiView ? (
          <div className="space-y-1 text-xs text-ink-soft">
            <p>{t('httpApiViaEditor')}</p>
            {draft.httpApiView.baseUrl ? (
              <p>
                Base URL: <code>{draft.httpApiView.baseUrl}</code>
              </p>
            ) : null}
            {draft.httpApiView.authScheme ? (
              <p>
                Auth: {draft.authMode} · {draft.httpApiView.isDelegated ? 'oauth2' : draft.httpApiView.authScheme}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-coral">{t('unreadableConfig')}</p>
        )}

        <p className="text-xs text-ink-soft">
          {t('sourceHash', { type: draft.sourceType })} <code className="break-all">{draft.sourceHash}</code>
          {provenance?.templateKey ? (
            <>
              <br />
              {t('templateLabel', { key: provenance.templateKey })} v{provenance.templateVersion ?? '?'}
              {provenance.materializedAt ? ` · ${t('materialized', { at: provenance.materializedAt })}` : ''}
            </>
          ) : null}
        </p>

        {isActive ? (
          <div className="rounded-xl border border-ink/10 p-4">
            <h4 className="mb-1 font-medium">{t('editFix')}</h4>
            <p className="mb-3 text-xs text-ink-soft">{t('cannotEditLive')}</p>
            <PillButton
              disabled={pending}
              onClick={() => run(() => reopenConnector({ draftId: draft.draftId }), t('reopened'))}
            >
              {t('reopenDraft')}
            </PillButton>
          </div>
        ) : null}

        {!isActive && cfg ? (
          <div className="rounded-xl border border-ink/10 p-4">
            <div className="flex items-center justify-between gap-3">
              <h4 className="font-medium">{t('editConfig')}</h4>
              {!editingConfig ? <PillButton onClick={startConfigEdit}>{t('edit')}</PillButton> : null}
            </div>
            {editingConfig ? (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-honey">{t('editResetsGates')}</p>
                <textarea
                  className="h-64 w-full rounded-xl border border-ink/15 bg-paper px-3 py-2 font-mono text-xs"
                  value={configDraft}
                  onChange={(e) => setConfigDraft(e.target.value)}
                />
                <div className="flex flex-wrap justify-end gap-2">
                  <PillButton onClick={() => setEditingConfig(false)}>{t('cancel')}</PillButton>
                  <PillButton variant="primary" disabled={pending} onClick={saveConfigEdit}>
                    {t('saveConfig')}
                  </PillButton>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {!isActive && !templateFastPath && !isArchived && draft.reviewStatus !== 'rejected' ? (
          <div className="flex justify-end">
            <PillButton
              variant="danger"
              disabled={pending}
              onClick={() =>
                run(() => reviewConnectorDraft({ draftId: draft.draftId, decision: 'reject' }), t('rejected'))
              }
            >
              {t('reject')}
            </PillButton>
          </div>
        ) : null}
      </AdvancedDisclosure>
    </div>
  )
}

/** Egy bekapcsolás előtti ellenőrzési lépés: pipa / hiba jelzés, rövid magyarázat, gomb. */
function CheckRow({
  done,
  failed,
  label,
  hint,
  action,
  children,
}: {
  done: boolean
  failed?: boolean
  label: string
  hint: string
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-hidden
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            done ? 'bg-sage text-card' : failed ? 'bg-coral text-card' : 'bg-ink/10 text-ink-soft'
          }`}
        >
          {done ? '✓' : failed ? '!' : '·'}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] text-ink">{label}</span>
          <span className={`block text-xs ${failed ? 'text-coral' : 'text-ink-soft'}`}>{hint}</span>
        </span>
        {action}
      </div>
      {children}
    </li>
  )
}
