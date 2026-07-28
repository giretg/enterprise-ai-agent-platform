/**
 * ProcessDefinitionService (Folyamat-feature-spec §4.1, §4.5, §4.8, §4.11, §5.B).
 *
 * A Folyamat (2. szint) életciklusa: draft létrehozás publikált Playbook-verzióra
 * PIN-elve, szerep→agent kötés + config-rés szerkesztés, trigger csatolás/leválasztás,
 * és aktiválás a MEGELŐZŐ KAPUVAL (alkalmasság, kötelező config-rés, human-role
 * permission, cron-feloldhatóság triggerenként). A verzió-áthúzás draftba visz vissza.
 *
 * A szerep→agent kötés a Folyamaton él (§1.2) — ez a futásidejű feloldás EGYETLEN
 * forrása (a tenant-roster elhalt, §4.2). Az itteni kapu garantálja, hogy aktiváláskor
 * minden kötelező szerephez alkalmas agent van kötve.
 */
import type { Prisma, ProcessDefinition, ProcessTrigger } from '@prisma/client'
import type { CompiledSpec, CompiledInputSlot } from '@/domain/playbook/playbook-compiler'
import { parsePlaybookSpecV2, type PlaybookRole } from '@/lib/playbook-v2/spec'
import { isAgentSuitable } from '@/domain/playbook/suitability'
import { meetsMinRole } from '@/lib/iam-policy'
import type {
  AgentRepository,
  AuditRepository,
  PlaybookV2Repository,
  ProcessDefinitionRepository,
  ProcessDefinitionWithTriggers,
  RolePermissionRepository,
  ToolBrokerRepository,
  UserRepository,
} from '@/repositories/interfaces'

export type ProcessDefinitionServiceErrorCode =
  | 'NOT_FOUND_OR_FORBIDDEN'
  | 'VERSION_NOT_PUBLISHED'
  | 'COMPILED_SPEC_MISSING'
  | 'INVALID_STATE'
  | 'GATE_FAILED'

export class ProcessDefinitionServiceError extends Error {
  constructor(
    readonly code: ProcessDefinitionServiceErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ProcessDefinitionServiceError'
  }
}

/** A megelőző kapu egy-egy megbukott ellenőrzése (a hiba `details`-ébe kerül). */
export type GateViolation = { code: string; message: string }

type Actor = { userId: string }

export class ProcessDefinitionService {
  constructor(
    private readonly defs: ProcessDefinitionRepository,
    private readonly playbooks: PlaybookV2Repository,
    private readonly agents: AgentRepository,
    private readonly toolBroker: ToolBrokerRepository,
    private readonly rolePermissions: RolePermissionRepository,
    private readonly users: UserRepository,
    private readonly audit: AuditRepository,
  ) {}

  // --- §4.1, §5.B — draft létrehozás publikált verzióra PIN-elve -------------

  async createDraft(input: {
    tenantId: string | null
    name: string
    description?: string | null
    playbookVersionId: string
    createdBy: Actor
  }): Promise<ProcessDefinition> {
    const version = await this.playbooks.findVersion(input.tenantId, input.playbookVersionId)
    if (!version) {
      throw new ProcessDefinitionServiceError(
        'NOT_FOUND_OR_FORBIDDEN',
        'A Playbook-verzió nem található vagy nincs jogosultság.',
      )
    }
    if (version.status !== 'published') {
      throw new ProcessDefinitionServiceError(
        'VERSION_NOT_PUBLISHED',
        'Folyamat csak PUBLIKÁLT Playbook-verzióra PIN-elhető.',
      )
    }
    const def = await this.defs.create({
      tenantId: input.tenantId,
      name: input.name,
      description: input.description ?? null,
      playbookId: version.playbookId,
      playbookVersionId: version.id,
      createdById: input.createdBy.userId,
    })
    await this.append(input.tenantId, input.createdBy.userId, {
      action: 'process_definition.create',
      targetId: def.id,
      metadata: {
        process_definition_id: def.id,
        playbook_id: version.playbookId,
        playbook_version_id: version.id,
      },
    })
    return def
  }

  // --- §4.1 — szerep-kötés + config-rés szerkesztése (csak draftban) ---------

