import { z } from 'zod'
import { HTTP_METHODS } from '@/domain/provisioning/connector-config'

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
  enumValues: z.array(z.string()).optional(),
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

export const templateConnectorTypeSchema = z.enum(['http_api', 'gmail']).default('http_api')

export const templateDescriptorSchema = z.object({
  key: connectorTemplateKeySchema,
  displayName: z.string().min(1),
  description: z.string().optional(),
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
  instanceFields: z.array(instanceFieldSchema).default([]),
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
