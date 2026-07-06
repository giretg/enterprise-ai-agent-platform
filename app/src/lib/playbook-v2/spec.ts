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

// --- Step-outcome kontraktus (WP-7 / D12, §10.1) --------------------------

/**
 * Gépi step-kimenet-státusz a próza MELLETT. A hard signalokat (kb_search 0-hit,
 * tool-denied, tool-loop exception) a runtime KÉNYSZERÍTI rá determinisztikusan,
 * nem az agent optimista önbevallására bízva.
 *  - `ok`      — a step teljesítette a szerződését (outputContract kitöltve) → happy path.
 *  - `blocked` — hiányzó előfeltétel/input, emberrel vagy másik lépéssel feloldható (NEM hard hiba).
 *  - `failed`  — hard hiba (tool exception, tool-denied, kimerített retry).
 */
export const stepOutcomeStatusSchema = z.enum(['ok', 'blocked', 'failed'])
export type StepOutcomeStatus = z.infer<typeof stepOutcomeStatusSchema>

export const stepOutcomeSchema = z.object({
  status: stepOutcomeStatusSchema,
  reason: z.string().optional(),
  missing: z.array(z.string()).optional(),
})
export type StepOutcome = z.infer<typeof stepOutcomeSchema>

/** A payloadban az `outcome`-mező kanonikus kulcsa (routing-feltétel: `outcome.status`). */
export const STEP_OUTCOME_FIELD = 'outcome' as const
export const STEP_OUTCOME_STATUS_PATH = 'outcome.status' as const
/** Hibapolicy spec §5.2/P2 — a reason-kulcsos hiba-út feltétel-mezője. */
export const STEP_OUTCOME_REASON_PATH = 'outcome.reason' as const

// --- Hiba-él routing-cél (WP-7 / §10.2, BPMN error boundary) --------------

/** Egy `onError`/`onBlocked`/`fallback` routing-cél: step VAGY gate. */
export const routingTargetSchema = z
  .object({
    nextStepId: z.string().min(1).optional(),
    gateId: z.string().min(1).optional(),
  })
  .refine((r) => r.nextStepId != null || r.gateId != null, {
    message: 'routing-célnak nextStepId vagy gateId kell.',
  })
export type RoutingTarget = z.infer<typeof routingTargetSchema>

// --- Hibatípus-tudatos routing (hibakezelési policy spec §5, P2) ----------

/**
 * Nevesített, bővíthető szótár a determinisztikus hard-signal `outcome.reason`-höz
 * (§5.1). Egyedi (nem nevesített) reason-ök a `computeStepOutcome`-ban továbbra is
 * megengedettek — csak a routing NEM célozhatja őket névvel, a status catch-all
 * (`outcome.status`) akkor is illeszkedik rájuk.
 */
export const stepOutcomeReasonSchema = z.enum([
  'tool_loop_exhausted',
  'tool_denied',
  'missing_kb_source',
  'timeout',
  'output_contract_unmet',
])
export type StepOutcomeReason = z.infer<typeof stepOutcomeReasonSchema>

/** Egy reason-kulcsos hiba-út (§5.2); `reason` hiányában a wrapper catch-all célja illeszkedik helyette. */
export const errorRouteSchema = z
  .object({
    reason: stepOutcomeReasonSchema.optional(),
    nextStepId: z.string().min(1).optional(),
    gateId: z.string().min(1).optional(),
  })
  .refine((r) => r.nextStepId != null || r.gateId != null, {
    message: 'hiba-útnak nextStepId vagy gateId kell.',
  })
export type ErrorRoute = z.infer<typeof errorRouteSchema>

/**
 * Reason-kulcsos hiba-él lista + opcionális catch-all cél (a wrapperen megadott
 * `nextStepId`/`gateId`, ha egyetlen reason sem illeszkedik). A catch-all opcionális:
 * ha hiányzik, a nem-illeszkedő reason-ök a Playbook-default/`await_human` felé mennek.
 */
export const errorRoutesSchema = z.object({
  nextStepId: z.string().min(1).optional(),
  gateId: z.string().min(1).optional(),
  routes: z.array(errorRouteSchema).min(1),
})
export type ErrorRoutes = z.infer<typeof errorRoutesSchema>

/**
 * Egy step `onError`/`onBlocked` célja: a mai egyszerű catch-all `RoutingTarget`
 * VAGY a reason-kulcsos `ErrorRoutes`. Az union sorrendje szándékos: `errorRoutesSchema`
 * ELŐSZÖR, mert a `routes` mező megléte egyértelműen megkülönbözteti a két alakot —
 * fordított sorrendben a `routingTargetSchema` némán lestrippelné a `routes` tömböt.
 */
