/**
 * PlaybookValidator (Feature-spec — Playbook §6).
 *
 * Két rétegű, DETERMINISZTIKUS validáció:
 *   1. Séma-validáció — a Zod-alak (`safeParsePlaybookSpecV2`).
 *   2. Szemantikai validáció — keresztreferenciák, elérhetőség, ciklus-kapuk,
 *      criticality/role szabályok (§6.1), és opcionálisan a tenant-kontextus (§6.2).
 *
 * A tenant-kontextus (létező ticket-típusok, aktív agent role-ok, IAM permission-ök)
 * injektálható; ha nincs megadva, a szemantikai tenant-ellenőrzés warningra esik vissza,
 * hogy a draft továbbra is validálható maradjon DB nélkül (unit-teszt, §15).
 */
import {
  safeParsePlaybookSpecV2,
  type PlaybookSpecV2,
  type PlaybookStep,
  type ConditionExpression,
  type ErrorPolicy,
  type RoutingTarget,
} from '@/lib/playbook-v2/spec'
import {
  desugarDecision,
  normalizeErrorTarget,
  isRoutingTargetResolvable,
} from '@/domain/playbook/playbook-compiler'
import { TICKET_STATES } from '@/domain/ticket/ticket-type-config'
import {
  inferStepOutputFields,
  mergeOutputRequiredFields,
  readOutputContractFields,
} from '@/lib/playbook-v2/step-output-inference'

export type ValidationIssue = {
  code: string
  path: string
  message: string
}

