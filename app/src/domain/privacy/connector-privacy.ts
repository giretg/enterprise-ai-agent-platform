/**
 * Connector privacy metadata + capability-deklaráció (APG-03, spec §7 / §11, issue #320).
 *
 * A mezőséma a connector `config` / `ConnectorSpecVersion.capabilitySet` része.
 * `privacy: tokenize` csak string mezőre érvényes (R6). Az entitástípus-névtér
 * forrás-definiált; a platform csak a `reversible` invariánst kényszeríti ki.
 */
import { z } from 'zod'
import {
  DEFAULT_SURROGATE_ENTITY_TYPES,
  ENTITY_TYPE_SLUG_RE,
  isEntityTypeSlug,
} from '@/domain/privacy/surrogate-format'

export const PRIVACY_FIELD_ACTIONS = ['tokenize', 'pass', 'block'] as const
export type PrivacyFieldAction = (typeof PRIVACY_FIELD_ACTIONS)[number]

export const PRIVACY_UNLISTED_DEFAULTS = ['pass', 'block'] as const
export type PrivacyUnlistedDefault = (typeof PRIVACY_UNLISTED_DEFAULTS)[number]

/** Mezőérték-típus a tokenize-szabályhoz. Numerikus/dátum soha nem tokenize (R6). */
export const PRIVACY_FIELD_VALUE_TYPES = [
  'string',
  'number',
  'integer',
  'boolean',
  'date',
  'datetime',
] as const
export type PrivacyFieldValueType = (typeof PRIVACY_FIELD_VALUE_TYPES)[number]

export const PRIVACY_CAPABILITY_KEYS = [
  'structured_field_privacy',
  'stable_entity_ids',
  'entity_resolution',
  'free_text_hints',
] as const
export type PrivacyCapabilityKey = (typeof PRIVACY_CAPABILITY_KEYS)[number]

export const TOKENIZE_STRING_ONLY_MESSAGE =
  'A tokenize adatvédelem csak szöveges (string) mezőre alkalmazható; numerikus és dátum mezőn tilos.'

export const TOKENIZE_ENTITY_TYPE_MESSAGE =
  'A tokenize mezőhöz entitástípus kell (forrás-definiált slug, pl. company vagy ingatlan).'

export const TOKENIZE_IRREVERSIBLE_MESSAGE =
  'A tokenize adatvédelem csak visszafordítható (reversible: true) entitástípusra alkalmazható.'

export const TOKENIZE_SOURCE_ID_REFERENCE_MESSAGE =
  'A source_id sablon csak a payload-sémában deklarált mezőre hivatkozhat.'

const SOURCE_ID_PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g

const entityTypeSlugSchema = z
  .string()
  .regex(ENTITY_TYPE_SLUG_RE, 'Az entitástípus slug csak kisbetű, szám és aláhúzás lehet (max. 32 karakter).')

export const privacyEntityTypeDeclarationSchema = z.object({
  label: z.string().min(1),
  reversible: z.boolean(),
})
export type PrivacyEntityTypeDeclaration = z.infer<typeof privacyEntityTypeDeclarationSchema>

export const DEFAULT_ENTITY_TYPE_DECLARATIONS: Record<string, PrivacyEntityTypeDeclaration> =
  Object.fromEntries(
    (
      [
        ['company', { label: 'Cég', reversible: true }],
        ['person', { label: 'Személy', reversible: true }],
        ['email', { label: 'E-mail', reversible: true }],
        ['phone', { label: 'Telefon', reversible: true }],
        ['account', { label: 'Számla', reversible: true }],
      ] as const
    ).filter(([key]) => (DEFAULT_SURROGATE_ENTITY_TYPES as readonly string[]).includes(key)),
  )

export const privacyEntityTypesSchema = z.record(entityTypeSlugSchema, privacyEntityTypeDeclarationSchema)

export const privacyCapabilityDeclarationSchema = z.object({
  structured_field_privacy: z.boolean(),
  stable_entity_ids: z.boolean(),
  entity_resolution: z.boolean(),
  free_text_hints: z.boolean(),
})
export type PrivacyCapabilityDeclaration = z.infer<typeof privacyCapabilityDeclarationSchema>

const connectorFieldPrivacyObjectSchema = z.object({
  type: z.enum(PRIVACY_FIELD_VALUE_TYPES).optional(),
  privacy: z.enum(PRIVACY_FIELD_ACTIONS).default('pass'),
  entity_type: entityTypeSlugSchema.optional(),
  source_id: z.string().min(1).optional(),
})

