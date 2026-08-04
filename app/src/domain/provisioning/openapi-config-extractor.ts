/**
 * Determinisztikus OpenAPI/Swagger → ConnectorConfig kinyerés.
 * Az API-doksi forrás belső elágazása: felismert spec esetén LLM nélkül dolgozzuk fel.
 */
import {
  normalizeConnectorConfig,
  ConnectorConfigParseError,
  WRITE_METHODS,
  type ConnectorAuth,
  type ConnectorConfig,
  type HttpMethod,
  type ProposedTool,
} from './connector-config'
import { extractLoose } from '@/domain/contract-runtime'

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

export type OpenApiExtractResult =
  | { ok: true; config: ConnectorConfig }
  | {
      ok: false
      reason: 'not_openapi' | 'parse_error' | 'unsupported' | 'invalid_config'
      detail?: string
    }

type OpenApiSpec = Record<string, unknown>

type SecurityRequirement = Record<string, string[]>

function decodeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}

function resolveLocalRef(root: OpenApiSpec, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined
  const parts = ref.slice(2).split('/').map(decodeJsonPointerSegment)
  let cur: unknown = root
  for (const part of parts) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * js-yaml v5 CORE_SCHEMA számmá parse-olja a idézetlen `3.0` / `2.0` alakokat.
 * Az OpenAPI spec viszont string verziómezőt vár — visszaállítjuk a szokásos major.minor formát.
 */
function coerceYamlOpenApiVersion(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (Number.isInteger(value)) return `${value}.0`
  return String(value)
}

function normalizeYamlOpenApiDocument(doc: unknown): unknown {
  if (!isRecord(doc)) return doc
  const openapi = coerceYamlOpenApiVersion(doc.openapi)
  if (openapi !== undefined) doc.openapi = openapi
  const swagger = coerceYamlOpenApiVersion(doc.swagger)
  if (swagger !== undefined) doc.swagger = swagger
  return doc
}

export function isOpenApiSpec(value: unknown): value is OpenApiSpec {
  if (!isRecord(value)) return false
  const openapi = coerceYamlOpenApiVersion(value.openapi)
  if (openapi !== undefined && openapi.startsWith('3.')) return true
  if (coerceYamlOpenApiVersion(value.swagger) === '2.0') return true
  return false
}

function extractJsonObject(text: string): unknown | null {
  // #33 — közös beolvasó (fence + balanced brace + control-char javítás).
  const loose = extractLoose(text)
  if (loose != null) return loose
  // Teljes JSON dokumentum (nem csak beágyazott objektum) — pl. tiszta OpenAPI fájl.
  try {
    return JSON.parse(text.trim())
  } catch {
    return null
  }
}

function looksLikeOpenApiYaml(text: string): boolean {
  return /^(openapi|swagger)\s*:\s*['"]?[23]/m.test(text.trim())
}

async function loadYamlDocument(text: string): Promise<unknown | null> {
  try {
    const { load } = await import('js-yaml')
    return normalizeYamlOpenApiDocument(load(text))
  } catch {
    return null
  }
}

export async function parseOpenApiDocument(docText: string): Promise<OpenApiSpec | null> {
  const trimmed = docText.trim()
  if (!trimmed) return null

  const jsonCandidate = extractJsonObject(trimmed)
  if (isOpenApiSpec(jsonCandidate)) return jsonCandidate

  if (looksLikeOpenApiYaml(trimmed)) {
    const yamlCandidate = await loadYamlDocument(trimmed)
    if (isOpenApiSpec(yamlCandidate)) return yamlCandidate
  }

  return null
}

/** Szinkron parse — csak JSON; YAML esetén null (a hívó async parse-ot használjon). */
export function parseOpenApiDocumentSync(docText: string): OpenApiSpec | null {
  const candidate = extractJsonObject(docText.trim())
  return isOpenApiSpec(candidate) ? candidate : null
}

function slugifyProvider(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'api'
}

function secretAliasForProvider(provider: string): string {
  const envName = provider.replace(/-/g, '_').toUpperCase()
  return `env:${envName}_API_KEY`
}

function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '') || url
}

