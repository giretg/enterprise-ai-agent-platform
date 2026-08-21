/**
 * Kategória-policy (APG-11, spec §2, R1).
 *
 * Minden entitás-/mintakategóriára egy akció: `allow | tokenize | local_only | block`.
 * Feloldás: platform → tenant → agent overlay (a későbbi szint a megadott kulcsokon
 * győz). A régi `agents.allow_sensitive_external_model` mező deprecated: ha az
 * agentnek nincs saját overlay-je, a kapcsoló a mai viselkedést képezi le
 * (`allow` a sensitive + a mai forbidden kategóriákon), hogy a már felmentett
 * agentek runtime-ja ne változzon.
 *
 * Tárolás (spec §21 döntés): `PlatformSetting` kulcsok, az APG-09 üzemmód-hierarchia
 * mintájára — a dokumentum kicsi JSON-map, a mintakészlet verziója a platform-
 * dokumentumban él és auditált. Dedikált tábla akkor kellene, ha relációs lekérdezés
 * vagy per-kategória sor kellene; egyik sem.
 *
 * Kemény invariánsok mentéskor:
 * - `secret_key` csak `block` (sosem `tokenize`, sem más)
 * - `pan` / `iban` `allow` csak superadmin + külön megerősítés
 */
import { SURROGATE_ENTITY_TYPES } from '@/domain/privacy/surrogate-format'

export const PRIVACY_CATEGORY_ACTIONS = ['allow', 'tokenize', 'local_only', 'block'] as const
export type PrivacyCategoryAction = (typeof PRIVACY_CATEGORY_ACTIONS)[number]

/**
 * Beépített kategóriák: surrogate-névtér + a sensitivity-router mintái.
 * A tenant-egyedi minták a `custom` mapben élnek, nem itt.
 */
export const PRIVACY_POLICY_CATEGORIES = [
  'company',
  'person',
  'email',
  'phone',
  'account',
  'taj',
  'adoszam',
  'pan',
  'iban',
  'secret_key',
] as const
export type PrivacyPolicyCategory = (typeof PRIVACY_POLICY_CATEGORIES)[number]

/** Osztályozó-alias: a `card_broad` a `pan` policyjét örökli. */
export const PRIVACY_CATEGORY_ALIASES: Record<string, PrivacyPolicyCategory> = {
  card_broad: 'pan',
}

/**
 * Platform-alapértelmezés = a mai classifier viselkedése, plusz a még nem
 * osztályozott surrogate-kategóriák `tokenize` (APG-12 transzformációja).
 *
 * sensitive → local_only; forbidden → block; company/person/phone/account
 * ma `clean` (kimennek), a policy mégis tokenize-t ír elő a jövőbeli transzformnak
 * — a sensitivity-router ezeket ma nem látja, ezért a runtime nem szigorodik.
 */
export const DEFAULT_PRIVACY_CATEGORY_POLICY: Record<PrivacyPolicyCategory, PrivacyCategoryAction> = {
  company: 'tokenize',
  person: 'tokenize',
  email: 'local_only',
  phone: 'tokenize',
  account: 'tokenize',
  taj: 'local_only',
  adoszam: 'local_only',
  pan: 'block',
  iban: 'block',
  secret_key: 'block',
}

/**
 * A mai mindent-vagy-semmit kapcsoló leképezése. A UI és a gateway a kapcsolót
 * minden sensitivity szintre (köztük PAN/IBAN/secret_key) alkalmazta — a
 * migráció ezt a viselkedést őrzi, amíg az agentnek nincs explicit overlay-je.
 */
export const LEGACY_SENSITIVE_EXTERNAL_CATEGORIES: readonly PrivacyPolicyCategory[] = [
  'company',
  'person',
  'email',
  'phone',
  'account',
  'taj',
  'adoszam',
  'pan',
  'iban',
  'secret_key',
]

/**
 * Álnévre csak az a kategória cserélhető, aminek van surrogate-típusa (spec §11).
 * A TAJ / adószám / kártyaszám / IBAN / titok nincs a névtérben: rájuk a `tokenize`
 * korábban némán hatástalan volt — az admin „Álnévre cseréljük"-öt választott, a
 * futásidő pedig ugyanúgy helyi modellre terelt. Mentéskor ezért hibát adunk.
 */