function validateFieldAgainstEntityTypes(
  field: z.infer<typeof connectorFieldPrivacyObjectSchema>,
  entityTypes: Record<string, PrivacyEntityTypeDeclaration> | undefined,
  ctx: z.RefinementCtx,
  pathPrefix: (string | number)[],
): void {
  if (field.privacy !== 'tokenize') return
  if (field.type !== 'string') {
    ctx.addIssue({
      code: 'custom',
      path: [...pathPrefix, 'privacy'],
      message: TOKENIZE_STRING_ONLY_MESSAGE,
    })
  }
  if (!field.entity_type) {
    ctx.addIssue({
      code: 'custom',
      path: [...pathPrefix, 'entity_type'],
      message: TOKENIZE_ENTITY_TYPE_MESSAGE,
    })
    return
  }
  const declaration = entityTypes?.[field.entity_type]
  if (declaration && declaration.reversible === false) {
    ctx.addIssue({
      code: 'custom',
      path: [...pathPrefix, 'entity_type'],
      message: TOKENIZE_IRREVERSIBLE_MESSAGE,
    })
  }
}

export const connectorFieldPrivacySchema = connectorFieldPrivacyObjectSchema
export type ConnectorFieldPrivacy = z.infer<typeof connectorFieldPrivacySchema>

/**
 * `reversible: false` + `privacy: tokenize` → tilos (forrás-szerződés §5.4).
 * Külön exportálva, mert a connector-config séma a mezőket a névtér ISMERETE
 * NÉLKÜL parse-olja (a `fields` és az `entity_types` testvérkulcsok), a névtér
 * elleni ellenőrzés csak a teljes config szintjén futtatható.
 */
export function refineTokenizeReversibility(
  fields: Record<string, ConnectorFieldPrivacy>,
  entityTypes: Record<string, PrivacyEntityTypeDeclaration>,
  ctx: z.RefinementCtx,
  pathPrefix: (string | number)[] = [],
): void {
  for (const [fieldName, field] of Object.entries(fields)) {
    if (field.privacy !== 'tokenize' || !field.entity_type) continue
    if (entityTypes[field.entity_type]?.reversible === false) {
      ctx.addIssue({
        code: 'custom',
        path: [...pathPrefix, fieldName, 'entity_type'],
        message: TOKENIZE_IRREVERSIBLE_MESSAGE,
      })
    }
  }
}

export function buildConnectorFieldsPrivacySchema(
  entityTypes?: Record<string, PrivacyEntityTypeDeclaration>,
) {
  return z
    .record(z.string().min(1), connectorFieldPrivacyObjectSchema)
    .superRefine((fields, ctx) => {
      const fieldNames = new Set(Object.keys(fields))
      for (const [fieldName, field] of Object.entries(fields)) {
        validateFieldAgainstEntityTypes(field, entityTypes, ctx, [fieldName])
        if (field.privacy !== 'tokenize' || !field.source_id) continue
        for (const match of field.source_id.matchAll(SOURCE_ID_PLACEHOLDER)) {
          const referenced = match[1]
          if (referenced && !fieldNames.has(referenced)) {
            ctx.addIssue({
              code: 'custom',
              path: [fieldName, 'source_id'],
              message: `${TOKENIZE_SOURCE_ID_REFERENCE_MESSAGE} Hiányzó mező: ${referenced}.`,
            })
          }
        }
      }
    })
}

export const connectorFieldsPrivacySchema = buildConnectorFieldsPrivacySchema()
export type ConnectorFieldsPrivacy = z.infer<typeof connectorFieldsPrivacySchema>

/** Katalógus v2 — a forrás teljes privacy-nyilatkozata (issue #320 D4). */
export const privacyCatalogV2Schema = z
  .object({
    catalog_version: z.number().int().positive(),
    system: z.string().min(1).optional(),
    entity_types: privacyEntityTypesSchema.optional(),
    unlisted_default: z.enum(PRIVACY_UNLISTED_DEFAULTS).optional(),
    privacy: privacyCapabilityDeclarationSchema.optional(),
    fields: z.record(z.string().min(1), connectorFieldPrivacyObjectSchema),
  })
  .superRefine((catalog, ctx) => {
    const entityTypes = {
      ...DEFAULT_ENTITY_TYPE_DECLARATIONS,
      ...catalog.entity_types,
    }
    for (const [fieldName, field] of Object.entries(catalog.fields)) {
      validateFieldAgainstEntityTypes(field, entityTypes, ctx, ['fields', fieldName])
    }
  })

