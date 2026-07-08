import type { Prisma, Skill, SkillCatalogScope, SkillRiskTier, SkillSourceType } from '@prisma/client'
import type {
  AuditRepository,
  SkillRepository,
  SkillWithVersions,
  ToolBrokerRepository,
} from '@/repositories/interfaces'
import { signSkillVersion } from '@/lib/crypto/hash-chain'
import {
  computeSkillContentHash,
  parseSkillContent,
  parseSkillRequires,
  type SkillContent,
  type SkillRequirement,
} from '@/lib/skill/skill-content'
import { isSkillReadableFromTenant, isSkillWritableFromTenant } from '@/lib/skill/skill-scope'
import { parseSkillMd } from '@/lib/skill/skill-md-adapter'
import { validateSkill, type SkillValidationResult } from '@/lib/skill/skill-validator'
import { computeSkillReadiness, type SkillReadiness } from '@/lib/skill/skill-readiness'
import {
  buildLoadedSkillPrompt,
  buildSkillIndexPrompt,
  resolveLoadableSkill,
  type AssignedSkillEntry,
} from '@/lib/skill/skill-context'
import {
  flattenToolCapabilityGroups,
  PLAYBOOK_CAPABILITY_GROUPS,
} from '@/lib/tool-capability-catalog'

/** A platform által ismert (connectorral kiépíthető) tool-nevek — readiness bázis. */
const KNOWN_TOOL_NAMES = new Set<string>(flattenToolCapabilityGroups(PLAYBOOK_CAPABILITY_GROUPS))

export class SkillAccessError extends Error {
  constructor(message = 'Skill not accessible from this tenant') {
    super(message)
    this.name = 'SkillAccessError'
  }
}

export interface ActorContext {
  actorId: string | null
  actorTenantId: string | null
  isPlatformAdmin: boolean
}

/**
 * Skill-katalógus domain-szolgáltatás (skill-catalog-spec.md). A meglévő
 * write-gate / audit / capability rétegek FÖLÉ épül. Minden cross-tenant felület
 * fail-closed (§D8): idegen tenant skillje sosem olvasható/írható.
 */
export class SkillService {
  constructor(
    private skills: SkillRepository,
    private audit: AuditRepository,
    private toolBroker: ToolBrokerRepository,
  ) {}

  // ── Olvasás (fail-closed scope) ───────────────────────────────────────────

  listForActor(actorTenantId: string | null): Promise<SkillWithVersions[]> {
    return this.skills.listForTenant(actorTenantId)
  }

  /** Fail-closed: null, ha a skill nem olvasható az actor tenantjából. */
  async getReadableSkill(
    actorTenantId: string | null,
    skillId: string,
  ): Promise<SkillWithVersions | null> {
    const skill = await this.skills.findById(skillId)
    if (!skill) return null
    if (!isSkillReadableFromTenant(skill.tenantId, actorTenantId)) return null
    return skill
  }

  // ── Szerzés / verziózás (WP-3, WP-6) ──────────────────────────────────────

  async createSkill(input: {
    name: string
    description: string
    catalogScope: SkillCatalogScope
    tenantId: string | null
    sourceType: SkillSourceType
    provenance: Prisma.InputJsonValue | null
    license: string | null
    riskTier: SkillRiskTier
    content: SkillContent
    requires: SkillRequirement[]
    actor: ActorContext
  }): Promise<{ skill: Skill; versionId: string }> {
    const contentHash = computeSkillContentHash(input.content, input.requires)
    const { skill, version } = await this.skills.createSkill({
      name: input.name,
      description: input.description,
      catalogScope: input.catalogScope,
      tenantId: input.tenantId,
      sourceType: input.sourceType,
      provenance: input.provenance,
      license: input.license,
      riskTier: input.riskTier,
      content: input.content as unknown as Prisma.InputJsonValue,
      requires: input.requires as unknown as Prisma.InputJsonValue,
      contentHash,
    })

    await this.audit.append({
      actorType: input.actor.actorId ? 'human' : 'system',
      actorId: input.actor.actorId,
      agentVersion: null,
      action: input.sourceType === 'imported' ? 'skill.imported' : 'skill.created',
      targetType: 'skill',
      targetId: skill.id,
      modelUsed: null,
      inputRef: skill.name,
      outputRef: `v${version.version}`,
      policyDecision: 'proposed',
      tenantId: skill.tenantId,
      metadata: {
        skillVersionId: version.id,
        riskTier: skill.riskTier,
        catalogScope: skill.catalogScope,
        contentHash,
      },
    })

    return { skill, versionId: version.id }
  }