export const TOKENIZABLE_PRIVACY_CATEGORIES: readonly PrivacyPolicyCategory[] =
  PRIVACY_POLICY_CATEGORIES.filter((category) =>
    (SURROGATE_ENTITY_TYPES as readonly string[]).includes(category),
  )

/** A sensitivity-router mintaszűrője — nincs álnév-típus, nem a tokenizáló réteg. */
export const SENSITIVITY_SCANNER_CATEGORIES: readonly PrivacyPolicyCategory[] = [
  'taj',
  'adoszam',
  'pan',
  'iban',
  'secret_key',
]

export function categorySupportsTokenize(category: string): boolean {
  const canonical = canonicalPrivacyCategory(category)
  if (!isPrivacyPolicyCategory(canonical)) return true
  return (TOKENIZABLE_PRIVACY_CATEGORIES as readonly string[]).includes(canonical)
}

export function isSensitivityScannerCategory(category: string): boolean {
  const canonical = canonicalPrivacyCategory(category)
  return (SENSITIVITY_SCANNER_CATEGORIES as readonly string[]).includes(canonical)
}

export const PAN_IBAN_ALLOW_CONFIRMATION = 'ALLOW_PAN_IBAN'

export const INITIAL_PRIVACY_PATTERN_SET_VERSION = 1

export const PRIVACY_CATEGORY_POLICY_KEY = 'privacy.gateway.category_policy'
export const PRIVACY_CATEGORY_POLICY_TENANT_KEY = 'privacy.gateway.tenant_category_policy'
export const PRIVACY_CATEGORY_POLICY_AGENT_KEY = 'privacy.gateway.agent_category_policy'

const CUSTOM_SLUG = /^[a-z][a-z0-9_]{0,63}$/

export type PrivacyCategoryMap = Partial<Record<PrivacyPolicyCategory, PrivacyCategoryAction>>
export type PrivacyCustomCategoryMap = Record<string, PrivacyCategoryAction>

export type PrivacyCategoryPolicyLayer = {
  categories: PrivacyCategoryMap
  custom: PrivacyCustomCategoryMap
  updatedById: string | null
  updatedAt: string | null
}

export type PrivacyCategoryPolicyDocument = PrivacyCategoryPolicyLayer & {
  patternSetVersion: number
}

export type ResolvedPrivacyCategoryPolicy = {
  categories: Record<PrivacyPolicyCategory, PrivacyCategoryAction>
  custom: PrivacyCustomCategoryMap
  patternSetVersion: number
  legacyToggleApplied: boolean
}

export type PrivacyCategoryPolicyActor = {
  actorId: string
  isSuperadmin: boolean
  /** `ALLOW_PAN_IBAN` — kötelező, ha a patch `pan` vagy `iban` `allow`-t tartalmaz. */
  confirmation?: string
}

export type PrivacyCategoryPolicyCode =
  | 'tokenize_unsupported_category'
  | 'secret_key_not_block'
  | 'allow_requires_superadmin'
  | 'allow_confirmation_required'
  | 'invalid_action'
  | 'invalid_category'

export class PrivacyCategoryPolicyError extends Error {
  readonly code: PrivacyCategoryPolicyCode
  readonly category: string | null

  constructor(code: PrivacyCategoryPolicyCode, message: string, category: string | null = null) {
    super(message)
    this.name = 'PrivacyCategoryPolicyError'
    this.code = code
    this.category = category
  }
}

export function isPrivacyCategoryAction(value: unknown): value is PrivacyCategoryAction {
  return (
    value === 'allow' || value === 'tokenize' || value === 'local_only' || value === 'block'
  )
}

export function isPrivacyPolicyCategory(value: string): value is PrivacyPolicyCategory {
  return (PRIVACY_POLICY_CATEGORIES as readonly string[]).includes(value)
}

export function canonicalPrivacyCategory(category: string): string {
  return PRIVACY_CATEGORY_ALIASES[category] ?? category
}

export function emptyPrivacyCategoryPolicyLayer(): PrivacyCategoryPolicyLayer {
  return { categories: {}, custom: {}, updatedById: null, updatedAt: null }
}

export function defaultPrivacyCategoryPolicyDocument(): PrivacyCategoryPolicyDocument {
  return {
    ...emptyPrivacyCategoryPolicyLayer(),
    patternSetVersion: INITIAL_PRIVACY_PATTERN_SET_VERSION,
  }
}