  async updateBindings(input: {
    tenantId: string | null
    processDefinitionId: string
    roleBindings: Record<string, string>
    configValues: Record<string, unknown>
    actorUserId: string
  }): Promise<ProcessDefinition> {
    const def = await this.requireDef(input.tenantId, input.processDefinitionId)
    if (def.status !== 'draft') {
      throw new ProcessDefinitionServiceError(
        'INVALID_STATE',
        `Kötés csak draft Folyamaton szerkeszthető (jelenlegi: ${def.status}).`,
      )
    }
    const updated = await this.defs.update(def.id, {
      roleBindings: input.roleBindings as Prisma.InputJsonValue,
      configValues: input.configValues as Prisma.InputJsonValue,
    })
    await this.append(input.tenantId, input.actorUserId, {
      action: 'process_definition.update_bindings',
      targetId: def.id,
      metadata: {
        process_definition_id: def.id,
        role_keys: Object.keys(input.roleBindings),
        config_keys: Object.keys(input.configValues),
      },
    })
    return updated
  }

  // --- §4.4, §4.5 — trigger csatolás (monitor_cron esetén cron-kapu) ---------

  async attachTrigger(input: {
    tenantId: string | null
    processDefinitionId: string
    type: ProcessTrigger['type']
    inputMap: Record<string, unknown>
    monitorDefinitionId?: string | null
    actorUserId: string
  }): Promise<ProcessTrigger> {
    const def = await this.requireDef(input.tenantId, input.processDefinitionId)
    if (def.status === 'archived') {
      throw new ProcessDefinitionServiceError('INVALID_STATE', 'Archivált Folyamathoz nem köthető trigger.')
    }

    // §4.5 megelőző cron-kapu: a monitor_cron minden kötelező trigger-rését ember
    // nélkül fel kell tudni oldani az inputMap.contextMap-ből.
    if (input.type === 'monitor_cron') {
      const compiled = await this.loadCompiled(def)
      const violations = this.checkCronResolvability(compiled, input.inputMap)
      if (violations.length > 0) {
        throw new ProcessDefinitionServiceError(
          'GATE_FAILED',
          'A Monitor-cron trigger nem csatolható: van ember nélkül feloldhatatlan kötelező rés.',
          violations,
        )
      }
    }

    const trigger = await this.defs.createTrigger({
      tenantId: input.tenantId,
      processDefinitionId: def.id,
      type: input.type,
      inputMap: input.inputMap as Prisma.InputJsonValue,
      monitorDefinitionId: input.monitorDefinitionId ?? null,
      createdById: input.actorUserId,
    })
    await this.append(input.tenantId, input.actorUserId, {
      action: 'process_definition.attach_trigger',
      targetId: def.id,
      metadata: {
        process_definition_id: def.id,
        trigger_id: trigger.id,
        trigger_type: input.type,
      },
    })
    return trigger
  }

  async detachTrigger(input: {
    tenantId: string | null
    processDefinitionId: string
    triggerId: string
    actorUserId: string
  }): Promise<void> {
    const def = await this.requireDef(input.tenantId, input.processDefinitionId)
    const trigger = await this.defs.findTrigger(input.tenantId, input.triggerId)
    if (!trigger || trigger.processDefinitionId !== def.id) {
      throw new ProcessDefinitionServiceError('NOT_FOUND_OR_FORBIDDEN', 'A trigger nem található.')
    }
    await this.defs.deleteTrigger(trigger.id)
    await this.append(input.tenantId, input.actorUserId, {
      action: 'process_definition.detach_trigger',
      targetId: def.id,
      metadata: { process_definition_id: def.id, trigger_id: trigger.id },
    })
  }

  // --- §4.1, §5.B/4 — aktiválás a TELJES megelőző kapuval --------------------

  async activate(input: {
    tenantId: string | null
    processDefinitionId: string
    actorUserId: string
  }): Promise<ProcessDefinition> {
    const def = await this.requireDef(input.tenantId, input.processDefinitionId)
    if (def.status === 'archived') {
      throw new ProcessDefinitionServiceError('INVALID_STATE', 'Archivált Folyamat nem aktiválható.')
    }

    const violations = await this.runActivationGate(def)
    if (violations.length > 0) {
      throw new ProcessDefinitionServiceError(
        'GATE_FAILED',
        'A Folyamat nem aktiválható: a megelőző kapu hibát talált.',
        violations,
      )
    }

    const updated = await this.defs.update(def.id, {
      status: 'active',
      approvedById: input.actorUserId,
      approvedAt: new Date(),
    })
    await this.append(input.tenantId, input.actorUserId, {
      action: 'process_definition.activate',
      targetId: def.id,
      policyDecision: 'active',
      metadata: {
        process_definition_id: def.id,
        playbook_version_id: def.playbookVersionId,
      },
    })
    return updated
  }