function resolveServerUrls(spec: OpenApiSpec): string[] {
  if (spec.swagger === '2.0') {
    const host = typeof spec.host === 'string' ? spec.host.trim() : ''
    const basePath = typeof spec.basePath === 'string' ? spec.basePath : ''
    const schemes = Array.isArray(spec.schemes) && spec.schemes.length > 0 ? spec.schemes : ['https']
    const scheme = typeof schemes[0] === 'string' ? schemes[0] : 'https'
    if (!host) return []
    return [`${scheme}://${host}${basePath}`]
  }

  const servers = spec.servers
  if (!Array.isArray(servers)) return []
  return servers
    .map((entry) => (isRecord(entry) && typeof entry.url === 'string' ? entry.url.trim() : ''))
    .filter(Boolean)
}

function securitySchemesForSpec(spec: OpenApiSpec): Record<string, unknown> {
  if (spec.swagger === '2.0') {
    const defs = spec.securityDefinitions
    return isRecord(defs) ? defs : {}
  }
  const components = spec.components
  if (!isRecord(components)) return {}
  const schemes = components.securitySchemes
  return isRecord(schemes) ? schemes : {}
}

function pathsForSpec(spec: OpenApiSpec): Record<string, unknown> {
  const paths = spec.paths
  return isRecord(paths) ? paths : {}
}

function collectSecurityRequirements(
  spec: OpenApiSpec,
  operation: Record<string, unknown> | undefined,
): SecurityRequirement[] {
  const global = Array.isArray(spec.security) ? (spec.security as SecurityRequirement[]) : []
  const opSecurity = operation?.security
  if (opSecurity === null) return []
  if (Array.isArray(opSecurity)) return opSecurity as SecurityRequirement[]
  return global
}

function countSecuritySchemeUsage(spec: OpenApiSpec): Map<string, number> {
  const counts = new Map<string, number>()
  const bump = (reqs: SecurityRequirement[]) => {
    for (const req of reqs) {
      for (const schemeName of Object.keys(req)) {
        counts.set(schemeName, (counts.get(schemeName) ?? 0) + 1)
      }
    }
  }

  if (Array.isArray(spec.security)) bump(spec.security as SecurityRequirement[])

  for (const pathItem of Object.values(pathsForSpec(spec))) {
    if (!isRecord(pathItem)) continue
    for (const method of HTTP_METHODS) {
      const op = pathItem[method]
      if (!isRecord(op)) continue
      bump(collectSecurityRequirements(spec, op))
    }
  }

  return counts
}

function pickPrimarySecurityScheme(spec: OpenApiSpec): string | null {
  const counts = countSecuritySchemeUsage(spec)
  if (counts.size === 0) {
    const schemes = securitySchemesForSpec(spec)
    const names = Object.keys(schemes)
    return names[0] ?? null
  }
  let best: string | null = null
  let bestCount = -1
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name
      bestCount = count
    }
  }
  return best
}