export function layerHasOverlay(layer: PrivacyCategoryPolicyLayer | null | undefined): boolean {
  if (!layer) return false
  return Object.keys(layer.categories).length > 0 || Object.keys(layer.custom).length > 0
}

/**
 * Overlay-merge: default ← platform ← tenant ← agent, majd a legacy kapcsoló,
 * ha az agentnek nincs saját overlay-je.
 */
export function resolvePrivacyCategoryPolicy(layers: {
  platform?: PrivacyCategoryPolicyDocument | null
  tenant?: PrivacyCategoryPolicyLayer | null
  agent?: PrivacyCategoryPolicyLayer | null
  legacyAllowSensitiveExternalModel?: boolean
}): ResolvedPrivacyCategoryPolicy {
  const platform = layers.platform ?? defaultPrivacyCategoryPolicyDocument()
  const categories: Record<PrivacyPolicyCategory, PrivacyCategoryAction> = {
    ...DEFAULT_PRIVACY_CATEGORY_POLICY,
    ...platform.categories,
    ...layers.tenant?.categories,
    ...layers.agent?.categories,
  }
  const custom: PrivacyCustomCategoryMap = {
    ...platform.custom,
    ...layers.tenant?.custom,
    ...layers.agent?.custom,
  }

  const legacyToggleApplied = Boolean(
    layers.legacyAllowSensitiveExternalModel && !layerHasOverlay(layers.agent),
  )
  if (legacyToggleApplied) {
    for (const category of LEGACY_SENSITIVE_EXTERNAL_CATEGORIES) {
      categories[category] = 'allow'
    }
  }

  return {
    categories,
    custom,
    patternSetVersion: platform.patternSetVersion || INITIAL_PRIVACY_PATTERN_SET_VERSION,
    legacyToggleApplied,
  }
}

export function actionForPrivacyCategory(
  resolved: ResolvedPrivacyCategoryPolicy,
  category: string,
): PrivacyCategoryAction {
  const canonical = canonicalPrivacyCategory(category)
  if (isPrivacyPolicyCategory(canonical)) return resolved.categories[canonical]
  if (canonical in resolved.custom) return resolved.custom[canonical]
  return 'tokenize'
}

/** Külső modellre a nyers érték csak `allow` mellett mehet. */
export function allowsExternalRaw(action: PrivacyCategoryAction): boolean {
  return action === 'allow'
}

/** Overlay-érték: `null` = a kulcs törlése, a szülő szint újra érvényes. */
export type PrivacyCategoryOverlayValue = PrivacyCategoryAction | null
export type PrivacyCategoryPatchMap = Partial<Record<PrivacyPolicyCategory, PrivacyCategoryOverlayValue>>
export type PrivacyCustomCategoryPatchMap = Record<string, PrivacyCategoryOverlayValue>

export type PrivacyCategoryPolicyPatch = {
  categories?: PrivacyCategoryPatchMap | null
  custom?: PrivacyCustomCategoryPatchMap | null
}

export function applyCategoryMapPatch(
  current: PrivacyCategoryMap,
  patch: PrivacyCategoryPatchMap | null | undefined,
): PrivacyCategoryMap {
  if (patch === null) return {}
  if (!patch) return { ...current }
  const next: PrivacyCategoryMap = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (!isPrivacyPolicyCategory(key)) continue
    if (value === null) delete next[key]
    else if (isPrivacyCategoryAction(value)) next[key] = value
  }
  return next
}

export function applyCustomCategoryMapPatch(
  current: PrivacyCustomCategoryMap,
  patch: PrivacyCustomCategoryPatchMap | null | undefined,
): PrivacyCustomCategoryMap {
  if (patch === null) return {}
  if (!patch) return { ...current }
  const next: PrivacyCustomCategoryMap = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else if (isPrivacyCategoryAction(value)) next[key] = value
  }
  return next
}

export type PrivacyPolicySource = 'default' | 'platform' | 'tenant' | 'agent' | 'legacy'
export type PrivacyEditorLayer = 'platform' | 'tenant' | 'agent'

export function privacyEditorLayerValue<T>(
  layer: PrivacyEditorLayer,
  values: Record<PrivacyEditorLayer, T>,
): T {
  return values[layer]
}

