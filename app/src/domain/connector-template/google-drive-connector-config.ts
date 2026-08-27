import { z } from 'zod'
import { normalizeDriveScope } from '@/domain/connector-grant/google-drive-scopes'
import type { ConnectorTemplateProvenance } from './materializer'
import type {
  AuthMethodDescriptor,
  InstanceFieldDescriptor,
  MaterializeConnectorInput,
  TemplateDescriptor,
} from './template-descriptor'
import { ConnectorTemplateMaterializationError } from './template-descriptor'

export const googleDriveOauthConfigSchema = z.object({
  authUrl: z.string().url(),
  tokenUrl: z.string().url(),
  userInfoUrl: z.string().url().optional(),
  accountEmailField: z.string().default('email'),
  offlineParams: z.record(z.string(), z.string()).default({}),
  scopeTransform: z.enum(['none', 'gmailAlias']).default('none'),
  scopes: z.array(z.string().min(1)).min(1),
  clientId: z.string().min(1).optional(),
})

export const googleDriveConnectorConfigSchema = z.object({
  provider: z.string().default('google-drive'),
  oauth: googleDriveOauthConfigSchema,
  provenance: z
    .object({
      templateId: z.string().optional(),
      templateKey: z.string().optional(),
      templateVersion: z.number().int().positive().optional(),
      templateOrigin: z.enum(['builtin', 'custom']).optional(),
      materializedAt: z.string().optional(),
      sourceHash: z.string().optional(),
    })
    .optional(),
})

export type GoogleDriveConnectorConfig = z.infer<typeof googleDriveConnectorConfigSchema>

export function normalizeGoogleDriveConnectorConfig(input: unknown): GoogleDriveConnectorConfig {
  const parsed = googleDriveConnectorConfigSchema.parse(input)
  return {
    ...parsed,
    oauth: {
      ...parsed.oauth,
      scopes: [...new Set(parsed.oauth.scopes.map(normalizeDriveScope))],
    },
  }
}

function chooseDriveScopes(descriptor: TemplateDescriptor, selected?: string[]): string[] {
  if (descriptor.scopeCatalog.length === 0) {
    throw new ConnectorTemplateMaterializationError(
      `google_drive template must define scope catalog: ${descriptor.key}`,
    )
  }
  const allowed = new Set(descriptor.scopeCatalog.map((scope) => scope.value))
  const defaults = descriptor.scopeCatalog.filter((scope) => scope.default).map((scope) => scope.value)
  const requested = selected && selected.length > 0 ? selected : defaults
  const unknown = requested.filter((scope) => !allowed.has(scope))
  if (unknown.length > 0) {
    throw new ConnectorTemplateMaterializationError(
      `unknown google_drive template scopes: ${unknown.join(', ')}`,
    )
  }
  return [...new Set(requested.map(normalizeDriveScope))]
}

function resolveDelegatedAuthMethod(
  descriptor: TemplateDescriptor,
  chosen: MaterializeConnectorInput,
): Extract<AuthMethodDescriptor, { kind: 'user_delegated_oauth2' }> {
  const authMethod = descriptor.authMethods.find((method) => method.kind === chosen.authMethodKind)
  if (!authMethod || authMethod.kind !== 'user_delegated_oauth2') {
    throw new ConnectorTemplateMaterializationError(
      `google_drive template requires user_delegated_oauth2 auth method: ${descriptor.key}`,
    )
  }
  return authMethod
}

function readInstanceValue(
  field: InstanceFieldDescriptor,
  values: Record<string, string>,
  secretAliases: Record<string, string>,
): string {
  const rawValue = field.type === 'secret' ? secretAliases[field.name] : values[field.name]
  const value = typeof rawValue === 'string' ? rawValue.trim() : ''
  if (field.required && !value) {
    throw new ConnectorTemplateMaterializationError(
      `missing google_drive template field: ${field.name}`,
    )
  }
  return value
}

export function materializeGoogleDriveConnectorConfig(
  descriptor: TemplateDescriptor,
  chosen: MaterializeConnectorInput,
  secretAliases: Record<string, string>,
  provenance?: Partial<ConnectorTemplateProvenance>,
): GoogleDriveConnectorConfig {
  const authMethod = resolveDelegatedAuthMethod(descriptor, chosen)
  const instanceValues = { ...chosen.instanceValues }
  let clientId = instanceValues.clientId?.trim() ?? ''
  let secretAliasSuggested: string | undefined

  for (const field of descriptor.instanceFields) {
    const value = readInstanceValue(field, instanceValues, secretAliases)
    if (!value) continue
    if (field.name === 'clientId' || field.target === 'oauth.clientId' || field.target === 'auth.clientId') {
      clientId = value
    }
    if (field.type === 'secret' || field.target === 'auth.secretAliasSuggested') {
      secretAliasSuggested = value
    }
  }

  const scopes = chooseDriveScopes(descriptor, chosen.selectedScopes)

  return normalizeGoogleDriveConnectorConfig({
    provider: 'google-drive',
    oauth: {
      authUrl: authMethod.authUrl,
      tokenUrl: authMethod.tokenUrl,
      userInfoUrl: authMethod.userInfoUrl,
      accountEmailField: authMethod.accountEmailField,
      offlineParams: authMethod.offlineParams,
      scopeTransform: authMethod.scopeTransform,
      scopes,
      ...(clientId ? { clientId } : {}),
      ...(secretAliasSuggested ? { secretAliasSuggested } : {}),
    },
    provenance: {
      templateKey: provenance?.templateKey ?? descriptor.key,
      templateVersion: provenance?.templateVersion ?? 1,
      templateOrigin: provenance?.templateOrigin ?? 'builtin',
      materializedAt: provenance?.materializedAt ?? new Date().toISOString(),
      ...(provenance?.templateId ? { templateId: provenance.templateId } : {}),
    },
  })
}

export function googleDriveConfigToJson(config: GoogleDriveConnectorConfig): Record<string, unknown> {
  return config
}
