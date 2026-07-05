/**
 * Fázis 2 Playbook-spec — gépiesen olvasható, verziózott folyamatleírás
 * (Feature-spec — Playbook §5). Ez a több lépéses, több szereplős agent-folyamatok
 * FORRÁS-IGAZSÁGA: a Playbook írja le a szándékolt flow-t (szerepek, átadások, kapuk),
 * amit a PlaybookCompiler determinisztikus ticket-állapotgéppé fordít.
 *
 * FONTOS: ez NEM a meglévő MVP `@/lib/playbook-spec` (tömb-alapú, wiki-horgokhoz).
 * A két formátum párhuzamosan él; ez a `schemaVersion: "1.0"` objektum-alapú Fázis 2 spec.
 *
 * A validáció a Zod-sémán (alak) + a PlaybookValidator szemantikai rétegén (§6) megy át.
 */
import { createHash } from 'crypto'
import { z } from 'zod'

export const PLAYBOOK_SCHEMA_VERSION = '1.0' as const

// --- Feltétel-kifejezések (onComplete / gate condition) -------------------

export const conditionOpSchema = z.enum(['==', '!=', '>=', '<=', '>', '<'])
export type ConditionOp = z.infer<typeof conditionOpSchema>

/** Egy mező-összehasonlítás a ticket/step payload ellen, vagy a `"default"` ág. */
export const conditionExpressionSchema = z.union([
  z.literal('default'),
  z.object({
    field: z.string().min(1),
    op: conditionOpSchema,
    value: z.union([z.string(), z.number(), z.boolean()]),
  }),
])
export type ConditionExpression = z.infer<typeof conditionExpressionSchema>

// --- Szerepek -------------------------------------------------------------

export const playbookRoleSchema = z.object({
  key: z.string().min(1),
  type: z.enum(['agent_role', 'human_role']),
  requiredCapabilities: z.array(z.string()).optional(),
  requiredPermissions: z.array(z.string()).optional(),
})
export type PlaybookRole = z.infer<typeof playbookRoleSchema>

// --- Tipizált input-rés (Folyamat-feature-spec §2, §4.7) ------------------

/** A rés forrása: `config` = Folyamat | `trigger` = futás-bemenet | `step` = előző lépés kimenete. */
export const inputSlotSourceSchema = z.enum(['config', 'trigger', 'step'])
export type InputSlotSource = z.infer<typeof inputSlotSourceSchema>

export const inputSlotTypeSchema = z.enum(['string', 'number', 'boolean', 'freeform'])
export type InputSlotType = z.infer<typeof inputSlotTypeSchema>

/**
 * A lépés-utasítás sablonjának nevesített, tipizált változója (`{{name}}`).
 * A `source` dönti el, hogy a Folyamat (config) vagy a Futás-bemenet (trigger) tölti.
 */
export const playbookInputSlotSchema = z.object({
  name: z.string().min(1), // template-változó neve: {{name}}
  type: inputSlotTypeSchema,
  required: z.boolean().default(true),
  source: inputSlotSourceSchema,
  description: z.string().optional(),
})
export type PlaybookInputSlot = z.infer<typeof playbookInputSlotSchema>

// --- Step szerződés (§5.3) ------------------------------------------------

export const stepCompletionRuleSchema = z
  .object({
    condition: conditionExpressionSchema,
    nextStepId: z.string().min(1).optional(),
    gateId: z.string().min(1).optional(),
  })
  .refine((r) => r.nextStepId != null || r.gateId != null, {
    message: 'onComplete szabálynak nextStepId vagy gateId kell.',
  })
export type StepCompletionRule = z.infer<typeof stepCompletionRuleSchema>

export const retryPolicySchema = z.object({
  maxAttempts: z.number().int().positive(),
  onExhausted: z.enum(['fail_process', 'manual_review']),
})

// §4.7b — lépés-deliverable: a lépés valódi fájl-artefaktumot állít elő a
// ticket munkaterületére (nem szöveget a válaszba). A runtime a `format`-hoz
// tartozó fájl-eszközt kéri (html→create_html, xlsx→xlsx_create, pptx→pptx_create,
// pdf→pdf_create), a kész fájl nevét pedig a lépés-payload `deliverableFile`
// mezőjébe (és ha megadott, a `field` outputContract-mezőbe) írja vissza.
export const playbookDeliverableFormatSchema = z.enum(['html', 'xlsx', 'pptx', 'pdf'])
export type PlaybookDeliverableFormat = z.infer<typeof playbookDeliverableFormatSchema>

export const playbookDeliverableSchema = z.object({
  format: playbookDeliverableFormatSchema,
  /** Melyik outputContract-mezőbe kerüljön a fájlnév-referencia (alap: deliverableFile). */
  field: z.string().min(1).optional(),
  /** Javasolt fájlnév az agentnek (a runtime az útmutatóba teszi). */
  filename: z.string().min(1).optional(),
})
export type PlaybookDeliverable = z.infer<typeof playbookDeliverableSchema>

