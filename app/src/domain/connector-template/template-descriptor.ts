import { z } from 'zod'
import { HTTP_API_PROTOCOLS, HTTP_METHODS } from '@/domain/provisioning/connector-config'
import {
  connectorFieldsPrivacySchema,
  privacyCapabilityDeclarationSchema,
} from '@/domain/privacy/connector-privacy'

export const connectorTemplateKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'template key must be kebab-case')

export const instanceFieldSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['string', 'secret', 'scopeSelection', 'endpointSelection', 'enum']),
  required: z.boolean().default(true),
  validation: z
    .object({
      pattern: z.string().optional(),
      format: z.enum(['url', 'host', 'hostList']).optional(),
    })
    .optional(),
  secretAliasHint: z.string().optional(),
  /** Sablon-varázslóban ne jelenjen meg — érték a secretAliasHint-ből / aktiváláskor jön. */
  hiddenInProvisioning: z.boolean().optional(),
  enumValues: z.array(z.string()).optional(),
  /** Mintaérték: a varázsló placeholdere és a sablon self-check mintája. */
  example: z.string().optional(),
  target: z.string().min(1),
})
export type InstanceFieldDescriptor = z.infer<typeof instanceFieldSchema>

export const scopeDescriptorSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  default: z.boolean().default(false),
})
export type ScopeDescriptor = z.infer<typeof scopeDescriptorSchema>

export const templateEndpointSchema = z.object({
  name: z.string().min(1),
  method: z.enum(HTTP_METHODS),
  path: z.string().min(1),
  access: z.enum(['read', 'write']),
  /** Opcionális következmény-kapu jelölés; hiányában access + metódus dönt. */
  risk: z.enum(['read', 'write', 'danger']).optional(),
  description: z.string().optional(),
  default: z.boolean().default(true),
})
export type TemplateEndpoint = z.infer<typeof templateEndpointSchema>

export type MaterializeConnectorInput = {
  authMethodKind: AuthMethodDescriptor['kind']
  instanceValues: Record<string, string>
  selectedScopes?: string[]
  selectedEndpoints?: string[]
}

const oauthBase = z.object({
  authUrl: z.string().url(),
  tokenUrl: z.string().url(),
  userInfoUrl: z.string().url().optional(),
  accountEmailField: z.string().default('email'),
  offlineParams: z.record(z.string(), z.string()).default({}),
  scopeTransform: z.enum(['none', 'gmailAlias']).default('none'),
})

export const authMethodDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('api_key'), header: z.string().min(1) }),
  z.object({ kind: z.literal('bearer') }),
  z.object({ kind: z.literal('basic') }),
  z.object({ kind: z.literal('service_oauth2') }).extend(oauthBase.shape),
  z.object({ kind: z.literal('user_delegated_oauth2') }).extend(oauthBase.shape),
])
export type AuthMethodDescriptor = z.infer<typeof authMethodDescriptorSchema>

export const templateConnectorTypeSchema = z
  .enum(['http_api', 'gmail', 'google_drive'])
  .default('http_api')

export const MAX_TEMPLATE_ICON_DATA_URL_LENGTH = 200_000

export const templateIconDataUrlSchema = z
  .string()
  .min(1)
  .max(
    MAX_TEMPLATE_ICON_DATA_URL_LENGTH,
    'template icon must be smaller than ~150KB',
  )
  .refine(
    (value) => /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/.test(value),
    'template icon must be a base64 image data URL',
  )

export const templateDescriptorSchema = z.object({
  key: connectorTemplateKeySchema,
  displayName: z.string().min(1),
  description: z.string().optional(),
  /** A szolgáltatás ikonja data URL-ként (DB-ben tárolva); hiányában generikus ikon látszik. */
  iconDataUrl: templateIconDataUrlSchema.optional(),
  activationHelp: z.string().min(1).optional(),
  /** A materializált connector Prisma `type` mezője. Alapértelmezés: http_api. */
  connectorType: templateConnectorTypeSchema.default('http_api'),
  baseUrl: z.string().url(),
  egressHosts: z.array(z.string().min(1)).min(1),
  authMethods: z.array(authMethodDescriptorSchema).min(1),
  endpoints: z.array(templateEndpointSchema).default([]),
  scopeCatalog: z.array(scopeDescriptorSchema).default([]),
  rateLimit: z.object({ rps: z.number().nonnegative(), burst: z.number().nonnegative() }).optional(),
  /** Minden hívásra injektált sablonfejlécek (pl. CRM audit/trace fejlécek). */
  requestHeaders: z.record(z.string(), z.string()).optional(),
  /** XML-alapú API adaptere (Számlázz.hu Agent, NAV Online Számla); hiányában JSON REST. */
  protocol: z.enum(HTTP_API_PROTOCOLS).optional(),
  /**
   * Több részből álló titok (pl. NAV: login + jelszó + aláírókulcs): aktiváláskor
   * mezőnként kérjük be, és JSON-objektumként egyetlen secretként tároljuk.
   */
  credentialFields: z
    .array(z.object({ name: z.string().min(1), label: z.string().min(1), secret: z.boolean().optional() }))
    .optional(),
  instanceFields: z.array(instanceFieldSchema).default([]),
  /**
   * Privacy interface contract (spec §11) — materializáláskor a connector configba kerül.
   */
  privacy: privacyCapabilityDeclarationSchema.optional(),
  /** Mezőszintű privacy metadata (spec §7). */
  fields: connectorFieldsPrivacySchema.optional(),
  /**
   * issue #220 — opcionális következmény-határ címke. Materializáláskor a
   * Connector.consequenceBoundary-re másolható; NEM kapcsolja a kaput.
   */
  consequenceBoundary: z.enum(['external_draft', 'platform']).optional(),
})
export type TemplateDescriptor = z.infer<typeof templateDescriptorSchema>

export function parseTemplateDescriptor(input: unknown): TemplateDescriptor {
  return templateDescriptorSchema.parse(input)
}

export class ConnectorTemplateMaterializationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectorTemplateMaterializationError'
  }
}
