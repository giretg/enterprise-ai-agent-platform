import { parseHttpApiConfig } from '@/domain/connector/http-api-client'
import { gitHubRepositoryAccessFromText } from '@/domain/connector/github-repository-access'
import {
  normalizeConnectorConfig,
  type ConnectorConfig,
} from '@/domain/provisioning/connector-config'
import { materializeGmailConnectorConfig } from './gmail-connector-config'
import type {
  AuthMethodDescriptor,
  InstanceFieldDescriptor,
  MaterializeConnectorInput,
  TemplateDescriptor,
} from './template-descriptor'
import { ConnectorTemplateMaterializationError } from './template-descriptor'

export { ConnectorTemplateMaterializationError }

export type ConnectorTemplateProvenance = {
  templateId?: string
  templateKey: string
  templateVersion: number
  templateOrigin: 'builtin' | 'custom'
  materializedAt?: string
}

export function materializeConnectorConfig(
  descriptor: TemplateDescriptor,
  chosen: MaterializeConnectorInput,
  secretAliases: Record<string, string>,
  provenance?: Partial<ConnectorTemplateProvenance>,
): ConnectorConfig {
  const authMethod = descriptor.authMethods.find((m) => m.kind === chosen.authMethodKind)
  if (!authMethod) {
    throw new ConnectorTemplateMaterializationError(
      `template auth method not found: ${chosen.authMethodKind}`,
    )
  }

  const selectedScopes = chooseScopes(descriptor, chosen.selectedScopes)
  const base: ConnectorConfig = {
    provider: descriptor.key,
    baseUrl: interpolate(descriptor.baseUrl, chosen.instanceValues),
    egressHosts: descriptor.egressHosts.map((host) => interpolate(host, chosen.instanceValues)),
    authMode: authModeFor(authMethod),
    auth: authFor(authMethod, selectedScopes),
    scopesSuggested: selectedScopes,
    ...(descriptor.rateLimit ? { rateLimit: descriptor.rateLimit } : {}),
    proposedTools: chooseEndpoints(descriptor, chosen.selectedEndpoints),
    provenance: {
      templateKey: provenance?.templateKey ?? descriptor.key,
      templateVersion: provenance?.templateVersion ?? 1,
      templateOrigin: provenance?.templateOrigin ?? 'builtin',
      materializedAt: provenance?.materializedAt ?? new Date().toISOString(),
      ...(provenance?.templateId ? { templateId: provenance.templateId } : {}),
    },
  }

  const withFields = applyInstanceFields(base, descriptor.instanceFields, chosen.instanceValues, secretAliases)
  const scopedConfig =
    withFields.githubRepositoryAccess?.mode === 'selected'
      ? {
          ...withFields,
          proposedTools: withFields.proposedTools.filter((tool) =>
            tool.path.startsWith('/repos/{owner}/{repo}'),
          ),
        }
      : withFields

  // WP-3 (B3): a sablonból materializált, endpoint-listával rendelkező http_api
  // connector alapból endpoint-korlátozott — a runtime CSAK a felsorolt (method+path)
  // hívásokat engedi, a listán kívülit a külső rendszer megkérdezése nélkül elutasítja
  // (`endpoint_not_allowed`). Kivétel a GitHub repo-scope connector: azt a saját
  // repository-határ őrzi, és a katalógusa szándékosan tágabb, ezért nem korlátozzuk.
  const isGithubRepoScoped = Boolean(scopedConfig.githubRepositoryAccess)
  const restrictedConfig: ConnectorConfig =
    !isGithubRepoScoped && scopedConfig.proposedTools.length > 0
      ? { ...scopedConfig, restrictToEndpoints: true }
      : scopedConfig
  const normalized = normalizeConnectorConfig({
    ...restrictedConfig,
    egressHosts: normalizeHosts([
      ...restrictedConfig.egressHosts,
      ...hostsFromConfig(restrictedConfig),
    ]),
  })

  // Contract check: the same stored config must be valid for the runtime HTTP engine.
  parseHttpApiConfig(normalized)
  return normalized
}