export type PrivacyCatalogV2 = z.infer<typeof privacyCatalogV2Schema>

export type PrivacyCatalogReviewWarning = {
  field: string
  reason: string
}

const SECRET_HEURISTICS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /-----BEGIN/i, reason: 'PEM/titok blokk minta' },
  { pattern: /^sk-[A-Za-z0-9]{8,}/, reason: 'API-kulcs minta (sk-…)' },
  { pattern: /^[A-Za-z0-9+/=]{40,}$/, reason: 'magas entrópia / base64-szerű érték' },
]

/**
 * D5 — `pass`-ra jelölt string mezők MINTAÉRTÉKEIN futó titok-heurisztika
 * (nem szűr, nem blokkol, csak figyelmeztet az adminnak).
 *
 * Minta nélkül nincs mit vizsgálni: a katalógus csak típust és akciót közöl,
 * értéket nem. A hívó ezért a forrás valódi válaszrekordjait adja át.
 */
export function reviewPrivacyCatalogDeclarations(
  catalog: Pick<PrivacyCatalogV2, 'fields' | 'entity_types'>,
  samples: ReadonlyArray<Record<string, unknown>> = [],
): PrivacyCatalogReviewWarning[] {
  const warnings: PrivacyCatalogReviewWarning[] = []
  for (const [fieldName, field] of Object.entries(catalog.fields)) {
    if (field.privacy !== 'pass' || field.type !== 'string') continue
    const values = samples
      .map((sample) => sample[fieldName])
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    const hit = SECRET_HEURISTICS.find((heuristic) =>
      values.some((value) => heuristic.pattern.test(value.trim())),
    )
    if (hit) warnings.push({ field: fieldName, reason: hit.reason })
  }
  return warnings
}

export function parsePrivacyCatalogV2(raw: unknown): PrivacyCatalogV2 | null {
  const parsed = privacyCatalogV2Schema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export type ConnectorPrivacyConfigPatch = {
  catalog_version: number
  privacy?: PrivacyCapabilityDeclaration
  entity_types?: Record<string, PrivacyEntityTypeDeclaration>
  unlisted_default?: PrivacyUnlistedDefault
  fields: ConnectorFieldsPrivacy
}

/**
 * Forrás-katalógus (`GET /privacy/catalog`) → connector-config privacy szelet.
 * A platform nem talál ki mezőjelölést: amit a forrás nem deklarál, az nincs.
 */
export function privacyCatalogToConnectorConfigPatch(
  catalog: PrivacyCatalogV2,
): ConnectorPrivacyConfigPatch {
  return {
    catalog_version: catalog.catalog_version,
    ...(catalog.privacy ? { privacy: catalog.privacy } : {}),
    ...(catalog.entity_types ? { entity_types: catalog.entity_types } : {}),
    ...(catalog.unlisted_default ? { unlisted_default: catalog.unlisted_default } : {}),
    fields: catalog.fields,
  }
}

export function readConnectorEntityTypes(config: unknown): Record<string, PrivacyEntityTypeDeclaration> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { ...DEFAULT_ENTITY_TYPE_DECLARATIONS }
  }
  const entityTypes = (config as Record<string, unknown>).entity_types
  const parsed = privacyEntityTypesSchema.safeParse(entityTypes)
  if (!parsed.success) return { ...DEFAULT_ENTITY_TYPE_DECLARATIONS }
  return { ...DEFAULT_ENTITY_TYPE_DECLARATIONS, ...parsed.data }
}

export function readConnectorUnlistedDefault(config: unknown): PrivacyUnlistedDefault {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'pass'
  const value = (config as Record<string, unknown>).unlisted_default
  return value === 'block' ? 'block' : 'pass'
}

/** M1 referencia: saját CRM + `company` entitástípus — katalógus-import cél, enrich fallback. */
export const OSTOROSBOR_CRM_TEMPLATE_KEYS = new Set([
  'ostorosbor-crm-sales-delegated',
  'ostorosbor-crm-service-insight',
])