export type ValidationResult = {
  valid: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

/** A tenant aktuális konfigurációja a szemantikai validációhoz (§6.2). */
export type TenantValidationContext = {
  knownTicketTypes?: Set<string>
  /** role.key → hány aktív agent tartozik hozzá */
  agentRoleActiveCounts?: Map<string, number>
  knownPermissions?: Set<string>
  /** role.key → az adott role/agent ténylegesen elérhető capability-i */
  roleCapabilities?: Map<string, Set<string>>
  /**
   * A tenant ismert capability-szótára (Capability.toolName vokabulár). Ha megadva,
   * a `roles[].requiredCapabilities` értékeinek ebbe kell esniük (Folyamat-spec §4.8, WP-4).
   */
  knownCapabilities?: Set<string>
  /**
   * Hibapolicy spec §4.2/WP-4 — a tenant publish-időben feloldott alapértelmezett hibapolicy-ja
   * (a `PlatformSettingsService`-ből). Csak arra szolgál, hogy a validátor jelezze, ha a tenant
   * egy olyan step/gate-et vár, ami EBBEN a Playbookban nem létezik (§4.2 note) — a compiler
   * emiatt nem bukik, csak csendben kihagyja, és a beégetett `await_human` marad érvényben.
   */
  tenantDefaultErrorPolicy?: ErrorPolicy
}

export class PlaybookValidator {
  validateSpec(raw: unknown, ctx: TenantValidationContext = {}): ValidationResult {
    const errors: ValidationIssue[] = []
    const warnings: ValidationIssue[] = []

    // --- 1. réteg: séma ----------------------------------------------------
    const parsed = safeParsePlaybookSpecV2(raw)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({
          code: 'SCHEMA_INVALID',
          path: issue.path.length ? issue.path.join('.') : '(root)',
          message: issue.message,
        })
      }
      return { valid: false, errors, warnings }
    }
    const spec = parsed.data

    // --- 2. réteg: szemantika ---------------------------------------------
    this.checkUniqueIds(spec, errors)
    this.checkReferences(spec, errors)
    this.checkReachability(spec, errors)
    this.checkCycles(spec, errors, warnings)
    this.checkGateCriticality(spec, errors)
    this.checkRoleAssigneeCompatibility(spec, errors)
    this.checkDeliverables(spec, errors)
    this.checkInputSlots(spec, errors, warnings)
    this.checkOutputContractCoverage(spec, warnings)
    this.checkTimeouts(spec, warnings)
    this.checkDecisionSteps(spec, errors, warnings)
    this.checkErrorEdges(spec, ctx, errors, warnings)
    this.checkErrorRouteQuality(spec, ctx, errors, warnings)
    this.checkTenantDefaultErrorTargets(spec, ctx, warnings)
    this.checkTenantContext(spec, ctx, errors, warnings)

    return { valid: errors.length === 0, errors, warnings }
  }

  // §6.1 — egyedi id-k
  private checkUniqueIds(spec: PlaybookSpecV2, errors: ValidationIssue[]) {
    this.assertUnique(spec.steps.map((s) => s.id), 'DUPLICATE_STEP_ID', 'steps', 'step', errors)
    this.assertUnique(spec.gates.map((g) => g.id), 'DUPLICATE_GATE_ID', 'gates', 'gate', errors)
    this.assertUnique(spec.roles.map((r) => r.key), 'DUPLICATE_ROLE_KEY', 'roles', 'role', errors)
  }

  private assertUnique(
    ids: string[],
    code: string,
    path: string,
    label: string,
    errors: ValidationIssue[],
  ) {
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) {
        errors.push({ code, path, message: `Duplikált ${label} azonosító: '${id}'.` })
      }
      seen.add(id)
    }
  }

  // §6.1 — minden hivatkozás létező entitásra mutat
  private checkReferences(spec: PlaybookSpecV2, errors: ValidationIssue[]) {
    const stepIds = new Set(spec.steps.map((s) => s.id))
    const gateIds = new Set(spec.gates.map((g) => g.id))
    const roleKeys = new Set(spec.roles.map((r) => r.key))

    if (!stepIds.has(spec.entryStepId)) {
      errors.push({
        code: 'UNKNOWN_ENTRY_STEP',
        path: 'entryStepId',
        message: `Az entryStepId '${spec.entryStepId}' nem létező step.`,
      })
    }

    spec.steps.forEach((step, i) => {
      if (!roleKeys.has(step.assignedRole)) {
        errors.push({
          code: 'UNKNOWN_ROLE',
          path: `steps[${i}].assignedRole`,
          message: `A(z) '${step.assignedRole}' role nincs definiálva.`,
        })
      }
      for (const state of step.allowedStates ?? []) {
        if (!TICKET_STATES.includes(state as (typeof TICKET_STATES)[number])) {
          errors.push({
            code: 'UNKNOWN_TICKET_STATE',
            path: `steps[${i}].allowedStates`,
            message: `A(z) '${state}' nem érvényes ticket-állapot (ismert: ${TICKET_STATES.join(', ')}).`,
          })
        }
      }
      for (const gid of step.requiredGateIds ?? []) {
        if (!gateIds.has(gid)) {
          errors.push({
            code: 'UNKNOWN_GATE',
            path: `steps[${i}].requiredGateIds`,
            message: `A(z) '${gid}' gate nincs definiálva.`,
          })
        }
      }
      ;(step.onComplete ?? []).forEach((rule, j) => {
        if (rule.nextStepId && !stepIds.has(rule.nextStepId)) {
          errors.push({
            code: 'UNKNOWN_STEP',
            path: `steps[${i}].onComplete[${j}].nextStepId`,
            message: `A(z) '${rule.nextStepId}' next step nem létezik.`,
          })
        }
        if (rule.gateId && !gateIds.has(rule.gateId)) {
          errors.push({
            code: 'UNKNOWN_GATE',
            path: `steps[${i}].onComplete[${j}].gateId`,
            message: `A(z) '${rule.gateId}' gate nem létezik.`,
          })
        }
      })

      // WP-7 §10.2 / hibapolicy spec §5.2 — hiba-él (onError/onBlocked) célok létezése,
      // a catch-all cél ÉS minden reason-kulcsos route esetén is (P2).
      for (const [key, target] of [
        ['onError', step.onError],
        ['onBlocked', step.onBlocked],
      ] as const) {
        if (!target) continue
        const { reasonRoutes, catchAll } = normalizeErrorTarget(target)
        const routeTargets = [
          ...(catchAll ? [{ label: `${key}`, route: catchAll }] : []),
          ...reasonRoutes.map((r, k) => ({ label: `${key}.routes[${k}]`, route: r })),
        ]
        for (const { label, route } of routeTargets) {
          if (route.nextStepId && !stepIds.has(route.nextStepId)) {
            errors.push({
              code: 'UNKNOWN_BRANCH_TARGET',
              path: `steps[${i}].${label}.nextStepId`,
              message: `A(z) '${route.nextStepId}' hiba-él cél-step nem létezik.`,
            })
          }
          if (route.gateId && !gateIds.has(route.gateId)) {
            errors.push({
              code: 'UNKNOWN_BRANCH_TARGET',
              path: `steps[${i}].${label}.gateId`,
              message: `A(z) '${route.gateId}' hiba-él cél-gate nem létezik.`,
            })
          }
        }
      }

      // WP-8 §11.4 — decision-ágak (branches + fallback) célok létezése.
      if (step.decision) {
        step.decision.branches.forEach((b, k) => {
          if (b.nextStepId && !stepIds.has(b.nextStepId)) {
            errors.push({
              code: 'UNKNOWN_BRANCH_TARGET',
              path: `steps[${i}].decision.branches[${k}].nextStepId`,
              message: `A(z) '${b.nextStepId}' branch cél-step nem létezik.`,
            })
          }
          if (b.gateId && !gateIds.has(b.gateId)) {
            errors.push({
              code: 'UNKNOWN_BRANCH_TARGET',
              path: `steps[${i}].decision.branches[${k}].gateId`,
              message: `A(z) '${b.gateId}' branch cél-gate nem létezik.`,
            })
          }
        })
        const fb = step.decision.fallback
        if (fb?.nextStepId && !stepIds.has(fb.nextStepId)) {
          errors.push({
            code: 'UNKNOWN_BRANCH_TARGET',
            path: `steps[${i}].decision.fallback.nextStepId`,
            message: `A(z) '${fb.nextStepId}' fallback cél-step nem létezik.`,
          })
        }
        if (fb?.gateId && !gateIds.has(fb.gateId)) {
          errors.push({
            code: 'UNKNOWN_BRANCH_TARGET',
            path: `steps[${i}].decision.fallback.gateId`,
            message: `A(z) '${fb.gateId}' fallback cél-gate nem létezik.`,
          })
        }
      }
    })

    spec.transitions.forEach((t, i) => {
      if (!stepIds.has(t.fromStepId)) {
        errors.push({
          code: 'UNKNOWN_STEP',
          path: `transitions[${i}].fromStepId`,
          message: `A(z) '${t.fromStepId}' fromStep nem létezik.`,
        })
      }
      if (!stepIds.has(t.toStepId)) {
        errors.push({
          code: 'UNKNOWN_STEP',
          path: `transitions[${i}].toStepId`,
          message: `A(z) '${t.toStepId}' toStep nem létezik.`,
        })
      }
    })

    spec.gates.forEach((gate, i) => {
      if (gate.requiredActorRole && !roleKeys.has(gate.requiredActorRole)) {
        errors.push({
          code: 'UNKNOWN_ROLE',
          path: `gates[${i}].requiredActorRole`,
          message: `A(z) '${gate.requiredActorRole}' gate role nincs definiálva.`,
        })
      }
    })

    // Hibapolicy spec §4.1/§8 / P1 — a Playbook-szintű default hibaág célja létező
    // step vagy gate legyen (UNKNOWN_DEFAULT_ERROR_TARGET).
    for (const [key, target] of [
      ['defaultErrorPolicy.onError', spec.defaultErrorPolicy?.onError],
      ['defaultErrorPolicy.onBlocked', spec.defaultErrorPolicy?.onBlocked],
    ] as const) {
      if (!target) continue
      if (target.nextStepId && !stepIds.has(target.nextStepId)) {
        errors.push({
          code: 'UNKNOWN_DEFAULT_ERROR_TARGET',
          path: `${key}.nextStepId`,
          message: `A(z) '${target.nextStepId}' default hiba-él cél-step nem létezik.`,
        })
      }
      if (target.gateId && !gateIds.has(target.gateId)) {
        errors.push({
          code: 'UNKNOWN_DEFAULT_ERROR_TARGET',
          path: `${key}.gateId`,
          message: `A(z) '${target.gateId}' default hiba-él cél-gate nem létezik.`,
        })
      }
    }
  }

  // §6.1 — nincs elérhetetlen step (entry-ből onComplete + transitions mentén)
  private checkReachability(spec: PlaybookSpecV2, errors: ValidationIssue[]) {
    const adjacency = this.buildAdjacency(spec)
    const reachable = new Set<string>()
    const queue: string[] = [spec.entryStepId]
    while (queue.length) {
      const cur = queue.shift()!
      if (reachable.has(cur)) continue
      reachable.add(cur)
      for (const next of adjacency.get(cur) ?? []) queue.push(next)
    }
    spec.steps.forEach((step, i) => {
      if (!reachable.has(step.id)) {
        errors.push({
          code: 'UNREACHABLE_STEP',
          path: `steps[${i}]`,
          message: `A(z) '${step.id}' step nem érhető el az entryStepId-ből.`,
        })
      }
    })
  }

  // §6.1 — nincs olyan ciklus, amelyből nincs gate/timeout/manual exit
  private checkCycles(spec: PlaybookSpecV2, errors: ValidationIssue[], warnings: ValidationIssue[]) {
    const adjacency = this.buildAdjacency(spec)
    const stepById = new Map(spec.steps.map((s) => [s.id, s]))
    const color = new Map<string, 0 | 1 | 2>() // 0=white,1=gray,2=black

    const hasExit = (cycleNodes: Set<string>): boolean => {
      for (const id of cycleNodes) {
        const step = stepById.get(id)
        if (!step) continue
        if (step.timeoutMinutes != null) return true
        if ((step.requiredGateIds ?? []).length > 0) return true
        // onComplete-ben gate-re vagy a cikluson kívülre mutató ág is kijárat
        for (const rule of step.onComplete ?? []) {
          if (rule.gateId) return true
          if (rule.nextStepId && !cycleNodes.has(rule.nextStepId)) return true
        }
      }
      return false
    }

    const stack: string[] = []
    let cycleReported = false
    const dfs = (node: string) => {
      color.set(node, 1)
      stack.push(node)
      for (const next of adjacency.get(node) ?? []) {
        const c = color.get(next) ?? 0
        if (c === 1) {
          // hátsó él → ciklus a stack next..top szeletén
          const idx = stack.lastIndexOf(next)
          const cycleNodes = new Set(stack.slice(idx))
          if (!hasExit(cycleNodes) && !cycleReported) {
            cycleReported = true
            errors.push({
              code: 'CYCLE_WITHOUT_EXIT',
              path: 'steps',
              message: `Kijárat (gate/timeout/manual exit) nélküli ciklus: ${[...cycleNodes].join(' -> ')}.`,
            })
          } else if (hasExit(cycleNodes)) {
            warnings.push({
              code: 'CYCLE_WITH_EXIT',
              path: 'steps',
              message: `Ciklus észlelve (van kijárata): ${[...cycleNodes].join(' -> ')}.`,
            })
          }
        } else if (c === 0) {
          dfs(next)
        }
      }
      stack.pop()
      color.set(node, 2)
    }
    for (const step of spec.steps) {
      if ((color.get(step.id) ?? 0) === 0) dfs(step.id)
    }
  }

  // §6.1 / §5.4 — L2/L3 csak blocking (a Zod is fogja, de duplán védjük)
  private checkGateCriticality(spec: PlaybookSpecV2, errors: ValidationIssue[]) {
    spec.gates.forEach((gate, i) => {
      if ((gate.criticality === 'L2' || gate.criticality === 'L3') && !gate.blocking) {
        errors.push({
          code: 'CRITICAL_GATE_NOT_BLOCKING',
          path: `gates[${i}]`,
          message: `A(z) '${gate.id}' kapu criticality=${gate.criticality}, ezért blocking kell legyen.`,
        })
      }
    })
  }

  // §6.1 — agent role-os step csak agent, human role-os csak human assignee;
  //        human_approval gate-hez kell létező human role.
  private checkRoleAssigneeCompatibility(spec: PlaybookSpecV2, errors: ValidationIssue[]) {
    const roleByKey = new Map(spec.roles.map((r) => [r.key, r]))
    const humanRoleExists = spec.roles.some((r) => r.type === 'human_role')

    spec.gates.forEach((gate, i) => {
      if (gate.type === 'human_approval') {
        const role = gate.requiredActorRole ? roleByKey.get(gate.requiredActorRole) : undefined
        const ok = role ? role.type === 'human_role' : humanRoleExists
        if (!ok) {
          errors.push({
            code: 'HUMAN_GATE_NO_HUMAN_ROLE',
            path: `gates[${i}]`,
            message: `A(z) '${gate.id}' human_approval gate-hez nincs emberi role.`,
          })
        }
      }
    })
  }

  // §4.7b — fájl-deliverable csak agent-lépésen értelmes (a fájl-eszközöket az
  //         agent hívja; emberi lépés nem gyárt tool-lal fájlt).
  private checkDeliverables(spec: PlaybookSpecV2, errors: ValidationIssue[]) {
    const roleByKey = new Map(spec.roles.map((r) => [r.key, r]))
    spec.steps.forEach((step, i) => {
      if (!step.deliverable) return
      const role = roleByKey.get(step.assignedRole)
      if (role && role.type !== 'agent_role') {
        errors.push({
          code: 'DELIVERABLE_ON_NON_AGENT_STEP',
          path: `steps[${i}].deliverable`,
          message: `A(z) '${step.id}' lépés deliverable-t deklarál, de a szerepe (${step.assignedRole}) nem agent_role — fájlt csak agent-lépés gyárthat.`,
        })
      }
    })
  }

  // Folyamat-spec §4.7 / WP-4 — tipizált input-rés és a sablonos utasítás integritása.
  private checkInputSlots(
    spec: PlaybookSpecV2,
    errors: ValidationIssue[],
    warnings: ValidationIssue[],
  ) {
    const roleByKey = new Map(spec.roles.map((r) => [r.key, r]))

    spec.steps.forEach((step, i) => {
      const slots = step.inputSlots ?? []
      const template = step.instructionTemplate

      // Forrás-particionálás: lépésen belül egyértelmű rés-név (egy név = egy forrás).
      const slotNames = new Set<string>()
      for (const slot of slots) {
        if (slotNames.has(slot.name)) {
          errors.push({
            code: 'DUPLICATE_INPUT_SLOT',
            path: `steps[${i}].inputSlots`,
            message: `Duplikált input-rés név: '${slot.name}' (lépésen belül egyértelműnek kell lennie).`,
          })
        }
        slotNames.add(slot.name)
      }

      // Ha egyik sincs megadva, nincs mit ellenőrizni — de agent-lépésnél figyelmeztetés,
      // mert instructionTemplate nélkül a ticket payload nem fog question mezőt kapni.
      if (!template && slots.length === 0) {
        const roleType = roleByKey.get(step.assignedRole)?.type ?? 'agent_role'
        if (roleType === 'agent_role') {
          warnings.push({
            code: 'AGENT_STEP_NO_INSTRUCTION_TEMPLATE',
            path: `steps[${i}].instructionTemplate`,
            message: `A(z) '${step.id}' agent-lépésnek nincs instructionTemplate — a ticket prompt nélkül jön létre, az agent csak a ticket címéből tud dolgozni.`,
          })
        }
        return
      }
      if (template == null && slots.length > 0) {
        warnings.push({
          code: 'SLOTS_WITHOUT_TEMPLATE',
          path: `steps[${i}].inputSlots`,
          message: `A(z) '${step.id}' lépés input-réseket deklarál, de nincs instructionTemplate.`,
        })
        return
      }

      const tokens = this.extractTemplateTokens(template ?? '')

      // 1. Minden {{token}} létező rés legyen.
      for (const token of tokens) {
        if (!slotNames.has(token)) {
          errors.push({
            code: 'UNKNOWN_TEMPLATE_SLOT',
            path: `steps[${i}].instructionTemplate`,
            message: `A(z) '{{${token}}}' sablon-token nincs deklarálva az inputSlots között.`,
          })
        }
      }

      // 2. Minden required rés jelenjen meg a template-ben; a nem-required kimaradása warning.
      for (const slot of slots) {
        if (tokens.has(slot.name)) continue
        if (slot.required) {
          errors.push({
            code: 'REQUIRED_SLOT_UNUSED',
            path: `steps[${i}].inputSlots`,
            message: `A(z) '${slot.name}' kötelező rés nem szerepel az instructionTemplate-ben.`,
          })
        } else {
          warnings.push({
            code: 'OPTIONAL_SLOT_UNUSED',
            path: `steps[${i}].inputSlots`,
            message: `A(z) '${slot.name}' opcionális rés nem szerepel az instructionTemplate-ben.`,
          })
        }
      }
    })
  }

  /** `{{ token }}` nevek kinyerése (whitespace-toleráns), halmazként. */
  private extractTemplateTokens(template: string): Set<string> {
    const tokens = new Set<string>()
    const re = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g
    let match: RegExpExecArray | null
    while ((match = re.exec(template)) !== null) {
      tokens.add(match[1])
    }
    return tokens
  }

  /**
   * Egy lépés kimeneti kontraktusának a KÖVETKEZŐ lépés(ek) input-kontraktusát
   * kell fedni — ugyanaz a `inferStepOutputFields` (routing + `source: 'step'`
   * kötelező input-rések) határozza meg a szükséges mezőket, amit a compiler is
   * használ (§7.3/WP-3), így ez a validáció-réteg SOHA nem térhet el a futásidejű
   * kikényszerítéstől. Két independens kockázatot jelez:
   *  - `OUTPUT_CONTRACT_INCOMPLETE` — a lépés explicit `outputContract`-ja nem
   *    fedi a downstream igényt (a runtime automatikusan pótolja a hiányt, de a
   *    deklaráció ettől még félrevezető/nem önleíró).
   *  - `OUTPUT_CONTRACT_NOT_PROMPTED` — egyik szükséges mező neve sem szerepel a
   *    lépés `instructionTemplate`-jében. A runtime ilyenkor is befűz egy generikus
   *    "adj vissza JSON-t ezekkel a kulcsokkal" rendszerutasítást, de ez a modelltől
   *    függően nem elég erős — pontosan ez okozta az `output_contract_unmet`
   *    elakadást a `payment-provider-engagement-flow` `step-fetch-crm-status`
   *    lépésén (2026-07-06). A szerzőnek a promptban NEVESÍTENIE kell a mezőket.
   */
  private checkOutputContractCoverage(spec: PlaybookSpecV2, warnings: ValidationIssue[]) {
    const inferredOutputs = inferStepOutputFields(spec)

    spec.steps.forEach((step, i) => {
      const explicitFields = readOutputContractFields(step.outputContract)
      const inferredFields = inferredOutputs.get(step.id) ?? []
      const requiredFields = mergeOutputRequiredFields(explicitFields, inferredFields)
      if (requiredFields.length === 0) return

      const missingFromExplicit = inferredFields.filter((f) => !explicitFields.includes(f))
      if (explicitFields.length > 0 && missingFromExplicit.length > 0) {
        warnings.push({
          code: 'OUTPUT_CONTRACT_INCOMPLETE',
          path: `steps[${i}].outputContract`,
          message: `A(z) '${step.id}' explicit outputContract.requiredFields nem tartalmazza a következő lépés(ek) input-kontraktusa miatt szükséges mező(ke)t: ${missingFromExplicit.join(', ')}. A runtime ezt automatikusan pótolja, de érdemes a deklarációt is teljessé tenni.`,
        })
      }

      const template = (step.instructionTemplate ?? '').toLowerCase()
      const notPrompted = requiredFields.filter((f) => !template.includes(f.toLowerCase()))
      if (notPrompted.length > 0) {
        warnings.push({
          code: 'OUTPUT_CONTRACT_NOT_PROMPTED',
          path: `steps[${i}].instructionTemplate`,
          message: `A(z) '${step.id}' lépés kimeneti kontraktusa (a következő lépés input-kontraktusa miatt) megköveteli ezeket a mezőket: ${notPrompted.join(', ')}. Egyik sem szerepel az instructionTemplate szövegében — az agent könnyen figyelmen kívül hagyhatja a strukturált kimenetet, és csak prózában válaszolhat (output_contract_unmet elakadás kockázata). Nevesítsd a mezőket a promptban.`,
        })
      }
    })
  }

  private checkTimeouts(spec: PlaybookSpecV2, warnings: ValidationIssue[]) {
    spec.steps.forEach((step, i) => {
      if (step.timeoutMinutes == null) {
        warnings.push({
          code: 'NO_TIMEOUT',
          path: `steps[${i}]`,
          message: `A(z) '${step.id}' stephez nincs timeout beállítva.`,
        })
      }
    })
  }

  // §6.2 — tenant-kontextus; hiányzó kontextus warningot ad, nem blokkol.
  private checkTenantContext(
    spec: PlaybookSpecV2,
    ctx: TenantValidationContext,
    errors: ValidationIssue[],
    warnings: ValidationIssue[],
  ) {
    if (ctx.knownTicketTypes) {
      spec.steps.forEach((step, i) => {
        if (!ctx.knownTicketTypes!.has(step.ticketType)) {
          if (spec.allowMissingTicketTypes) {
            warnings.push({
              code: 'UNKNOWN_TICKET_TYPE',
              path: `steps[${i}].ticketType`,
              message: `A(z) '${step.ticketType}' ticket-típus ismeretlen (draft allowMissingTicketTypes).`,
            })
          } else {
            errors.push({
              code: 'UNKNOWN_TICKET_TYPE',
              path: `steps[${i}].ticketType`,
              message: `A(z) '${step.ticketType}' ticket-típus nem létezik a tenantban.`,
            })
          }
        }
      })
    }

    if (ctx.agentRoleActiveCounts) {
      spec.roles.forEach((role, i) => {
        if (role.type !== 'agent_role') return
        const count = ctx.agentRoleActiveCounts!.get(role.key) ?? 0
        if (count <= 0) {
          errors.push({
            code: 'NO_ACTIVE_AGENT',
            path: `roles[${i}]`,
            message: `A(z) '${role.key}' agent role-hoz nincs aktív agent.`,
          })
        }
      })
    }

    if (ctx.roleCapabilities) {
      spec.roles.forEach((role, i) => {
        if (role.type !== 'agent_role') return
        const available = ctx.roleCapabilities!.get(role.key) ?? new Set<string>()
        for (const cap of role.requiredCapabilities ?? []) {
          if (!available.has(cap)) {
            errors.push({
              code: 'MISSING_CAPABILITY',
              path: `roles[${i}].requiredCapabilities`,
              message: `A(z) '${role.key}' role nem rendelkezik a(z) '${cap}' capability-vel.`,
            })
          }
        }
      })
    }

    // WP-4 / §4.8 — a requiredCapabilities értékei ismert tool-nevek legyenek.
    if (ctx.knownCapabilities) {
      spec.roles.forEach((role, i) => {
        if (role.type !== 'agent_role') return
        for (const cap of role.requiredCapabilities ?? []) {
          if (!ctx.knownCapabilities!.has(cap)) {
            errors.push({
              code: 'UNKNOWN_CAPABILITY',
              path: `roles[${i}].requiredCapabilities`,
              message: `A(z) '${cap}' capability nem szerepel a tenant capability-szótárában.`,
            })
          }
        }
      })
    }

    if (ctx.knownPermissions) {
      spec.roles.forEach((role, i) => {
        if (role.type !== 'human_role') return
        for (const perm of role.requiredPermissions ?? []) {
          if (!ctx.knownPermissions!.has(perm)) {
            errors.push({
              code: 'UNKNOWN_PERMISSION',
              path: `roles[${i}].requiredPermissions`,
              message: `A(z) '${perm}' permission nem létezik az IAM modellben.`,
            })
          }
        }
      })
    }

    // §6.2 — nincs olyan blocking gate, amelyet senki nem tud jóváhagyni
    spec.gates.forEach((gate, i) => {
      if (!gate.blocking || !gate.requiredActorRole) return
      const role = spec.roles.find((r) => r.key === gate.requiredActorRole)
      if (role?.type === 'agent_role' && gate.type === 'human_approval') {
        errors.push({
          code: 'UNAPPROVABLE_GATE',
          path: `gates[${i}]`,
          message: `A(z) '${gate.id}' human gate-et agent role hagyná jóvá; senki emberi jóváhagyó nincs.`,
        })
      }
    })
  }

  // Hibapolicy spec §8 (WP-5) — a reason-kulcsos hiba-útvonalak minőségi szabályai.
  // Az UNKNOWN_ERROR_REASON-t a séma (stepOutcomeReasonSchema enum) már kikényszeríti
  // SCHEMA_INVALID-ként, ezért itt nincs rá külön szabály.
  private checkErrorRouteQuality(
    spec: PlaybookSpecV2,
    ctx: TenantValidationContext,
    errors: ValidationIssue[],
    warnings: ValidationIssue[],
  ) {
    const gateById = new Map(spec.gates.map((g) => [g.id, g]))

    // DUPLICATE_ERROR_REASON_ROUTE — egy lépésen belül egy reason-höz max. egy hiba-út
    // (onError és onBlocked külön-külön névtere, mert más outcome.status-ra illeszkednek).
    spec.steps.forEach((step, i) => {
      for (const [key, target] of [
        ['onError', step.onError],
        ['onBlocked', step.onBlocked],
      ] as const) {
        const { reasonRoutes } = normalizeErrorTarget(target)
        const seen = new Set<string>()
        for (const route of reasonRoutes) {
          if (!route.reason) continue
          if (seen.has(route.reason)) {
            errors.push({
              code: 'DUPLICATE_ERROR_REASON_ROUTE',
              path: `steps[${i}].${key}.routes`,
              message: `A(z) '${step.id}' lépés '${key}' hiba-ágán a(z) '${route.reason}' reason-höz több útvonal is szerepel.`,
            })
          }
          seen.add(route.reason)
        }
      }
    })

    // CRITICAL_STEP_NO_ERROR_PATH — L2/L3-nak minősülő lépésnek (kritikus required
    // gate vagy kritikus decision-branch) legyen saját, Playbook-default vagy (feloldható)
    // tenant-default hibaága.
    const { error: hasDefaultError, blocked: hasDefaultBlocked } = this.hasResolvedDefaultCoverage(spec, ctx)
    spec.steps.forEach((step, i) => {
      const requiredGateCritical = (step.requiredGateIds ?? []).some((gid) => {
        const gate = gateById.get(gid)
        return gate?.criticality === 'L2' || gate?.criticality === 'L3'
      })
      const decisionCritical = (step.decision?.branches ?? []).some(
        (b) => b.criticality === 'L2' || b.criticality === 'L3',
      )
      if (!requiredGateCritical && !decisionCritical) return

      const errorCovered = step.onError != null || hasDefaultError
      const blockedCovered = step.onBlocked != null || hasDefaultBlocked
      if (!errorCovered || !blockedCovered) {
        warnings.push({
          code: 'CRITICAL_STEP_NO_ERROR_PATH',
          path: `steps[${i}]`,
          message: `A(z) '${step.id}' kritikus (L2/L3) lépésnek nincs saját, Playbook-default vagy tenant-default hibaága — a hiba a beégetett awaiting_human-ra esik vissza.`,
        })
      }
    })

    // DEFAULT_ERROR_TARGET_NOT_BLOCKING_GATE — a default hibaág gate-célja legyen
    // blocking, különben a hibaút néma átfutást engedne (Playbook- ÉS feloldható
    // tenant-default gate-célra is).
    const stepIds = new Set(spec.steps.map((s) => s.id))
    const gateIds = new Set(spec.gates.map((g) => g.id))
    for (const [key, target] of [
      ['defaultErrorPolicy.onError', spec.defaultErrorPolicy?.onError],
      ['defaultErrorPolicy.onBlocked', spec.defaultErrorPolicy?.onBlocked],
      [
        'tenantDefaultErrorPolicy.onError',
        isRoutingTargetResolvable(ctx.tenantDefaultErrorPolicy?.onError, stepIds, gateIds)
          ? ctx.tenantDefaultErrorPolicy?.onError
          : undefined,
      ],
      [
        'tenantDefaultErrorPolicy.onBlocked',
        isRoutingTargetResolvable(ctx.tenantDefaultErrorPolicy?.onBlocked, stepIds, gateIds)
          ? ctx.tenantDefaultErrorPolicy?.onBlocked
          : undefined,
      ],
    ] as const) {
      if (!target?.gateId) continue
      const gate = gateById.get(target.gateId)
      if (gate && !gate.blocking) {
        warnings.push({
          code: 'DEFAULT_ERROR_TARGET_NOT_BLOCKING_GATE',
          path: key,
          message: `A(z) '${target.gateId}' default hiba-él cél-gate nem blocking — a hibaút néma átfutást engedhet.`,
        })
      }
    }
  }

  /** entry-elérhetőséghez és ciklushoz: step → következő stepek (onComplete + transitions). */
  private buildAdjacency(spec: PlaybookSpecV2): Map<string, string[]> {
    const adjacency = new Map<string, string[]>()
    const add = (from: string, to: string) => {
      const list = adjacency.get(from) ?? []
      list.push(to)
      adjacency.set(from, list)
    }
    for (const step of spec.steps) {
      // A decision-blokk desugarolt ágai is valós útvonalak (WP-8) — különben a
      // csak decision-branchen elérhető step tévesen UNREACHABLE lenne.
      for (const rule of desugarDecision(step)) {
        if (rule.nextStepId) add(step.id, rule.nextStepId)
      }
      // A hiba-élek (onError/onBlocked) is elérhetővé teszik a cél-stepet (WP-7),
      // a reason-kulcsos route-ok célja is (hibapolicy spec §5.2 / P2).
      for (const target of [step.onError, step.onBlocked]) {
        const { reasonRoutes, catchAll } = normalizeErrorTarget(target)
        if (catchAll?.nextStepId) add(step.id, catchAll.nextStepId)
        for (const route of reasonRoutes) {
          if (route.nextStepId) add(step.id, route.nextStepId)
        }
      }
    }
    for (const t of spec.transitions) add(t.fromStepId, t.toStepId)
    return adjacency
  }

  // WP-8 §11.4 — Decision Step validáció.
  private checkDecisionSteps(
    spec: PlaybookSpecV2,
    errors: ValidationIssue[],
    warnings: ValidationIssue[],
  ) {
    const gateById = new Map(spec.gates.map((g) => [g.id, g]))

    spec.steps.forEach((step, i) => {
      const decision = step.decision
      if (!decision) return
      const field = decision.field ?? 'decision'

      // OUTPUT_CONTRACT_HAS_DECISION — a döntési mező legyen kötelező kimenet.
      const required = readRequiredFields(step.outputContract)
      if (!required.includes(field)) {
        errors.push({
          code: 'OUTPUT_CONTRACT_HAS_DECISION',
          path: `steps[${i}].outputContract.requiredFields`,
          message: `A(z) '${step.id}' Decision Step outputContract-jának tartalmaznia kell a(z) '${field}' döntési mezőt.`,
        })
      }

      // OUTCOME_BRANCH_REQUIRED — minden allowedOutcome-hoz legyen branch (vagy fallback).
      const branchOutcomes = new Set(decision.branches.map((b) => b.outcome))
      for (const outcome of decision.allowedOutcomes ?? []) {
        if (!branchOutcomes.has(outcome) && !decision.fallback) {
          errors.push({
            code: 'OUTCOME_BRANCH_REQUIRED',
            path: `steps[${i}].decision`,
            message: `A(z) '${outcome}' engedélyezett kimenethez nincs branch és nincs fallback.`,
          })
        }
      }

      // DEFAULT_BRANCH_RECOMMENDED / NO_SILENT_COMPLETE — fallback nélkül a nem-illeszkedő
      // kimenet néma process-complete-et okozhat.
      if (!decision.fallback) {
        warnings.push({
          code: 'NO_SILENT_COMPLETE',
          path: `steps[${i}].decision.fallback`,
          message: `A(z) '${step.id}' Decision Stephez nincs fallback ág — ismeretlen kimenet néma process-lezárást okozhat. Ajánlott egy manual_review gate fallback.`,
        })
      }

      // CRITICAL_BRANCH_GATE_REQUIRED + EVIDENCE_REQUIRED_FOR_HIGH_RISK.
      decision.branches.forEach((b, k) => {
        const critical = b.criticality === 'L2' || b.criticality === 'L3'
        if (!critical) return
        const gate = b.gateId ? gateById.get(b.gateId) : undefined
        if (!gate || !gate.blocking) {
          errors.push({
            code: 'CRITICAL_BRANCH_GATE_REQUIRED',
            path: `steps[${i}].decision.branches[${k}]`,
            message: `A(z) '${b.outcome}' (${b.criticality}) branch csak blocking gate-en át léphet — jelenleg ${gate ? 'nem-blocking gate' : b.nextStepId ? 'közvetlen step' : 'nincs cél'}.`,
          })
        }
        const hasEvidence = b.requiresEvidence || decision.requiresEvidence || decision.evidenceField != null
        if (!hasEvidence) {
          errors.push({
            code: 'EVIDENCE_REQUIRED_FOR_HIGH_RISK',
            path: `steps[${i}].decision.branches[${k}]`,
            message: `A(z) '${b.outcome}' (${b.criticality}) magas kockázatú branch-hez bizonyíték kell (branch.requiresEvidence vagy decision.evidenceField).`,
          })
        }
      })

      // Step-önhivatkozó közvetlen ciklus figyelmeztetés (a referencia-check a létezést fedi).
      for (const b of decision.branches) {
        if (b.nextStepId && b.nextStepId === step.id) {
          warnings.push({
            code: 'DECISION_SELF_LOOP',
            path: `steps[${i}].decision`,
            message: `A(z) '${step.id}' Decision Step egy ága önmagára mutat (${b.outcome}).`,
          })
        }
      }
    })
  }

  /**
   * Hibapolicy spec §4.3/P1 + §4.2/WP-4 — van-e EGYÁLTALÁN default hibaág (Playbook- vagy
   * feloldható tenant-szintű) az egyes ágakra. A tenant-default csak akkor számít lefedettnek,
   * ha a célja (step/gate) ténylegesen létezik EBBEN a Playbookban — különben a compiler is
   * kihagyja, és a beégetett `await_human` marad (§4.3 TE-3).
   */
  private hasResolvedDefaultCoverage(
    spec: PlaybookSpecV2,
    ctx: TenantValidationContext,
  ): { error: boolean; blocked: boolean } {
    const stepIds = new Set(spec.steps.map((s) => s.id))
    const gateIds = new Set(spec.gates.map((g) => g.id))
    const tenantResolvable = (target: RoutingTarget | undefined) =>
      isRoutingTargetResolvable(target, stepIds, gateIds)
    return {
      error:
        spec.defaultErrorPolicy?.onError != null ||
        tenantResolvable(ctx.tenantDefaultErrorPolicy?.onError),
      blocked:
        spec.defaultErrorPolicy?.onBlocked != null ||
        tenantResolvable(ctx.tenantDefaultErrorPolicy?.onBlocked),
    }
  }

  // Hibapolicy spec §4.2/WP-4 — ha a tenant egy olyan step/gate-et vár default hibacélul,
  // ami EBBEN a Playbookban nem létezik, ezt warningként jelezzük (a compiler csendben
  // kihagyja, a beégetett `await_human` marad — nem blokkoljuk a publisht emiatt, §4.2 note).
  private checkTenantDefaultErrorTargets(
    spec: PlaybookSpecV2,
    ctx: TenantValidationContext,
    warnings: ValidationIssue[],
  ) {
    const policy = ctx.tenantDefaultErrorPolicy
    if (!policy) return
    const stepIds = new Set(spec.steps.map((s) => s.id))
    const gateIds = new Set(spec.gates.map((g) => g.id))
    for (const [key, target] of [
      ['tenantDefaultErrorPolicy.onError', policy.onError],
      ['tenantDefaultErrorPolicy.onBlocked', policy.onBlocked],
    ] as const) {
      if (!target) continue
      const missingStep = target.nextStepId != null && !stepIds.has(target.nextStepId)
      const missingGate = target.gateId != null && !gateIds.has(target.gateId)
      if (missingStep || missingGate) {
        warnings.push({
          code: 'TENANT_DEFAULT_ERROR_TARGET_MISSING',
          path: key,
          message: `A tenant hibapolicy '${target.nextStepId ?? target.gateId}' célt vár default hibaágul, de a Playbook nem tartalmazza — a beégetett await_human marad érvényben.`,
        })
      }
    }
  }

  // WP-7 §10.5 — minden nem-terminális step hiba-kimenete kezelt (explicit hiba-él vagy
  // implicit default awaiting_human). Az implicit ág mindig létezik, ezért ez figyelmeztetés,
  // nem blocking-error: jelzi, hogy a step hibája a default emberi felülvizsgálatra megy.
  private checkErrorEdges(
    spec: PlaybookSpecV2,
    ctx: TenantValidationContext,
    _errors: ValidationIssue[],
    warnings: ValidationIssue[],
  ) {
    const transitionSources = new Set(spec.transitions.map((t) => t.fromStepId))
    // Hibapolicy spec §4.3 / P1 + §4.2 / WP-4 — ha VAN Playbook- vagy feloldható
    // tenant-default (mindkét ágra), az a lépés-szintű onError/onBlocked HIÁNYÁBAN is
    // lefedi a hibautat; ekkor nem "implicit awaiting_human" a kimenet, hanem a
    // konfigurált default cél.
    const { error: hasDefaultError, blocked: hasDefaultBlocked } = this.hasResolvedDefaultCoverage(spec, ctx)
    for (let i = 0; i < spec.steps.length; i++) {
      const step = spec.steps[i]!
      if (isTerminalStep(step) && !transitionSources.has(step.id)) continue
      const errorCovered = step.onError != null || hasDefaultError
      const blockedCovered = step.onBlocked != null || hasDefaultBlocked
      if (!errorCovered || !blockedCovered) {
        warnings.push({
          code: 'IMPLICIT_ERROR_EDGE',
          path: `steps[${i}]`,
          message: `A(z) '${step.id}' nem-terminális lépésnek nincs explicit (vagy Playbook-default) onError/onBlocked hiba-éle — a blocked/failed kimenet az implicit default emberi felülvizsgálatra (awaiting_human) megy.`,
        })
      }
    }
  }
}

/** Egy step outputContract.requiredFields listája (üres, ha nincs). */
function readRequiredFields(outputContract?: Record<string, unknown>): string[] {
  const fields = outputContract?.requiredFields
  if (!Array.isArray(fields)) return []
  return fields.filter((f): f is string => typeof f === 'string' && f.length > 0)
}

/** Terminális step: nincs sem happy-path routing (onComplete/decision), sem transition. */
function isTerminalStep(step: PlaybookStep): boolean {
  const hasOnComplete = (step.onComplete ?? []).length > 0
  const hasDecision = step.decision != null
  return !hasOnComplete && !hasDecision
}

/** Kényelmi újraexport, hogy a condition-típus a service rétegben is elérhető legyen. */
export type { ConditionExpression }