export function privacyEditorLayersThrough(layer: PrivacyEditorLayer): PrivacyEditorLayer[] {
  return privacyEditorLayerValue(layer, {
    platform: ['platform'],
    tenant: ['platform', 'tenant'],
    agent: ['platform', 'tenant', 'agent'],
  })
}

export type PrivacyPolicyEditorRow = {
  category: string
  kind: 'builtin' | 'custom'
  resolvedAction: PrivacyCategoryAction
  source: PrivacyPolicySource
  overlayAction: PrivacyCategoryAction | null
  inherited: boolean
}

function overlayActionFor(
  layer: PrivacyCategoryPolicyLayer | PrivacyCategoryPolicyDocument | null | undefined,
  category: string,
): PrivacyCategoryAction | null {
  if (!layer) return null
  if (isPrivacyPolicyCategory(category)) return layer.categories[category] ?? null
  return layer.custom[category] ?? null
}

export function sourceForPrivacyCategory(
  layers: {
    platform?: PrivacyCategoryPolicyDocument | null
    tenant?: PrivacyCategoryPolicyLayer | null
    agent?: PrivacyCategoryPolicyLayer | null
    legacyAllowSensitiveExternalModel?: boolean
  },
  category: string,
): PrivacyPolicySource {
  const resolved = resolvePrivacyCategoryPolicy(layers)
  if (resolved.legacyToggleApplied && isPrivacyPolicyCategory(canonicalPrivacyCategory(category))) {
    return 'legacy'
  }
  if (overlayActionFor(layers.agent, category)) return 'agent'
  if (overlayActionFor(layers.tenant, category)) return 'tenant'
  if (overlayActionFor(layers.platform, category)) return 'platform'
  return 'default'
}

export function buildPrivacyPolicyEditorRows(input: {
  platform?: PrivacyCategoryPolicyDocument | null
  tenant?: PrivacyCategoryPolicyLayer | null
  agent?: PrivacyCategoryPolicyLayer | null
  legacyAllowSensitiveExternalModel?: boolean
  editingLayer: PrivacyEditorLayer
}): PrivacyPolicyEditorRow[] {
  const resolved = resolvePrivacyCategoryPolicy(input)
  const byLayer = {
    platform: input.platform,
    tenant: input.tenant,
    agent: input.agent,
  }
  const editingLayer = privacyEditorLayerValue(input.editingLayer, byLayer)
  const customLayers = privacyEditorLayersThrough(input.editingLayer).map((layer) => byLayer[layer])
  const customKeys = new Set(customLayers.flatMap((layer) => Object.keys(layer?.custom ?? {})))

  const builtin: PrivacyPolicyEditorRow[] = PRIVACY_POLICY_CATEGORIES.map((category) => {
    const overlayAction = overlayActionFor(editingLayer, category)
    return {
      category,
      kind: 'builtin',
      resolvedAction: resolved.categories[category],
      source: sourceForPrivacyCategory(input, category),
      overlayAction,
      inherited: overlayAction == null,
    }
  })

  const custom: PrivacyPolicyEditorRow[] = [...customKeys].sort().map((category) => {
    const overlayAction = overlayActionFor(editingLayer, category)
    return {
      category,
      kind: 'custom',
      resolvedAction: actionForPrivacyCategory(resolved, category),
      source: sourceForPrivacyCategory(input, category),
      overlayAction,
      inherited: overlayAction == null,
    }
  })

  return [...builtin, ...custom]
}

/**
 * Mentési invariánsok a patchen (nem a merged eredményen).
 * `secret_key` bármely nem-`block` érték elbukik; `pan`/`iban` `allow` superadmin +
 * `ALLOW_PAN_IBAN` megerősítés nélkül elbukik.
 */
export function assertPrivacyCategoryPolicyPatch(
  patch: PrivacyCategoryPolicyPatch,
  actor: Pick<PrivacyCategoryPolicyActor, 'isSuperadmin' | 'confirmation'>,
): void {
  const categories = patch.categories ?? {}
  for (const [key, action] of Object.entries(categories)) {
    if (action === null) continue
    if (!isPrivacyPolicyCategory(key)) {
      throw new PrivacyCategoryPolicyError(
        'invalid_category',
        `ismeretlen kategória: ${key}`,
        key,
      )
    }
    assertAction(key, action, actor)
  }

  const custom = patch.custom ?? {}
  for (const [key, action] of Object.entries(custom)) {
    if (action === null) continue
    assertCustomSlug(key)
    assertAction(key, action, actor)
  }
}