export const OSTOROSBOR_CRM_PRIVACY_CATALOG: PrivacyCatalogV2 = {
  catalog_version: 1,
  system: 'crm',
  entity_types: { company: { label: 'Cég', reversible: true } },
  unlisted_default: 'pass',
  privacy: {
    structured_field_privacy: true,
    stable_entity_ids: true,
    entity_resolution: false,
    free_text_hints: false,
  },
  fields: {
    id: { type: 'integer', privacy: 'pass' },
    company_name: {
      type: 'string',
      privacy: 'tokenize',
      entity_type: 'company',
      source_id: 'crm/company/{id}',
    },
    name: {
      type: 'string',
      privacy: 'tokenize',
      entity_type: 'company',
      source_id: 'crm/company/{id}',
    },
    revenue: { type: 'number', privacy: 'pass' },
  },
}

export const OSTOROSBOR_CRM_PRIVACY_CAPABILITIES: PrivacyCapabilityDeclaration =
  OSTOROSBOR_CRM_PRIVACY_CATALOG.privacy!

export const OSTOROSBOR_CRM_PRIVACY_FIELDS: ConnectorFieldsPrivacy =
  OSTOROSBOR_CRM_PRIVACY_CATALOG.fields

export type PrivacyCapabilityLevel = 'full' | 'partial' | 'none'

export function privacyCapabilityLevel(
  declaration: PrivacyCapabilityDeclaration | null | undefined,
): PrivacyCapabilityLevel {
  if (!declaration) return 'none'
  const enabled = PRIVACY_CAPABILITY_KEYS.filter((key) => declaration[key])
  if (enabled.length === 0) return 'none'
  if (declaration.structured_field_privacy && declaration.stable_entity_ids) return 'full'
  return 'partial'
}

export function canonicalizePrivacyDeclaration(
  declaration: PrivacyCapabilityDeclaration | null | undefined,
): PrivacyCapabilityDeclaration | null {
  if (!declaration) return null
  return {
    structured_field_privacy: declaration.structured_field_privacy,
    stable_entity_ids: declaration.stable_entity_ids,
    entity_resolution: declaration.entity_resolution,
    free_text_hints: declaration.free_text_hints,
  }
}

export function privacyDeclarationsEqual(
  left: PrivacyCapabilityDeclaration | null | undefined,
  right: PrivacyCapabilityDeclaration | null | undefined,
): boolean {
  return JSON.stringify(canonicalizePrivacyDeclaration(left)) === JSON.stringify(canonicalizePrivacyDeclaration(right))
}

export function readConnectorPrivacyFields(config: unknown): ConnectorFieldsPrivacy | null {
  const inspected = inspectConnectorPrivacyFields(config)
  return inspected.status === 'valid' ? inspected.fields : null
}

export type ConnectorPrivacyFieldsInspection =
  | { status: 'absent' }
  | { status: 'valid'; fields: ConnectorFieldsPrivacy }
  | { status: 'invalid'; reason: string }

export function inspectConnectorPrivacyFields(config: unknown): ConnectorPrivacyFieldsInspection {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { status: 'absent' }
  const fields = (config as Record<string, unknown>).fields
  if (fields === undefined) return { status: 'absent' }
  const entityTypes = readConnectorEntityTypes(config)
  const parsed = buildConnectorFieldsPrivacySchema(entityTypes).safeParse(fields)
  if (parsed.success) return { status: 'valid', fields: parsed.data }
  return {
    status: 'invalid',
    reason: parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(gyökér)'}: ${issue.message}`)
      .join('; '),
  }
}

export function connectorHasPrivacyMetadata(config: unknown): boolean {
  const fields = readConnectorPrivacyFields(config)
  if (fields && Object.values(fields).some((field) => field.privacy === 'tokenize')) return true
  return privacyCapabilityLevel(readPrivacyDeclaration(config)) !== 'none'
}

export function connectorSupportsEntityResolution(config: unknown): boolean {
  return readPrivacyDeclaration(config)?.entity_resolution === true
}

export const DEFAULT_PRIVACY_CATALOG_PATH = '/privacy/catalog'

/** A forrás katalógus-végpontja. Felülírható a `privacy.catalog_path` kulccsal. */
export function readPrivacyCatalogPath(config: unknown): string {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return DEFAULT_PRIVACY_CATALOG_PATH
  }
  const privacy = (config as Record<string, unknown>).privacy
  if (privacy && typeof privacy === 'object' && !Array.isArray(privacy)) {
    const path = (privacy as Record<string, unknown>).catalog_path
    if (typeof path === 'string' && path.trim().startsWith('/')) return path.trim()
  }
  return DEFAULT_PRIVACY_CATALOG_PATH
}