export const stepErrorTargetSchema = z.union([errorRoutesSchema, routingTargetSchema])
export type StepErrorTarget = z.infer<typeof stepErrorTargetSchema>

// --- Playbook-szintű default hibaág (hibakezelési policy spec §4, P1) -----

/**
 * Playbook-szintű alapértelmezett hibaág. Csak azokon a lépéseken lép életbe,
 * amelyeknek NINCS saját `onError`/`onBlocked` éle (lépés-szint elsőbbséget élvez).
 * A beégetett `await_human` végső biztonsági háló marad, ha se lépés-, se
 * Playbook-szintű default nincs (§3 TE-3).
 */
export const errorPolicySchema = z.object({
  /** Kezeletlen `failed` step-outcome default célja (step VAGY gate). */
  onError: routingTargetSchema.optional(),
  /** Kezeletlen `blocked` step-outcome default célja. */
  onBlocked: routingTargetSchema.optional(),
})
export type ErrorPolicy = z.infer<typeof errorPolicySchema>

// --- Criticality + Decision Step sugar-blokk (WP-8 / D13, §11.2b) ----------
// A criticalitySchema-t itt (a step-séma ELŐTT) definiáljuk, mert a decision-blokk
// hivatkozza; a gate-séma is innen olvassa.

export const criticalitySchema = z.enum(['L0', 'L1', 'L2', 'L3'])
export type Criticality = z.infer<typeof criticalitySchema>

/**
 * Egy engedélyezett kimenet (outcome) → célág. Olvasható authoring-cukor;
 * a compiler `onComplete`/routingRules-ra desugarolja (nincs új runtime-semantics).
 */
export const decisionBranchSchema = z
  .object({
    outcome: z.string().min(1),
    label: z.string().optional(),
    nextStepId: z.string().min(1).optional(),
    gateId: z.string().min(1).optional(),
    criticality: criticalitySchema.optional(),
    requiresEvidence: z.boolean().optional(),
  })
  .refine((b) => b.nextStepId != null || b.gateId != null, {
    message: 'decision branch-nek nextStepId vagy gateId kell.',
  })
export type DecisionBranch = z.infer<typeof decisionBranchSchema>

/**
 * Explicit, olvasható A/B (multi-outcome) elágazás. A `decision`-blokk a HASH-ELT
 * `spec` része (D13, ellentétben a layouttal); compile-time desugar `onComplete`-re.
 */
export const decisionSpecSchema = z.object({
  /** Melyik output-mező hordozza a döntést (alap: `decision`). */
  field: z.string().min(1).default('decision'),
  confidenceField: z.string().min(1).optional(),
  evidenceField: z.string().min(1).optional(),
  /** Engedélyezett kimenetek; ha üres, a branches[].outcome halmazából derivált. */
  allowedOutcomes: z.array(z.string().min(1)).optional(),
  branches: z.array(decisionBranchSchema).min(1),
  fallback: routingTargetSchema.optional(),
  /** Küszöb az automatikus ág-választáshoz (MVP: külön helper/warning kényszeríti, §11.2). */
  minConfidenceForAutoBranch: z.number().min(0).max(1).optional(),
  requiresEvidence: z.boolean().optional(),
})
export type DecisionSpec = z.infer<typeof decisionSpecSchema>

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
  // WP-7 / §10.2 — implicit hiba-él (BPMN error boundary). Ha nincs megadva,
  // a compiler az implicit default-terminálhoz (awaiting_human) köti. A happy path-t
  // a szerző húzza; a hiba-ágat csak akkor kell, ha nem a default awaiting_human kell.
  // Hibapolicy spec §5.2 / P2 — catch-all `RoutingTarget` VAGY reason-kulcsos `ErrorRoutes`.
  onError: stepErrorTargetSchema.optional(),
  onBlocked: stepErrorTargetSchema.optional(),
  // WP-8 / §11.2b — explicit Decision Step sugar-blokk; compile-time desugar onComplete-re.
  decision: decisionSpecSchema.optional(),
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
  // hibakezelési policy spec §4 / P1 — Playbook-szintű default hibaág; a hash-elt
  // spec része, csak a saját onError/onBlocked NÉLKÜLI lépéseken lép életbe.
  defaultErrorPolicy: errorPolicySchema.optional(),
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