  async archive(input: {
    tenantId: string | null
    processDefinitionId: string
    actorUserId: string
  }): Promise<ProcessDefinition> {
    const def = await this.requireDef(input.tenantId, input.processDefinitionId)
    const updated = await this.defs.update(def.id, { status: 'archived', archivedAt: new Date() })
    await this.append(input.tenantId, input.actorUserId, {
      action: 'process_definition.archive',
      targetId: def.id,
      policyDecision: 'archived',
      metadata: { process_definition_id: def.id },
    })
    return updated
  }

  /**
   * Aktív Folyamat cseréje: új példány a módosításokkal, a régi archiválása.
   * A futó Futások érintetlenek maradnak (saját PIN-elt verzióval).
   */
  async replaceActiveDefinition(input: {
    tenantId: string | null
    sourceProcessDefinitionId: string
    roleBindings: Record<string, string>
    configValues: Record<string, unknown>
    triggerType: ProcessTrigger['type']
    triggerInputMap: Record<string, unknown>
    monitorDefinitionId?: string | null
    actorUserId: string
    activateNew: boolean
  }): Promise<{ newDefinition: ProcessDefinition; supersededDefinitionId: string; activated: boolean }> {
    const source = await this.requireDef(input.tenantId, input.sourceProcessDefinitionId)
    if (source.status !== 'active') {
      throw new ProcessDefinitionServiceError(
        'INVALID_STATE',
        `Csak aktív Folyamat cserélhető így (jelenlegi: ${source.status}).`,
      )
    }

    const created = await this.defs.create({
      tenantId: source.tenantId,
      name: source.name,
      description: source.description,
      playbookId: source.playbookId,
      playbookVersionId: source.playbookVersionId,
      createdById: input.actorUserId,
    })

    await this.defs.update(created.id, {
      roleBindings: input.roleBindings as Prisma.InputJsonValue,
      configValues: input.configValues as Prisma.InputJsonValue,
    })

    await this.attachTrigger({
      tenantId: input.tenantId,
      processDefinitionId: created.id,
      type: input.triggerType,
      inputMap: input.triggerInputMap,
      monitorDefinitionId: input.monitorDefinitionId ?? null,
      actorUserId: input.actorUserId,
    })

    let activated = false
    if (input.activateNew) {
      const withTriggers = await this.requireDef(input.tenantId, created.id)
      const violations = await this.runActivationGate(withTriggers)
      if (violations.length > 0) {
        throw new ProcessDefinitionServiceError(
          'GATE_FAILED',
          'Az új Folyamat nem aktiválható: a megelőző kapu hibát talált.',
          violations,
        )
      }
      await this.defs.update(created.id, {
        status: 'active',
        approvedById: input.actorUserId,
        approvedAt: new Date(),
      })
      activated = true
      await this.append(input.tenantId, input.actorUserId, {
        action: 'process_definition.activate',
        targetId: created.id,
        policyDecision: 'active',
        metadata: {
          process_definition_id: created.id,
          playbook_version_id: created.playbookVersionId,
          replaced_definition_id: source.id,
        },
      })
    }

    await this.archive({
      tenantId: input.tenantId,
      processDefinitionId: source.id,
      actorUserId: input.actorUserId,
    })

    const newDefinition = await this.requireDef(input.tenantId, created.id)
    await this.append(input.tenantId, input.actorUserId, {
      action: 'process_definition.replace_active',
      targetId: newDefinition.id,
      metadata: {
        new_process_definition_id: newDefinition.id,
        superseded_process_definition_id: source.id,
        activated,
      },
    })

    return {
      newDefinition,
      supersededDefinitionId: source.id,
      activated,
    }
  }

  // --- §4.10 — verzió-áthúzás = szerkesztés + újra-jóváhagyás ----------------