export function readEntityResolvePath(config: unknown): string {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return '/privacy/resolve'
  const privacy = (config as Record<string, unknown>).privacy
  if (privacy && typeof privacy === 'object' && !Array.isArray(privacy)) {
    const path = (privacy as Record<string, unknown>).resolve_path
    if (typeof path === 'string' && path.trim().startsWith('/')) return path.trim()
  }
  return '/privacy/resolve'
}

export function readPrivacyDeclaration(raw: unknown): PrivacyCapabilityDeclaration | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const cfg = raw as Record<string, unknown>
  const parsed = privacyCapabilityDeclarationSchema.safeParse(cfg.privacy)
  if (parsed.success) return parsed.data
  const provenance = cfg.provenance && typeof cfg.provenance === 'object' && !Array.isArray(cfg.provenance)
    ? (cfg.provenance as Record<string, unknown>)
    : null
  const key =
    typeof provenance?.templateKey === 'string'
      ? provenance.templateKey
      : typeof cfg.provider === 'string'
        ? cfg.provider
        : ''
  return OSTOROSBOR_CRM_TEMPLATE_KEYS.has(key) ? OSTOROSBOR_CRM_PRIVACY_CAPABILITIES : null
}

/** A configban hivatkozott entitástípus-slugok (mezők + explicit névtér). */
export function collectConnectorEntityTypeSlugs(config: unknown): string[] {
  const slugs = new Set<string>()
  for (const key of Object.keys(readConnectorEntityTypes(config))) {
    if (isEntityTypeSlug(key)) slugs.add(key)
  }
  const fields = readConnectorPrivacyFields(config)
  if (fields) {
    for (const field of Object.values(fields)) {
      if (field.entity_type && isEntityTypeSlug(field.entity_type)) slugs.add(field.entity_type)
    }
  }
  return [...slugs].sort()
}

export function privacyCapabilityAuditMetadata(
  declaration: PrivacyCapabilityDeclaration | null | undefined,
): { privacy_capability: PrivacyCapabilityLevel; privacy: PrivacyCapabilityDeclaration | null } {
  const canonical = canonicalizePrivacyDeclaration(declaration)
  return {
    privacy_capability: privacyCapabilityLevel(canonical),
    privacy: canonical,
  }
}

export function privacyCapabilityAbsentAudit(
  declaration: PrivacyCapabilityDeclaration | null | undefined,
): { action: 'privacy.connector.capability.absent'; metadata: Record<string, unknown> } | null {
  if (privacyCapabilityLevel(declaration) !== 'none') return null
  return {
    action: 'privacy.connector.capability.absent',
    metadata: privacyCapabilityAuditMetadata(null),
  }
}

export function privacyCapabilityChangedAudit(input: {
  previous: PrivacyCapabilityDeclaration | null | undefined
  next: PrivacyCapabilityDeclaration | null | undefined
}): { action: 'privacy.connector.capability.changed'; metadata: Record<string, unknown> } | null {
  if (privacyDeclarationsEqual(input.previous, input.next)) return null
  return {
    action: 'privacy.connector.capability.changed',
    metadata: {
      from: canonicalizePrivacyDeclaration(input.previous),
      to: canonicalizePrivacyDeclaration(input.next),
      ...privacyCapabilityAuditMetadata(input.next),
    },
  }
}

export function privacyCapabilityUi(level: PrivacyCapabilityLevel): {
  label: string
  tone: 'success' | 'warning'
  title: string
} {
  if (level === 'full') {
    return {
      label: 'Adatvédelem beállítva',
      tone: 'success',
      title:
        'A kapcsolat megmondja, mely cégneveket kell álnévre cserélni, mielőtt a modell látná őket.',
    }
  }
  if (level === 'partial') {
    return {
      label: 'Részleges adatvédelem',
      tone: 'warning',
      title:
        'A kapcsolat csak részben jelöli a védendő mezőket, ezért a platform kevesebbet tud álnévre cserélni.',
    }
  }
  return {
    label: 'Korlátozott adatvédelem',
    tone: 'warning',
    title:
      'Ez a kapcsolat nem jelöli a védendő mezőket. Ettől még működik, de a platform kevesebb adatot tud álnévre cserélni.',
  }
}