  /**
   * `SKILL.md` import (WP-2/3). Csak admin. Folyamat: parse → hardcoded validátor
   * (kapu) → tier-levezetés → proposed SkillVersion. A humán jóváhagyás (aktiválás)
   * külön aktus (approveVersion). Kód-jelenlét (T2/T3) esetén a validátor elutasít.
   */
  async importSkillMd(input: {
    raw: string
    sourceUrl?: string
    catalogScope: SkillCatalogScope
    tenantId: string | null
    actor: ActorContext
  }): Promise<
    | { ok: true; skill: Skill; versionId: string; validation: SkillValidationResult }
    | { ok: false; validation: SkillValidationResult }
  > {
    const parsed = parseSkillMd(input.raw, { url: input.sourceUrl })
    const validation = validateSkill({
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      requires: parsed.suggestedRequires,
    })
    if (!validation.ok) {
      return { ok: false, validation }
    }

    const { skill, versionId } = await this.createSkill({
      name: parsed.name,
      description: parsed.description,
      catalogScope: input.catalogScope,
      tenantId: input.catalogScope === 'global' ? null : input.tenantId,
      sourceType: 'imported',
      provenance: parsed.provenance as unknown as Prisma.InputJsonValue,
      license: parsed.license,
      riskTier: validation.riskTier,
      content: parsed.content,
      requires: parsed.suggestedRequires,
      actor: input.actor,
    })

    return { ok: true, skill, versionId, validation }
  }

  /** Meglévő skill új (proposed) verziója — a write-gate kapun megy át. */
  async proposeVersion(input: {
    skillId: string
    content: SkillContent
    requires: SkillRequirement[]
    actor: ActorContext
  }): Promise<{ versionId: string; version: number }> {
    const skill = await this.skills.findById(input.skillId)
    if (!skill) throw new SkillAccessError('Skill not found')
    if (!isSkillWritableFromTenant(skill.tenantId, input.actor.actorTenantId, input.actor.isPlatformAdmin)) {
      throw new SkillAccessError()
    }

    const contentHash = computeSkillContentHash(input.content, input.requires)
    const version = await this.skills.addVersion({
      skillId: input.skillId,
      content: input.content as unknown as Prisma.InputJsonValue,
      requires: input.requires as unknown as Prisma.InputJsonValue,
      contentHash,
    })

    await this.audit.append({
      actorType: input.actor.actorId ? 'human' : 'system',
      actorId: input.actor.actorId,
      agentVersion: null,
      action: 'skill.version.proposed',
      targetType: 'skill',
      targetId: input.skillId,
      modelUsed: null,
      inputRef: null,
      outputRef: `v${version.version}`,
      policyDecision: 'proposed',
      tenantId: skill.tenantId,
      metadata: { skillVersionId: version.id, contentHash },
    })

    return { versionId: version.id, version: version.version }
  }

  // ── Jóváhagyás + aláírás (WP-3, WP-7) ─────────────────────────────────────

  async approveVersion(input: {
    versionId: string
    actor: ActorContext
  }): Promise<{ versionId: string; version: number }> {
    const target = await this.skills.findVersionById(input.versionId)
    if (!target) throw new SkillAccessError('Skill version not found')
    if (!input.actor.actorId) throw new SkillAccessError('Approver required')
    if (
      !isSkillWritableFromTenant(
        target.skill.tenantId,
        input.actor.actorTenantId,
        input.actor.isPlatformAdmin,
      )
    ) {
      throw new SkillAccessError()
    }

    const signature = signSkillVersion({
      skillVersionId: target.id,
      contentHash: target.contentHash,
      approverId: input.actor.actorId,
    })
    const version = await this.skills.approveVersion(input.versionId, {
      approverId: input.actor.actorId,
      signature,
    })

    await this.audit.append({
      actorType: 'human',
      actorId: input.actor.actorId,
      agentVersion: null,
      action: 'skill.version.approved',
      targetType: 'skill',
      targetId: target.skillId,
      modelUsed: null,
      inputRef: input.versionId,
      outputRef: `v${version.version}`,
      policyDecision: 'active',
      tenantId: target.skill.tenantId,
      metadata: { skillVersionId: version.id, contentHash: target.contentHash, signature },
    })

    return { versionId: version.id, version: version.version }
  }

