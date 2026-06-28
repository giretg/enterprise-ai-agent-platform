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
  type ConditionExpression,
} from '@/lib/playbook-v2/spec'

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
    this.checkTimeouts(spec, warnings)
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

  /** entry-elérhetőséghez és ciklushoz: step → következő stepek (onComplete + transitions). */
  private buildAdjacency(spec: PlaybookSpecV2): Map<string, string[]> {
    const adjacency = new Map<string, string[]>()
    const add = (from: string, to: string) => {
      const list = adjacency.get(from) ?? []
      list.push(to)
      adjacency.set(from, list)
    }
    for (const step of spec.steps) {
      for (const rule of step.onComplete ?? []) {
        if (rule.nextStepId) add(step.id, rule.nextStepId)
      }
    }
    for (const t of spec.transitions) add(t.fromStepId, t.toStepId)
    return adjacency
  }
}

/** Kényelmi újraexport, hogy a condition-típus a service rétegben is elérhető legyen. */
export type { ConditionExpression }