  async rebindToVersion(input: {
    tenantId: string | null
    processDefinitionId: string
    newPlaybookVersionId: string
    actorUserId: string
  }): Promise<ProcessDefinition> {
    const def = await this.requireDef(input.tenantId, input.processDefinitionId)
    const version = await this.playbooks.findVersion(input.tenantId, input.newPlaybookVersionId)
    if (!version) {
      throw new ProcessDefinitionServiceError('NOT_FOUND_OR_FORBIDDEN', 'A cél Playbook-verzió nem található.')
    }
    if (version.status !== 'published') {
      throw new ProcessDefinitionServiceError('VERSION_NOT_PUBLISHED', 'Csak publikált verzióra húzható át.')
    }
    if (version.playbookId !== def.playbookId) {
      throw new ProcessDefinitionServiceError('INVALID_STATE', 'A cél verzió másik Playbookhoz tartozik.')
    }
    // Az új verzió új szereplőket/réseket hozhat → draftba vissza, jóváhagyás törlődik.
    const updated = await this.defs.update(def.id, {
      playbookVersionId: version.id,
      status: 'draft',
      approvedById: null,
      approvedAt: null,
    })
    await this.append(input.tenantId, input.actorUserId, {
      action: 'process_definition.rebind_version',
      targetId: def.id,
      metadata: {
        process_definition_id: def.id,
        new_playbook_version_id: version.id,
      },
    })
    return updated
  }

  async getDefinition(tenantId: string | null, id: string): Promise<ProcessDefinitionWithTriggers> {
    return this.requireDef(tenantId, id)
  }

  async listDefinitions(
    tenantId: string | null,
    status?: ProcessDefinition['status'],
  ): Promise<ProcessDefinitionWithTriggers[]> {
    return this.defs.list(tenantId, status)
  }

  // --- Megelőző kapu (§4.5, §4.8) — tesztelhető darabokban -------------------

  /** A TELJES aktiválási kapu: alkalmasság + kötelező config-rés + human permission. */
  async runActivationGate(def: ProcessDefinitionWithTriggers): Promise<GateViolation[]> {
    const violations: GateViolation[] = []
    const version = await this.playbooks.findVersion(def.tenantId, def.playbookVersionId)
    if (!version) {
      return [{ code: 'VERSION_MISSING', message: 'A PIN-elt Playbook-verzió nem található.' }]
    }
    const spec = parsePlaybookSpecV2(version.spec)
    const roleBindings = this.asStringRecord(def.roleBindings)

    // §4.8 — agent-szerepek: kötött + alkalmas agent.
    for (const role of spec.roles) {
      if (role.type !== 'agent_role') continue
      const agentId = roleBindings[role.key]
      if (!agentId) {
        violations.push({
          code: 'ROLE_UNBOUND',
          message: `A(z) '${role.key}' agent-szerephez nincs agent kötve.`,
        })
        continue
      }
      const suitability = await this.checkBoundAgent(def.tenantId, agentId, role)
      if (!suitability.ok) {
        violations.push({
          code: 'AGENT_UNSUITABLE',
          message: `A(z) '${role.key}' szerephez kötött agent alkalmatlan: ${suitability.reason}`,
        })
      }
    }

    // §4.3, §4.8 — human-szerepek: kötött + aktív user + requiredPermissions.
    const humanRoles = spec.roles.filter((role) => role.type === 'human_role')
    const humanUserIds = [
      ...new Set(
        humanRoles
          .map((role) => roleBindings[role.key])
          .filter((id): id is string => Boolean(id)),
      ),
    ]
    const usersById = new Map(
      (await this.users.findManyByIds(humanUserIds)).map((user) => [user.id, user] as const),
    )
    const permissionKeys = [
      ...new Set(humanRoles.flatMap((role) => role.requiredPermissions ?? [])),
    ]
    const permissionsByKey = new Map(
      (await this.rolePermissions.findByKeys(permissionKeys)).map(
        (perm) => [perm.permissionKey, perm] as const,
      ),
    )

    for (const role of humanRoles) {
      const userId = roleBindings[role.key]
      if (!userId) {
        violations.push({
          code: 'HUMAN_ROLE_UNBOUND',
          message: `A(z) '${role.key}' emberi szerephez nincs user kötve.`,
        })
        continue
      }
      const user = usersById.get(userId)
      if (!user) {
        violations.push({
          code: 'HUMAN_USER_UNSUITABLE',
          message: `A(z) '${role.key}' szerephez kötött user nem található.`,
        })
        continue
      }
      if (user.status !== 'active' || !user.role) {
        violations.push({
          code: 'HUMAN_USER_UNSUITABLE',
          message: `A(z) '${role.key}' szerephez kötött user nem aktív vagy nincs platform szerepe.`,
        })
        continue
      }
      for (const perm of role.requiredPermissions ?? []) {
        const known = permissionsByKey.get(perm)
        if (!known) {
          violations.push({
            code: 'UNKNOWN_PERMISSION',
            message: `A(z) '${role.key}' szerep '${perm}' jogosultsága nem létezik az IAM modellben.`,
          })
          continue
        }
        if (!meetsMinRole(user.role, known.minRole)) {
          violations.push({
            code: 'HUMAN_USER_INSUFFICIENT_PERMISSION',
            message: `A(z) '${role.key}' szerephez kötött user nem éri el a(z) '${perm}' jogosultság minimum szerepét (${known.minRole}).`,
          })
        }
      }
    }

    return violations
  }