  /** Rollback egy korábbi verzióra (WP-7/D12). */
  async rollbackToVersion(input: {
    versionId: string
    actor: ActorContext
  }): Promise<{ versionId: string; version: number }> {
    const target = await this.skills.findVersionById(input.versionId)
    if (!target) throw new SkillAccessError('Skill version not found')
    if (!input.actor.actorId) throw new SkillAccessError('Approver required')
    if (
      !isSkillWritableFromTenant(
        target.skill.tenantId,
        input.actor.actorTenantId,
        input.actor.isPlatformAdmin,
      )
    ) {
      throw new SkillAccessError()
    }

    const signature = signSkillVersion({
      skillVersionId: target.id,
      contentHash: target.contentHash,
      approverId: input.actor.actorId,
    })
    const version = await this.skills.rollbackToVersion(input.versionId, {
      approverId: input.actor.actorId,
      signature,
    })

    await this.audit.append({
      actorType: 'human',
      actorId: input.actor.actorId,
      agentVersion: null,
      action: 'skill.rolled_back',
      targetType: 'skill',
      targetId: target.skillId,
      modelUsed: null,
      inputRef: input.versionId,
      outputRef: `v${version.version}`,
      policyDecision: 'active',
      tenantId: target.skill.tenantId,
      metadata: { skillVersionId: version.id },
    })

    return { versionId: version.id, version: version.version }
  }

  // ── Hozzárendelés + readiness (WP-4) ──────────────────────────────────────

  async assign(input: {
    agentId: string
    skillVersionId: string
    actor: ActorContext
  }): Promise<void> {
    const target = await this.skills.findVersionById(input.skillVersionId)
    if (!target) throw new SkillAccessError('Skill version not found')
    // Csak olvasható skill rendelhető hozzá (global vagy saját tenant).
    if (!isSkillReadableFromTenant(target.skill.tenantId, input.actor.actorTenantId)) {
      throw new SkillAccessError()
    }
    if (target.status !== 'active') {
      throw new SkillAccessError('Only an active skill version can be assigned')
    }

    await this.skills.assign({
      agentId: input.agentId,
      skillVersionId: input.skillVersionId,
      assignedById: input.actor.actorId,
    })

    await this.audit.append({
      actorType: input.actor.actorId ? 'human' : 'system',
      actorId: input.actor.actorId,
      agentVersion: null,
      action: 'skill.assigned',
      targetType: 'agent',
      targetId: input.agentId,
      modelUsed: null,
      inputRef: target.skillId,
      outputRef: input.skillVersionId,
      policyDecision: 'active',
      tenantId: input.actor.actorTenantId,
      metadata: { skillId: target.skillId, skillVersionId: input.skillVersionId },
    })
  }

  async unassign(input: {
    agentId: string
    skillVersionId: string
    actor: ActorContext
  }): Promise<void> {
    await this.skills.unassign(input.agentId, input.skillVersionId)

    await this.audit.append({
      actorType: input.actor.actorId ? 'human' : 'system',
      actorId: input.actor.actorId,
      agentVersion: null,
      action: 'skill.unassigned',
      targetType: 'agent',
      targetId: input.agentId,
      modelUsed: null,
      inputRef: null,
      outputRef: input.skillVersionId,
      policyDecision: 'active',
      tenantId: input.actor.actorTenantId,
      metadata: { skillVersionId: input.skillVersionId },
    })
  }

  setEnabled(input: { agentId: string; skillVersionId: string; enabled: boolean }) {
    return this.skills.setEnabled(input.agentId, input.skillVersionId, input.enabled)
  }

  // ── Context-assembler (progresszív betöltés, WP-5) ────────────────────────

  /** Az agenthez rendelt, enabled skillek Level-0 index-bejegyzései (D2/D7). */
  async getAssignedSkillIndex(agentId: string): Promise<AssignedSkillEntry[]> {
    const rows = await this.skills.listEnabledForAgent(agentId)
    return rows.map((a) => ({
      skillId: a.skillVersion.skill.id,
      skillVersionId: a.skillVersionId,
      name: a.skillVersion.skill.name,
      description: a.skillVersion.skill.description,
      version: a.skillVersion.version,
    }))
  }