function mapSecurityScheme(
  spec: OpenApiSpec,
  schemeName: string,
): { auth: ConnectorAuth; authMode: ConnectorConfig['authMode'] } | null {
  const rawScheme = securitySchemesForSpec(spec)[schemeName]
  const scheme = isRecord(rawScheme) ? rawScheme : null
  if (!scheme) return null

  const type = typeof scheme.type === 'string' ? scheme.type : ''
  if (type === 'apiKey') {
    const location = typeof scheme.in === 'string' ? scheme.in : 'header'
    const headerName = typeof scheme.name === 'string' ? scheme.name : 'X-API-Key'
    if (location !== 'header') return null
    return {
      auth: { type: 'api_key_header', headerName },
      authMode: 'service',
    }
  }

  if (type === 'http') {
    const httpScheme = typeof scheme.scheme === 'string' ? scheme.scheme.toLowerCase() : ''
    if (httpScheme === 'bearer') {
      return { auth: { type: 'bearer_token' }, authMode: 'service' }
    }
    if (httpScheme === 'basic') {
      return { auth: { type: 'basic' }, authMode: 'service' }
    }
    return null
  }

  if (type === 'oauth2') {
    const flows = isRecord(scheme.flows) ? scheme.flows : {}
    const auth: ConnectorAuth = { type: 'oauth2' }
    let authMode: ConnectorConfig['authMode'] = 'service'

    const authorizationCode = isRecord(flows.authorizationCode)
      ? flows.authorizationCode
      : scheme.flow === 'accessCode'
        ? scheme
        : null
    const clientCredentials = isRecord(flows.clientCredentials) ? flows.clientCredentials : null
    const password = isRecord(flows.password) ? flows.password : null
    const implicit = isRecord(flows.implicit) ? flows.implicit : null

    const chosen =
      authorizationCode ?? clientCredentials ?? password ?? implicit ?? (spec.swagger === '2.0' ? scheme : null)

    if (isRecord(chosen)) {
      if (typeof chosen.authorizationUrl === 'string') auth.authUrl = chosen.authorizationUrl
      if (typeof chosen.tokenUrl === 'string') auth.tokenUrl = chosen.tokenUrl
      if (Array.isArray(chosen.scopes)) {
        auth.scope = chosen.scopes.join(' ')
      } else if (isRecord(chosen.scopes)) {
        auth.scope = Object.keys(chosen.scopes).join(' ')
      }
      if (authorizationCode || implicit) authMode = 'user_delegated'
    }

    return { auth, authMode }
  }

  return null
}

function collectScopes(spec: OpenApiSpec): string[] {
  const scopes = new Set<string>()
  const addFromReqs = (reqs: SecurityRequirement[]) => {
    for (const req of reqs) {
      for (const scopeList of Object.values(req)) {
        if (!Array.isArray(scopeList)) continue
        for (const scope of scopeList) {
          if (typeof scope === 'string' && scope.trim()) scopes.add(scope.trim())
        }
      }
    }
  }

  if (Array.isArray(spec.security)) addFromReqs(spec.security as SecurityRequirement[])

  for (const pathItem of Object.values(pathsForSpec(spec))) {
    if (!isRecord(pathItem)) continue
    for (const method of HTTP_METHODS) {
      const op = pathItem[method]
      if (!isRecord(op)) continue
      addFromReqs(collectSecurityRequirements(spec, op))
    }
  }

  return [...scopes].sort((a, b) => a.localeCompare(b))
}

function sanitizeToolName(raw: string): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned || 'operation'
}