  /** §4.5 cron-kapu: minden kötelező TRIGGER-rés feloldható-e ember nélkül. */
  checkCronResolvability(
    compiled: CompiledSpec,
    inputMap: Record<string, unknown>,
  ): GateViolation[] {
    const contextMap = this.asRecord(
      (inputMap.contextMap as unknown) ?? {},
    )
    const violations: GateViolation[] = []
    for (const slot of this.uniqueSlots(compiled, 'trigger')) {
      if (!slot.required) continue
      const source = contextMap[slot.name]
      if (source === undefined || source === null || source === '') {
        violations.push({
          code: 'CRON_SLOT_UNRESOLVABLE',
          message: `A(z) '${slot.name}' kötelező trigger-rés ember nélkül nem oldható fel (nincs contextMap bejegyzés).`,
        })
      }
    }
    return violations
  }

  private async checkBoundAgent(
    defTenantId: string | null,
    agentId: string,
    role: PlaybookRole,
  ): Promise<ReturnType<typeof isAgentSuitable>> {
    const agent = await this.agents.findById(agentId)
    if (!agent) {
      return { ok: false, reason: 'a kötött agent nem található.', missing: [] }
    }
    const capabilities = await this.toolBroker.findCapabilitiesForAgent(agentId)
    // A tenant-határt a Folyamat tenantjához (defTenantId) mérjük, NEM az agent saját
    // tenantjához — különben a cross-tenant kötés önmagával egyezne és sosem bukna el.
    return isAgentSuitable(
      { status: agent.status, tenantId: agent.tenantId, capabilities },
      { requiredCapabilities: role.requiredCapabilities },
      defTenantId,
    )
  }

  /** Egy adott forrású rések a compiled ticketRules-ből, névre deduplikálva. */
  private uniqueSlots(compiled: CompiledSpec, source: 'config' | 'trigger'): CompiledInputSlot[] {
    const byName = new Map<string, CompiledInputSlot>()
    for (const rule of compiled.ticketRules) {
      for (const slot of rule.inputSlots ?? []) {
        if (slot.source !== source) continue
        const existing = byName.get(slot.name)
        // ha bármelyik előfordulás kötelező, kötelezőként tartjuk nyilván
        if (!existing || (slot.required && !existing.required)) byName.set(slot.name, slot)
      }
    }
    return [...byName.values()]
  }

  // --- Belső segédek ---------------------------------------------------------

  private async requireDef(
    tenantId: string | null,
    id: string,
  ): Promise<ProcessDefinitionWithTriggers> {
    const def = await this.defs.findById(tenantId, id)
    if (!def) {
      throw new ProcessDefinitionServiceError(
        'NOT_FOUND_OR_FORBIDDEN',
        'A Folyamat nem található vagy nincs jogosultság.',
      )
    }
    return def
  }

  private async loadCompiled(def: ProcessDefinition): Promise<CompiledSpec> {
    const version = await this.playbooks.findVersion(def.tenantId, def.playbookVersionId)
    return this.requireCompiled(version?.compiledSpec)
  }

  private requireCompiled(compiledSpec: unknown): CompiledSpec {
    if (!compiledSpec || typeof compiledSpec !== 'object') {
      throw new ProcessDefinitionServiceError(
        'COMPILED_SPEC_MISSING',
        'A PIN-elt verziónak nincs compiled spec-je.',
      )
    }
    return compiledSpec as CompiledSpec
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  }

  private asStringRecord(value: unknown): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.asRecord(value))) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  }

  private async append(
    tenantId: string | null,
    actorUserId: string,
    entry: {
      action: string
      targetId: string
      policyDecision?: string | null
      metadata?: Record<string, unknown>
    },
  ) {
    await this.audit.append({
      actorType: 'human',
      actorId: actorUserId,
      agentVersion: null,
      action: entry.action,
      targetType: 'process_definition',
      targetId: entry.targetId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: entry.policyDecision ?? null,
      metadata: { tenantId, ...(entry.metadata ?? {}) },
    })
  }
}