  /** Level-0 index rendszer-üzenet szöveg (üres, ha nincs hozzárendelt skill). */
  async buildSkillIndexPrompt(agentId: string): Promise<string> {
    return buildSkillIndexPrompt(await this.getAssignedSkillIndex(agentId))
  }

  /**
   * `load_skill` végrehajtás (D7). Fail-closed, deny-by-default: CSAK a
   * ténylegesen hozzárendelt (enabled) skill-verzió tölthető be. A betöltés
   * `skill.loaded` auditált esemény. Nem hozzárendelt id → deny (null-szerű error
   * eredmény), audit `skill.access_denied`.
   */
  async loadSkillForAgent(input: {
    agentId: string
    skillVersionId: string
    actor: ActorContext
  }): Promise<{ ok: true; instructions: string } | { ok: false; reason: string }> {
    const index = await this.getAssignedSkillIndex(input.agentId)
    const entry = resolveLoadableSkill(index, input.skillVersionId)
    if (!entry) {
      await this.audit.append({
        actorType: 'agent',
        actorId: input.agentId,
        agentVersion: null,
        action: 'skill.access_denied',
        targetType: 'agent',
        targetId: input.agentId,
        modelUsed: null,
        inputRef: input.skillVersionId,
        outputRef: 'denied',
        policyDecision: 'deny',
        tenantId: input.actor.actorTenantId,
        metadata: { skillVersionId: input.skillVersionId, reason: 'not_assigned' },
      })
      return { ok: false, reason: 'A skill nincs ehhez az agenthez rendelve (deny-by-default).' }
    }

    const version = await this.skills.findVersionById(input.skillVersionId)
    if (!version) return { ok: false, reason: 'A skill-verzió nem található.' }
    const content = parseSkillContent(version.content)

    await this.audit.append({
      actorType: 'agent',
      actorId: input.agentId,
      agentVersion: null,
      action: 'skill.loaded',
      targetType: 'skill',
      targetId: entry.skillId,
      modelUsed: null,
      inputRef: input.skillVersionId,
      outputRef: `v${entry.version}`,
      policyDecision: 'allow',
      tenantId: input.actor.actorTenantId,
      metadata: { skillVersionId: input.skillVersionId, skillId: entry.skillId },
    })

    return { ok: true, instructions: buildLoadedSkillPrompt(entry, content) }
  }

  /**
   * Futásidejű snapshot (D9/D12): az agenthez futáskor aktív, enabled
   * skill-verzió-id-k — a futás reprodukálhatóságához rögzítendő.
   */
  async getRunSkillSnapshot(agentId: string): Promise<string[]> {
    const rows = await this.skills.listEnabledForAgent(agentId)
    return rows.map((a) => a.skillVersionId)
  }

  /**
   * Readiness a skill `requires` igényei és az agent capability-i alapján
   * (§D10). Csak jelez — jogot nem ad.
   */
  async readinessForVersion(agentId: string, skillVersionId: string): Promise<SkillReadiness> {
    const target = await this.skills.findVersionById(skillVersionId)
    if (!target) throw new SkillAccessError('Skill version not found')
    const requires = parseSkillRequires(target.requires)
    const caps = await this.toolBroker.findCapabilitiesForAgent(agentId)
    const allowedTools = new Set(caps.filter((c) => c.allowed).map((c) => c.toolName))
    return computeSkillReadiness(requires, { allowedTools, knownTools: KNOWN_TOOL_NAMES })
  }

  /** Az agenthez rendelt skillek listája readiness-szel együtt (agent-detail panel). */
  async listAgentSkillsWithReadiness(agentId: string) {
    const assignments = await this.skills.listAgentSkills(agentId)
    const caps = await this.toolBroker.findCapabilitiesForAgent(agentId)
    const allowedTools = new Set(caps.filter((c) => c.allowed).map((c) => c.toolName))
    return assignments.map((a) => {
      const requires = parseSkillRequires(a.skillVersion.requires)
      const readiness = computeSkillReadiness(requires, { allowedTools, knownTools: KNOWN_TOOL_NAMES })
      return {
        agentId: a.agentId,
        skillVersionId: a.skillVersionId,
        enabled: a.enabled,
        skillId: a.skillVersion.skill.id,
        name: a.skillVersion.skill.name,
        description: a.skillVersion.skill.description,
        version: a.skillVersion.version,
        riskTier: a.skillVersion.skill.riskTier,
        content: parseSkillContent(a.skillVersion.content),
        requires,
        readiness,
      }
    })
  }
}