function toolNameForOperation(method: string, path: string, operation: Record<string, unknown>): string {
  if (typeof operation.operationId === 'string' && operation.operationId.trim()) {
    return sanitizeToolName(operation.operationId.trim())
  }
  const pathPart = path
    .replace(/^\//, '')
    .replace(/\{([^}]+)\}/g, 'by_$1')
    .replace(/[^a-zA-Z0-9/]+/g, '_')
    .replace(/\//g, '_')
  return sanitizeToolName(`${method.toLowerCase()}_${pathPart}`)
}

function descriptionForOperation(operation: Record<string, unknown>): string | undefined {
  const summary = typeof operation.summary === 'string' ? operation.summary.trim() : ''
  const description = typeof operation.description === 'string' ? operation.description.trim() : ''
  const text = summary || description
  if (!text) return undefined
  return text.length > 500 ? `${text.slice(0, 497)}...` : text
}

/**
 * A futásidejű http-api-kliens ezt a fejléc-nevet injektálja idempotens endpointra
 * (http-api-client.ts). A detektálás ehhez igazodik: csak azt jelöljük `idempotent`-nek,
 * amit a runtime ténylegesen ki tud szolgálni.
 */
const IDEMPOTENCY_HEADER = 'idempotency-key'

/** Feloldja a `$ref`-et, ha a paraméter-bejegyzés hivatkozás (OpenAPI 3 + Swagger 2.0). */
function resolveMaybeRef(spec: OpenApiSpec, value: unknown): unknown {
  if (isRecord(value) && typeof value.$ref === 'string') {
    return resolveLocalRef(spec, value.$ref)
  }
  return value
}

/**
 * Igaz, ha az operation (a path-szintű paraméterekkel együtt) KÖTELEZŐ `Idempotency-Key`
 * header-paramétert deklarál. Ez az a jel, amit a determinisztikus kinyerés eddig
 * figyelmen kívül hagyott: a `parameters` tömböt egyáltalán nem nézte, így a spec-ben
 * explicit írási-fejléc követelmény sosem jutott el a confighoz.
 */
function operationRequiresIdempotencyKey(
  spec: OpenApiSpec,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
): boolean {
  // A path-szintű paraméterek minden operationre érvényesek; az operation-szintűek
  // felülírhatják, de az idempotencia-fejléc szempontjából elég, ha bármelyik előírja.
  const groups = [pathItem.parameters, operation.parameters]
  for (const group of groups) {
    if (!Array.isArray(group)) continue
    for (const rawParam of group) {
      const param = resolveMaybeRef(spec, rawParam)
      if (!isRecord(param)) continue
      if (param.in !== 'header') continue
      if (typeof param.name !== 'string') continue
      if (param.name.toLowerCase() !== IDEMPOTENCY_HEADER) continue
      if (param.required === true) return true
    }
  }
  return false
}

function schemaSignature(spec: OpenApiSpec, schema: unknown, seen = new Set<string>()): string {
  const resolved = isRecord(schema) ? schema : {}
  if (typeof resolved.$ref === 'string') {
    if (seen.has(resolved.$ref)) return `ref:${resolved.$ref}`
    const target = resolveLocalRef(spec, resolved.$ref)
    return target
      ? `ref:${resolved.$ref}<${schemaSignature(spec, target, new Set([...seen, resolved.$ref]))}>`
      : `ref:${resolved.$ref}`
  }
  const variants = ['oneOf', 'anyOf', 'allOf'].find((key) => Array.isArray(resolved[key]))
  if (variants) {
    return `${variants}<${(resolved[variants] as unknown[]).map((item) => schemaSignature(spec, item, seen)).sort().join('|')}>`
  }
  const type = typeof resolved.type === 'string' ? resolved.type : 'unknown'
  const format = typeof resolved.format === 'string' ? `:${resolved.format}` : ''
  if (type === 'array') return `array<${schemaSignature(spec, resolved.items, seen)}>${format}`
  if (type === 'object' || isRecord(resolved.properties)) {
    const required = new Set(Array.isArray(resolved.required) ? resolved.required.filter((item): item is string => typeof item === 'string') : [])
    const properties = isRecord(resolved.properties) ? resolved.properties : {}
    const fields = Object.entries(properties)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name}${required.has(name) ? '!' : '?'}:${schemaSignature(spec, value, seen)}`)
    return `object{${fields.join(',')}}`
  }
  if (Array.isArray(resolved.enum)) return `${type}${format}:enum<${resolved.enum.map(String).sort().join('|')}>`
  return `${type}${format}`
}

function operationParameters(
  spec: OpenApiSpec,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
  method: HttpMethod,
): NonNullable<ProposedTool['parameters']> {
  const byKey = new Map<string, NonNullable<ProposedTool['parameters']>[number]>()
  for (const group of [pathItem.parameters, operation.parameters]) {
    if (!Array.isArray(group)) continue
    for (const raw of group) {
      const param = resolveMaybeRef(spec, raw)
      if (!isRecord(param) || typeof param.name !== 'string' || typeof param.in !== 'string') continue
      if (!['path', 'query', 'header', 'cookie', 'body'].includes(param.in)) continue
      // Írásnál a runtime injektálja; read műveletnél a hívónak kell megadnia.
      if (
        param.in === 'header'
        && WRITE_METHODS.has(method)
        && param.name.toLowerCase() === IDEMPOTENCY_HEADER
      ) continue
      const schema = isRecord(param.schema) ? param.schema : param
      const item = {
        name: param.name,
        in: param.in as 'path' | 'query' | 'header' | 'cookie' | 'body',
        required: param.in === 'path' || param.required === true,
        type: schemaSignature(spec, schema),
      }
      byKey.set(`${item.in}:${item.name.toLowerCase()}`, item)
    }
  }

  // OpenAPI 3 requestBody ugyanúgy a capability szerződésének része.
  const rawBody = resolveMaybeRef(spec, operation.requestBody)
  if (isRecord(rawBody) && isRecord(rawBody.content)) {
    for (const [mediaType, media] of Object.entries(rawBody.content)) {
      const mediaRecord = resolveMaybeRef(spec, media)
      if (!isRecord(mediaRecord)) continue
      const item = {
        name: mediaType,
        in: 'body' as const,
        required: rawBody.required === true,
        type: schemaSignature(spec, resolveMaybeRef(spec, mediaRecord.schema)),
      }
      byKey.set(`body:${mediaType.toLowerCase()}`, item)
    }
  }
  return [...byKey.values()].sort((a, b) => `${a.in}:${a.name}`.localeCompare(`${b.in}:${b.name}`))
}

function extractProposedTools(spec: OpenApiSpec): ProposedTool[] {
  const tools: ProposedTool[] = []
  const seen = new Set<string>()

  for (const [pathTemplate, pathItem] of Object.entries(pathsForSpec(spec))) {
    if (!isRecord(pathItem)) continue
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method]
      if (!isRecord(operation)) continue
      const httpMethod = method.toUpperCase() as HttpMethod
      let name = toolNameForOperation(method, pathTemplate, operation)
      const dedupeKey = `${httpMethod} ${pathTemplate}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)

      const usedNames = new Set(tools.map((t) => t.name))
      if (usedNames.has(name)) {
        name = `${name}_${httpMethod.toLowerCase()}`
        let i = 2
        while (usedNames.has(name)) {
          name = `${sanitizeToolName(toolNameForOperation(method, pathTemplate, operation))}_${i}`
          i++
        }
      }

      // Idempotencia csak mutáló metóduson értelmezett (a runtime is csak ott injektál).
      const idempotent =
        WRITE_METHODS.has(httpMethod) && operationRequiresIdempotencyKey(spec, pathItem, operation)
      const parameters = operationParameters(spec, pathItem, operation, httpMethod)
      // Olvasó POST (report/query): az OpenAPI `x-action-class` / `x-write: false`
      // extensionje → risk. Az `access` metódus-alapú marad (normalize write-ra
      // kényszeríti a POST-ot); a következmény-kapu a `risk` mezőt nézi.
      const risk = riskFromOpenApiOperation(operation)

      tools.push({
        name,
        method: httpMethod,
        path: pathTemplate,
        access: WRITE_METHODS.has(httpMethod) ? 'write' : 'read',
        ...(risk ? { risk } : {}),
        ...(descriptionForOperation(operation) ? { description: descriptionForOperation(operation) } : {}),
        ...(idempotent ? { idempotent: true } : {}),
        ...(parameters.length ? { parameters } : {}),
      })
    }
  }

  return tools
}