function assertCustomSlug(key: string): void {
  if (isPrivacyPolicyCategory(key) || key in PRIVACY_CATEGORY_ALIASES) {
    throw new PrivacyCategoryPolicyError(
      'invalid_category',
      `a beépített kategória (${key}) nem tehető a tenant-egyedi minták közé`,
      key,
    )
  }
  if (!CUSTOM_SLUG.test(key)) {
    throw new PrivacyCategoryPolicyError(
      'invalid_category',
      `érvénytelen tenant-egyedi mintaazonosító: ${key}`,
      key,
    )
  }
}

function assertAction(
  category: string,
  action: unknown,
  actor: Pick<PrivacyCategoryPolicyActor, 'isSuperadmin' | 'confirmation'>,
): void {
  if (!isPrivacyCategoryAction(action)) {
    throw new PrivacyCategoryPolicyError(
      'invalid_action',
      `érvénytelen akció (${String(action)}) a(z) ${category} kategórián`,
      category,
    )
  }

  const canonical = canonicalPrivacyCategory(category)
  if (canonical === 'secret_key' && action !== 'block') {
    throw new PrivacyCategoryPolicyError(
      'secret_key_not_block',
      'A secret_key kategória csak block lehet (tokenize/allow/local_only tilos).',
      'secret_key',
    )
  }
  if (action === 'tokenize' && !categorySupportsTokenize(canonical)) {
    throw new PrivacyCategoryPolicyError(
      'tokenize_unsupported_category',
      `A(z) ${canonical} adathoz nincs álnév-típus, ezért nem cserélhető álnévre. Válaszd a „Csak helyi modell" vagy a „Tiltva" beállítást.`,
      canonical,
    )
  }
  if ((canonical === 'pan' || canonical === 'iban') && action === 'allow') {
    if (!actor.isSuperadmin) {
      throw new PrivacyCategoryPolicyError(
        'allow_requires_superadmin',
        `A(z) ${canonical} allow értéke csak superadmin állíthatja.`,
        canonical,
      )
    }
    if (actor.confirmation !== PAN_IBAN_ALLOW_CONFIRMATION) {
      throw new PrivacyCategoryPolicyError(
        'allow_confirmation_required',
        `A(z) ${canonical} allow értékéhez írd be: ${PAN_IBAN_ALLOW_CONFIRMATION}`,
        canonical,
      )
    }
  }
}

export function parsePrivacyCategoryMap(raw: unknown): PrivacyCategoryMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: PrivacyCategoryMap = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isPrivacyPolicyCategory(key) && isPrivacyCategoryAction(value)) out[key] = value
  }
  return out
}

export function parsePrivacyCustomCategoryMap(raw: unknown): PrivacyCustomCategoryMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: PrivacyCustomCategoryMap = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (CUSTOM_SLUG.test(key) && !isPrivacyPolicyCategory(key) && isPrivacyCategoryAction(value)) {
      out[key] = value
    }
  }
  return out
}

export function parsePrivacyCategoryPolicyDocument(raw: unknown): PrivacyCategoryPolicyDocument {
  const layer = parsePrivacyCategoryPolicyLayer(raw)
  const version =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { patternSetVersion?: unknown }).patternSetVersion
      : null
  return {
    ...layer,
    patternSetVersion:
      typeof version === 'number' && Number.isInteger(version) && version >= 1
        ? version
        : INITIAL_PRIVACY_PATTERN_SET_VERSION,
  }
}

export function parsePrivacyCategoryPolicyLayer(raw: unknown): PrivacyCategoryPolicyLayer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return emptyPrivacyCategoryPolicyLayer()
  }
  const rec = raw as Record<string, unknown>
  return {
    categories: parsePrivacyCategoryMap(rec.categories),
    custom: parsePrivacyCustomCategoryMap(rec.custom),
    updatedById: typeof rec.updatedById === 'string' ? rec.updatedById : null,
    updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : null,
  }
}

export type PrivacyCategoryActionResolver = (ctx: {
  tenantId: string | null
  agentId: string
  category: string
  legacyAllowSensitiveExternalModel: boolean
}) => Promise<PrivacyCategoryAction>