export function selfCheckTemplateDescriptor(
  descriptor: TemplateDescriptor,
  sample?: Partial<MaterializeConnectorInput> & { secretAliases?: Record<string, string> },
): ConnectorConfig {
  const authMethodKind =
    sample?.authMethodKind ?? descriptor.authMethods[0]?.kind
  if (!authMethodKind) {
    throw new ConnectorTemplateMaterializationError('template must define at least one auth method')
  }

  const instanceValues: Record<string, string> = {}
  const secretAliases: Record<string, string> = {}
  for (const field of descriptor.instanceFields) {
    if (field.type === 'secret') {
      secretAliases[field.name] =
        sample?.secretAliases?.[field.name] ??
        field.secretAliasHint ??
        `secret-ref:connector-template-self-check/${descriptor.key}/${field.name}`
      continue
    }
    instanceValues[field.name] =
      sample?.instanceValues?.[field.name] ??
      sampleValueForField(field, descriptor.key)
  }

  if ((descriptor.connectorType ?? 'http_api') === 'gmail') {
    materializeGmailConnectorConfig(
      descriptor,
      {
        authMethodKind,
        instanceValues,
        selectedScopes: sample?.selectedScopes,
        selectedEndpoints: sample?.selectedEndpoints,
      },
      secretAliases,
      {
        templateKey: descriptor.key,
        templateVersion: 1,
        templateOrigin: 'custom',
        materializedAt: '2026-07-02T00:00:00.000Z',
      },
    )
    // Gmail sablonok nem http_api runtime configot adnak — a self-check itt csak
    // a materializálhatóságot ellenőrzi. Visszatérési típus kompatibilitás miatt
    // egy minimális http_api placeholder configot adunk vissza.
    return normalizeConnectorConfig({
      provider: descriptor.key,
      baseUrl: descriptor.baseUrl,
      egressHosts: descriptor.egressHosts,
      authMode: 'user_delegated',
      auth: { type: 'oauth2', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', clientId: 'self-check' },
      scopesSuggested: [],
      proposedTools: [],
    })
  }

  return materializeConnectorConfig(
    descriptor,
    {
      authMethodKind,
      instanceValues,
      selectedScopes: sample?.selectedScopes,
      selectedEndpoints: sample?.selectedEndpoints,
    },
    secretAliases,
    {
      templateKey: descriptor.key,
      templateVersion: 1,
      templateOrigin: 'custom',
      materializedAt: '2026-07-02T00:00:00.000Z',
    },
  )
}

function sampleValueForField(field: InstanceFieldDescriptor, key: string): string {
  if (field.enumValues?.[0]) return field.enumValues[0]
  if (field.validation?.format === 'url') return `https://api.${key}.example`
  if (field.validation?.format === 'host') return `api.${key}.example`
  if (field.validation?.format === 'hostList') return `api.${key}.example`
  if (field.name.toLowerCase().includes('clientid')) return `${key}-client-id`
  if (field.name.toLowerCase().includes('repository')) return 'owner/example-repository'
  if (field.name.toLowerCase().includes('host')) return `api.${key}.example`
  return `${key}-${field.name}`
}

function authModeFor(method: AuthMethodDescriptor): ConnectorConfig['authMode'] {
  if (method.kind === 'user_delegated_oauth2') return 'user_delegated'
  return 'service'
}

function authFor(method: AuthMethodDescriptor, scopes: string[]): ConnectorConfig['auth'] {
  if (method.kind === 'api_key') {
    return { type: 'api_key_header', headerName: method.header }
  }
  if (method.kind === 'bearer') return { type: 'bearer_token' }
  if (method.kind === 'basic') return { type: 'basic' }
  return {
    type: 'oauth2',
    authUrl: method.authUrl,
    tokenUrl: method.tokenUrl,
    clientId: '',
    scope: scopes.join(' '),
    ...(method.userInfoUrl ? { userInfoUrl: method.userInfoUrl } : {}),
    accountEmailField: method.accountEmailField,
    offlineParams: method.offlineParams,
    scopeTransform: method.scopeTransform,
  }
}

function chooseScopes(descriptor: TemplateDescriptor, selected?: string[]): string[] {
  if (descriptor.scopeCatalog.length === 0) {
    if (selected && selected.length > 0) {
      throw new ConnectorTemplateMaterializationError(
        `template does not define selectable scopes: ${descriptor.key}`,
      )
    }
    return []
  }
  const allowed = new Set(descriptor.scopeCatalog.map((s) => s.value))
  const defaults = descriptor.scopeCatalog.filter((s) => s.default).map((s) => s.value)
  const requested = selected && selected.length > 0 ? selected : defaults
  const unknown = requested.filter((scope) => !allowed.has(scope))
  if (unknown.length > 0) {
    throw new ConnectorTemplateMaterializationError(`unknown template scopes: ${unknown.join(', ')}`)
  }
  return [...new Set(requested)]
}

function chooseEndpoints(
  descriptor: TemplateDescriptor,
  selected?: string[],
): ConnectorConfig['proposedTools'] {
  const selectedSet = selected && selected.length > 0 ? new Set(selected) : null
  const endpoints = descriptor.endpoints.filter((endpoint) =>
    selectedSet ? selectedSet.has(endpoint.name) : endpoint.default,
  )
  if (selectedSet) {
    const known = new Set(descriptor.endpoints.map((endpoint) => endpoint.name))
    const unknown = [...selectedSet].filter((name) => !known.has(name))
    if (unknown.length > 0) {
      throw new ConnectorTemplateMaterializationError(
        `unknown template endpoints: ${unknown.join(', ')}`,
      )
    }
  }
  return endpoints.map((endpoint) => ({
    name: endpoint.name,
    method: endpoint.method,
    path: endpoint.path,
    access: endpoint.access,
    ...(endpoint.description ? { description: endpoint.description } : {}),
  }))
}

function applyInstanceFields(
  config: ConnectorConfig,
  fields: InstanceFieldDescriptor[],
  values: Record<string, string>,
  secretAliases: Record<string, string>,
): ConnectorConfig {
  const next = structuredClone(config) as ConnectorConfig
  for (const field of fields) {
    const rawValue = field.type === 'secret' ? secretAliases[field.name] : values[field.name]
    const value = typeof rawValue === 'string' ? rawValue.trim() : ''
    if (field.required && !value) {
      throw new ConnectorTemplateMaterializationError(`missing template field: ${field.name}`)
    }
    if (!value) continue
    validateField(field, value)
    assignTarget(next, field.target, value, values)
  }
  return next
}

function validateField(field: InstanceFieldDescriptor, value: string): void {
  if (field.enumValues && !field.enumValues.includes(value)) {
    throw new ConnectorTemplateMaterializationError(`invalid enum value for ${field.name}`)
  }
  if (field.validation?.pattern && !new RegExp(field.validation.pattern).test(value)) {
    throw new ConnectorTemplateMaterializationError(`field does not match pattern: ${field.name}`)
  }
  if (field.validation?.format === 'url') {
    assertUrl(value, field.name)
  } else if (field.validation?.format === 'host') {
    assertHost(value, field.name)
  } else if (field.validation?.format === 'hostList') {
    for (const host of value.split(',').map((h) => h.trim()).filter(Boolean)) {
      assertHost(host, field.name)
    }
  }
}

function assignTarget(
  config: ConnectorConfig,
  target: string,
  value: string,
  values: Record<string, string>,
): void {
  const interpolated = interpolate(value, values)
  if (target === 'baseUrl') {
    config.baseUrl = interpolated
    return
  }
  if (target === 'provider') {
    config.provider = interpolated
    return
  }
  if (target === 'egressHosts') {
    config.egressHosts.push(...interpolated.split(',').map((h) => h.trim()).filter(Boolean))
    return
  }
  if (target === 'auth.clientId') {
    config.auth.clientId = interpolated
    return
  }
  if (target === 'auth.secretAliasSuggested') {
    config.auth.secretAliasSuggested = interpolated
    return
  }
  if (target === 'auth.headerName') {
    config.auth.headerName = interpolated
    return
  }
  if (target === 'github.repositoryAccess') {
    config.githubRepositoryAccess = gitHubRepositoryAccessFromText(interpolated)
    return
  }
  throw new ConnectorTemplateMaterializationError(`unsupported template target: ${target}`)
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => values[key] ?? '')
}

function hostsFromConfig(config: ConnectorConfig): string[] {
  const hosts = [hostOf(config.baseUrl)]
  if (config.auth.type === 'oauth2') {
    hosts.push(hostOf(config.auth.authUrl), hostOf(config.auth.tokenUrl), hostOf(config.auth.userInfoUrl))
  }
  return hosts.filter((host): host is string => Boolean(host))
}

function normalizeHosts(hosts: string[]): string[] {
  return [...new Set(hosts.map((host) => host.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')))]
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null
  }
}

function assertUrl(value: string, field: string): void {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('bad protocol')
  } catch {
    throw new ConnectorTemplateMaterializationError(`field must be an absolute URL: ${field}`)
  }
}

function assertHost(value: string, field: string): void {
  if (!/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(value)) {
    throw new ConnectorTemplateMaterializationError(`field must be a host: ${field}`)
  }
}