export const playbookStepSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ticketType: z.string().min(1),
  assignedRole: z.string().min(1),
  description: z.string().optional(),
  requiredGateIds: z.array(z.string()).optional(),
  allowedStates: z.array(z.string()).optional(),
  // inputContract / outputContract: JSON-schema-szerű struktúra (lazán tárolva)
  inputContract: z.record(z.string(), z.unknown()).optional(),
  outputContract: z.record(z.string(), z.unknown()).optional(),
  // §4.7b: a lépés valódi fájl-deliverable-t termel a ticket munkaterületére.
  deliverable: playbookDeliverableSchema.optional(),
  // §4.7: sablonos lépés-utasítás tipizált résekkel. A {{slot}} tokenek az
  // inputSlots név-listájából oldódnak fel (config ill. trigger forrásból).
  instructionTemplate: z.string().optional(),
  inputSlots: z.array(playbookInputSlotSchema).optional(),
  onComplete: z.array(stepCompletionRuleSchema).optional(),
  timeoutMinutes: z.number().int().positive().optional(),
  retryPolicy: retryPolicySchema.optional(),
})
export type PlaybookStep = z.infer<typeof playbookStepSchema>

// --- Gate szerződés (§5.4) ------------------------------------------------

export const gateTypeSchema = z.enum([
  'human_approval',
  'eval_check',
  'policy_check',
  'tool_authorization',
  'manual_review',
])
export type GateType = z.infer<typeof gateTypeSchema>

export const criticalitySchema = z.enum(['L0', 'L1', 'L2', 'L3'])
export type Criticality = z.infer<typeof criticalitySchema>

export const playbookGateSchema = z
  .object({
    id: z.string().min(1),
    type: gateTypeSchema,
    requiredActorRole: z.string().optional(),
    criticality: criticalitySchema.optional(),
    blocking: z.boolean(),
    condition: conditionExpressionSchema.optional(),
    approvalMode: z.enum(['single', 'four_eyes', 'multi_level']).optional(),
    evidenceRequired: z.boolean().optional(),
  })
  // Kritikus szabály (§5.4): L2/L3 kapu csak blocking lehet.
  .refine((g) => !(g.criticality === 'L2' || g.criticality === 'L3') || g.blocking, {
    message: 'criticality L2/L3 gate csak blocking lehet.',
  })
export type PlaybookGate = z.infer<typeof playbookGateSchema>

// --- Transition -----------------------------------------------------------

export const playbookTransitionSchema = z.object({
  fromStepId: z.string().min(1),
  toStepId: z.string().min(1),
  trigger: z.string().min(1),
})
export type PlaybookTransition = z.infer<typeof playbookTransitionSchema>

// --- Top-level spec (§5.2) ------------------------------------------------

export const playbookOutputContractSchema = z.object({
  requiredFields: z.array(z.string()).optional(),
})

export const playbookSpecV2Schema = z.object({
  schemaVersion: z.literal(PLAYBOOK_SCHEMA_VERSION),
  key: z.string().min(1),
  name: z.string().min(1),
  processType: z.string().min(1),
  entryStepId: z.string().min(1),
  criticality: criticalitySchema.optional(),
  roles: z.array(playbookRoleSchema),
  steps: z.array(playbookStepSchema).min(1),
  gates: z.array(playbookGateSchema).default([]),
  transitions: z.array(playbookTransitionSchema).default([]),
  outputContract: playbookOutputContractSchema.optional(),
  // draft-only menekülő flag: hiányzó ticket-típusok engedélyezése (§6.2)
  allowMissingTicketTypes: z.boolean().optional(),
})
export type PlaybookSpecV2 = z.infer<typeof playbookSpecV2Schema>

/**
 * Strict Zod-parse. Csak az ALAKOT igazolja; a szemantikai keresztreferencia-
 * ellenőrzés (§6) a PlaybookValidator dolga. Dob, ha a struktúra hibás.
 */
export function parsePlaybookSpecV2(raw: unknown): PlaybookSpecV2 {
  return playbookSpecV2Schema.parse(raw)
}

/** Nem dobó változat — a validator a Zod-hibákat strukturált errorrá fordítja. */
export function safeParsePlaybookSpecV2(raw: unknown) {
  return playbookSpecV2Schema.safeParse(raw)
}

/**
 * Kulcs szerint rendezett, kanonikus JSON-serializáció. A content-hash forrása
 * (§4.3 `content_hash`); a kulcssorrend-független stabilitás miatt rekurzív rendezés.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonicalize(obj[k])
        return acc
      }, {})
  }
  return value
}

/** `sha256:<hex>` content hash a kanonikus specből (§4.3, §10.2). */
export function computePlaybookContentHash(spec: unknown): string {
  const canonical = JSON.stringify(canonicalize(spec))
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

/** Playbook-ref formázás: `playbook:<key>@v<version>` (§4.5). */
export function formatPlaybookRefV2(key: string, version: number): string {
  return `playbook:${key}@v${version}`
}