/**
 * CRM / partner OpenAPI extensionök → következmény-kapu `risk`.
 * Elfogadott jelek (ebben a sorrendben):
 * - `x-action-class`: "read" | "write" | "danger"
 * - `x-write: false` → read (olvasó POST/PUT/PATCH jelölés)
 */
export function riskFromOpenApiOperation(
  operation: Record<string, unknown>,
): 'read' | 'write' | 'danger' | undefined {
  const actionClass = operation['x-action-class']
  if (typeof actionClass === 'string') {
    const normalized = actionClass.trim().toLowerCase()
    if (normalized === 'read' || normalized === 'write' || normalized === 'danger') {
      return normalized
    }
  }
  if (operation['x-write'] === false) return 'read'
  return undefined
}

function providerFromSpec(spec: OpenApiSpec, providerHint?: string): string {
  const hint = providerHint?.trim()
  if (hint) return slugifyProvider(hint)
  const info = isRecord(spec.info) ? spec.info : {}
  const title = typeof info.title === 'string' ? info.title.trim() : ''
  if (title) return slugifyProvider(title)
  return 'api'
}

export function extractConnectorConfigFromOpenApiSpec(
  spec: OpenApiSpec,
  providerHint?: string,
): OpenApiExtractResult {
  normalizeYamlOpenApiDocument(spec)
  const serverUrls = resolveServerUrls(spec)
  const baseUrlRaw = serverUrls[0]
  if (!baseUrlRaw) {
    return { ok: false, reason: 'unsupported', detail: 'missing servers' }
  }

  const baseUrl = normalizeBaseUrl(baseUrlRaw)
  const baseHost = hostFromUrl(baseUrl)
  if (!baseHost) {
    return { ok: false, reason: 'unsupported', detail: 'invalid baseUrl' }
  }

  const egressHosts = [
    ...new Set(
      serverUrls.map((url) => hostFromUrl(url)).filter((host): host is string => Boolean(host)),
    ),
  ]
  if (egressHosts.length === 0) egressHosts.push(baseHost)

  const schemeName = pickPrimarySecurityScheme(spec)
  if (!schemeName) {
    return { ok: false, reason: 'unsupported', detail: 'missing securitySchemes' }
  }

  const authMapping = mapSecurityScheme(spec, schemeName)
  if (!authMapping) {
    return { ok: false, reason: 'unsupported', detail: `unsupported security scheme: ${schemeName}` }
  }

  const provider = providerFromSpec(spec, providerHint)
  const auth: ConnectorAuth = {
    ...authMapping.auth,
    secretAliasSuggested:
      authMapping.auth.type === 'oauth2'
        ? authMapping.auth.secretAliasSuggested
        : authMapping.auth.secretAliasSuggested ?? secretAliasForProvider(provider),
  }

  const rawConfig = {
    provider,
    baseUrl,
    egressHosts,
    authMode: authMapping.authMode,
    auth,
    scopesSuggested: collectScopes(spec),
    proposedTools: extractProposedTools(spec),
  }

  try {
    return { ok: true, config: normalizeConnectorConfig(rawConfig) }
  } catch (e) {
    if (e instanceof ConnectorConfigParseError) {
      return { ok: false, reason: 'invalid_config', detail: 'schema mismatch' }
    }
    throw e
  }
}

export function tryExtractConnectorConfigFromOpenApi(
  docText: string,
  providerHint?: string,
): OpenApiExtractResult {
  const spec = parseOpenApiDocumentSync(docText)
  if (!spec) return { ok: false, reason: 'not_openapi' }
  return extractConnectorConfigFromOpenApiSpec(spec, providerHint)
}

export async function tryExtractConnectorConfigFromOpenApiAsync(
  docText: string,
  providerHint?: string,
): Promise<OpenApiExtractResult> {
  const spec = (await parseOpenApiDocument(docText)) ?? parseOpenApiDocumentSync(docText)
  if (!spec) return { ok: false, reason: 'not_openapi' }
  return extractConnectorConfigFromOpenApiSpec(spec, providerHint)
}
