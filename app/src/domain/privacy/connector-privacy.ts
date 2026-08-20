/**
 * Connector privacy metadata + capability-deklaráció (APG-03, spec §7 / §11).
 *
 * A mezőséma a connector `config` / `ConnectorSpecVersion.capabilitySet` része.
 * `privacy: tokenize` csak string mezőre érvényes (R6) — numerikus és dátum mezőn
 * a mentés elbukik. A deklaráció hiányozhat: a connector működik, a platform
 * alacsonyabb privacy capability-t jelez.
 */
import { z } from 'zod'
import { SURROGATE_ENTITY_TYPES } from '@/domain/privacy/surrogate-format'

export const PRIVACY_FIELD_ACTIONS = ['tokenize', 'pass', 'block'] as const
export type PrivacyFieldAction = (typeof PRIVACY_FIELD_ACTIONS)[number]

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
  'A tokenize mezőhöz entitástípus kell (company, person, email, phone vagy account).'

export const TOKENIZE_SOURCE_ID_MESSAGE =
  'A tokenize mezőhöz stabil source_id szükséges, hogy a forrásrendszer törlése átvezethető legyen.'

export const TOKENIZE_SOURCE_ID_REFERENCE_MESSAGE =
  'A source_id sablon csak a payload-sémában deklarált mezőre hivatkozhat.'

const SOURCE_ID_PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g

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
  entity_type: z.enum(SURROGATE_ENTITY_TYPES).optional(),
  /** Sablon vagy stabil source ID, pl. `crm/company/{id}` / `crm/company/4821`. */
  source_id: z.string().min(1).optional(),
})

export const connectorFieldPrivacySchema = connectorFieldPrivacyObjectSchema.superRefine((field, ctx) => {
  if (field.privacy !== 'tokenize') return
  if (field.type !== 'string') {
    ctx.addIssue({
      code: 'custom',
      path: ['privacy'],
      message: TOKENIZE_STRING_ONLY_MESSAGE,
    })
  }
  if (!field.entity_type) {
    ctx.addIssue({
      code: 'custom',
      path: ['entity_type'],
      message: TOKENIZE_ENTITY_TYPE_MESSAGE,
    })
  }
  if (!field.source_id) {
    ctx.addIssue({
      code: 'custom',
      path: ['source_id'],
      message: TOKENIZE_SOURCE_ID_MESSAGE,
    })
  }
})
export type ConnectorFieldPrivacy = z.infer<typeof connectorFieldPrivacySchema>

export const connectorFieldsPrivacySchema = z
  .record(z.string().min(1), connectorFieldPrivacySchema)
  .superRefine((fields, ctx) => {
    const fieldNames = new Set(Object.keys(fields))
    for (const [fieldName, field] of Object.entries(fields)) {
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
export type ConnectorFieldsPrivacy = z.infer<typeof connectorFieldsPrivacySchema>

/** M1 referencia: saját CRM + `company` entitástípus (D5). */
export const OSTOROSBOR_CRM_TEMPLATE_KEYS = new Set([
  'ostorosbor-crm-sales-delegated',
  'ostorosbor-crm-service-insight',
])
export const OSTOROSBOR_CRM_PRIVACY_CAPABILITIES: PrivacyCapabilityDeclaration = {
  structured_field_privacy: true,
  stable_entity_ids: true,
  entity_resolution: false,
  free_text_hints: false,
}

export const OSTOROSBOR_CRM_PRIVACY_FIELDS: ConnectorFieldsPrivacy = {
  id: {
    type: 'integer',
    privacy: 'pass',
  },
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
  revenue: {
    type: 'number',
    privacy: 'pass',
  },
}

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

/** Mezőszintű privacy-séma a connector `config.fields`-jéből. Hibás alak → nincs transzformáció. */
export function readConnectorPrivacyFields(config: unknown): ConnectorFieldsPrivacy | null {
  const inspected = inspectConnectorPrivacyFields(config)
  return inspected.status === 'valid' ? inspected.fields : null
}

export type ConnectorPrivacyFieldsInspection =
  | { status: 'absent' }
  | { status: 'valid'; fields: ConnectorFieldsPrivacy }
  | { status: 'invalid'; reason: string }

/** A runtime különbséget tesz hiányzó és hibás deklaráció között: a hibás fail-closed. */
export function inspectConnectorPrivacyFields(config: unknown): ConnectorPrivacyFieldsInspection {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { status: 'absent' }
  const fields = (config as Record<string, unknown>).fields
  if (fields === undefined) return { status: 'absent' }
  const parsed = connectorFieldsPrivacySchema.safeParse(fields)
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

/** APG-17 — a connector deklarálja-e az entity_resolution képességet. */
export function connectorSupportsEntityResolution(config: unknown): boolean {
  return readPrivacyDeclaration(config)?.entity_resolution === true
}

/** APG-17 — a forrásrendszer `POST /privacy/resolve` útvonala (forrás §6.3). */
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

export function privacyCapabilityAuditMetadata(
  declaration: PrivacyCapabilityDeclaration | null | undefined,
): { privacy_capability: PrivacyCapabilityLevel; privacy: PrivacyCapabilityDeclaration | null } {
  const canonical = canonicalizePrivacyDeclaration(declaration)
  return {
    privacy_capability: privacyCapabilityLevel(canonical),
    privacy: canonical,
  }
}

/** Aktiváláskor: hiányzó privacy-interfész külön, kereshető audit-esemény. */
export function privacyCapabilityAbsentAudit(
  declaration: PrivacyCapabilityDeclaration | null | undefined,
): { action: 'privacy.connector.capability.absent'; metadata: Record<string, unknown> } | null {
  if (privacyCapabilityLevel(declaration) !== 'none') return null
  return {
    action: 'privacy.connector.capability.absent',
    metadata: privacyCapabilityAuditMetadata(null),
  }
}

/** Mentéskor: a deklaráció változása auditált (verziózott capabilitySet / config). */
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
