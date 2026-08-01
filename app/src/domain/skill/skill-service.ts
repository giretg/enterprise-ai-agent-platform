import type { Prisma, Skill, SkillCatalogScope, SkillRiskTier, SkillSourceType } from '@prisma/client'
import type {
  AuditRepository,
  AgentSkillMigration,
  ConversationRepository,
  SkillRepository,
  SkillWithVersions,
  ToolBrokerRepository,
} from '@/repositories/interfaces'
import {
  conversationMessagesToTurns,
  deriveRequiresFromToolCalls,
} from '@/lib/skill/skill-distill-transcript'
import {
  SkillDistillerAgent,
  type SkillDistillDraft,
} from '@/domain/skill/skill-distiller-agent'
import {
  SkillReviewAgent,
  type SkillAdvisoryReview,
} from '@/domain/skill/skill-review-agent'
import { signSkillVersion } from '@/lib/crypto/hash-chain'
import { normalizeSkillName } from '@/lib/skill/skill-name'
import {
  aggregateSkillRuntimeHints,
  computeSkillContentHash,
  parseSkillContent,
  parseSkillRequires,
  skillAllowsAttachments,
  type SkillContent,
  type SkillParameter,
  type SkillRequirement,
  type SkillRuntimeHints,
} from '@/lib/skill/skill-content'
import { isSkillReadableFromTenant, isSkillWritableFromTenant } from '@/lib/skill/skill-scope'
import { isAgentReachableFromTenant } from '@/lib/tenant-reachability'
import { parseSkillMd } from '@/lib/skill/skill-md-adapter'
import { validateSkill, type SkillValidationResult } from '@/lib/skill/skill-validator'
import { computeSkillReadiness, type SkillReadiness } from '@/lib/skill/skill-readiness'
import {
  buildLoadedSkillPrompt,
  buildSkillIndexPrompt,
  resolveLoadableSkill,
  type AssignedSkillEntry,
} from '@/lib/skill/skill-context'
import { parseSkillSlashCommands } from '@/lib/skill/skill-slash-command'
import {
  flattenToolCapabilityGroups,
  PLAYBOOK_CAPABILITY_GROUPS,
} from '@/lib/tool-capability-catalog'
import type { TenantLanguage } from '@/lib/tenant-language'

/** A platform által ismert (connectorral kiépíthető) tool-nevek — readiness bázis. */
const KNOWN_TOOL_NAMES = new Set<string>(flattenToolCapabilityGroups(PLAYBOOK_CAPABILITY_GROUPS))

export class SkillAccessError extends Error {
  constructor(message = 'Skill not accessible from this tenant') {
    super(message)
    this.name = 'SkillAccessError'
  }
}

/**
 * Skill-előtöltés eredménye. A `blocked` a futásidejű readiness-kapun elakadt
 * skilleket viszi vissza a hívónak — a chat ebből mond konkrét, cselekvésre
 * fordítható hibaüzenetet ahelyett, hogy a skill nélkül, csendben elindulna.
 * A `requiredTools` a betöltött skillek `allowed-tools` uniója: ez szűkíti a
 * forduló eszköz-hatókörét (undefined = nincs szűkítés).
 */
export interface SkillPreloadResult {
  preloadedPrompts: string[]
  loadedSkillNames: string[]
  loadedSkillVersionIds: string[]
  blocked: Array<{ name: string; missingTools: string[]; reason: string }>
  requiredTools?: string[]
  runtimeHints?: SkillRuntimeHints
  /**
   * A ténylegesen betöltött skillek DEKLARÁLT paraméterei (#199), betöltési
   * sorrendben, névre deduplikálva. Ebből köti a feladat-runtime a ticketen
   * megadott paraméter-ÉRTÉKEKHEZ a leírásokat.
   */
  parameters?: SkillParameter[]
}

export interface ActorContext {
  actorId: string | null
  actorTenantId: string | null
  isPlatformAdmin: boolean
}

/**
 * Minimális agent-feloldó a skill→agent kötések tenant-határának betartatásához.
 * A teljes {@link AgentRepository} helyett csak a `tenantId`-t igénylő olvasás kell.
 */
export interface SkillAgentLookup {
  findById(id: string): Promise<{ tenantId: string | null } | null>
}

/**
 * Skill-katalógus domain-szolgáltatás (skill-catalog-spec.md). A meglévő
 * write-gate / audit / capability rétegek FÖLÉ épül. Minden cross-tenant felület
 * fail-closed (§D8): idegen tenant skillje sosem olvasható/írható.
 */
export type SkillDistillResult =
  | {
      ok: true
      skillId: string
      versionId: string
      riskTier: SkillRiskTier
      draft: SkillDistillDraft
      requires: SkillRequirement[]
      created: boolean
    }
  | { ok: false; stage: 'access' | 'empty' | 'distill' | 'validation'; detail: string }

export class SkillService {
  constructor(
    private skills: SkillRepository,
    private audit: AuditRepository,
    private toolBroker: ToolBrokerRepository,
    private agents: SkillAgentLookup,
    private conversations?: ConversationRepository,
  ) {}

  /**
   * Tenant-határ egy agentet célzó skill-művelethez (hozzárendelés / levétel /
   * engedélyezés). A megosztott (platform-szintű, `tenantId === null`) agent
   * elérhető, más tenant agentje SOSEM — a hiba opak (`Agent not found`), hogy az
   * idegen agent létezése ne váljon felderítési orákulummá. Ugyanaz a fail-closed
   * határ, mint a Tool Broker / Eval / KB oldalon; itt eddig hiányzott, ezért egy
   * tenant-admin idegen tenant agentjének futásidejű promptjába injektálhatott
   * (vagy abból levehetett) skillt.
   *
   * A tenant-sértés NEM néma: a `training-service` mintáját követve `skill.access_denied`
   * audit-sort hagy (`tenant_mismatch`), mert egy idegen agent-UUID-vel próbálkozó
   * művelet a legerősebb korai jele egy cross-tenant szondázásnak.
   */
  private async assertAgentReachable(agentId: string, actor: ActorContext): Promise<void> {
    const agent = await this.agents.findById(agentId)
    if (!agent || !isAgentReachableFromTenant(agent.tenantId, actor.actorTenantId)) {
      await this.audit.append({
        actorType: actor.actorId ? 'human' : 'system',
        actorId: actor.actorId,
        agentVersion: null,
        action: 'skill.access_denied',
        targetType: 'agent',
        targetId: agentId,
        modelUsed: null,
        inputRef: null,
        outputRef: 'tenant_mismatch',
        policyDecision: 'tenant_mismatch',
        tenantId: actor.actorTenantId,
        metadata: { agentId, activeTenantId: actor.actorTenantId },
      })
      throw new SkillAccessError('Agent not found')
    }
  }

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

  /** Hatókörön belül egyedi név (global: tenantId null; tenant-lokális: saját tenant). */
  private async assertSkillNameAvailable(
    name: string,
    tenantId: string | null,
    excludeSkillId?: string,
  ): Promise<void> {
    const normalized = normalizeSkillName(name)
    if (!normalized) throw new SkillAccessError('A skill neve kötelező.')
    const existing = await this.skills.findByNameInScope(normalized, tenantId)
    if (existing && existing.id !== excludeSkillId) {
      throw new SkillAccessError(
        `Már létezik „${existing.name}” nevű skill ebben a hatókörben. Használd az „Új verzió” gombot a meglévő skillnél, vagy töröld a duplikátumot.`,
      )
    }
  }

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
    await this.assertSkillNameAvailable(input.name, input.tenantId)
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

  /**
   * D14 — skill desztillálása beszélgetésből. Transzkript + determinisztikus
   * `requires` (tényleges tool-hívások) → desztilláló agent (propose-not-apply) →
   * hardcoded validátor → `proposed` SkillVersion. Alap-scope: tenant-lokális draft,
   * sosem auto-global. A beszélgetés nem megbízható input — provenience-kedvezmény nélkül.
   */
  async distillFromConversation(input: {
    conversationId: string
    agentId: string
    agentVersion?: number
    agentModelConfig?: unknown
    actor: ActorContext
    distiller: SkillDistillerAgent
    targetSkillId?: string
    /** Tenant kimeneti nyelv — a desztillált skill emberi szövegei. */
    outputLanguage?: TenantLanguage
  }): Promise<SkillDistillResult> {
    if (!this.conversations) {
      throw new Error('SkillService: conversation repository not configured')
    }

    const conversation = await this.conversations.findByIdForTenant(
      input.conversationId,
      input.actor.actorTenantId,
    )
    if (!conversation) {
      return { ok: false, stage: 'access', detail: 'A beszélgetés nem elérhető.' }
    }
    if (conversation.agentId !== input.agentId) {
      return { ok: false, stage: 'access', detail: 'Az agent nem egyezik a beszélgetés agentjével.' }
    }

    const messages = await this.conversations.findMessages(input.conversationId)
    const turns = conversationMessagesToTurns(messages)
    if (turns.length === 0) {
      return { ok: false, stage: 'empty', detail: 'A beszélgetésben nincs desztillálható szöveg.' }
    }

    const toolCalls = await this.toolBroker.listToolCallsForConversation(input.conversationId)
    const usedTools = [...new Set(toolCalls.filter((t) => t.status === 'ok').map((t) => t.toolName))]
    const requires = deriveRequiresFromToolCalls(toolCalls)

    const distilled = await input.distiller.distill({
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      agentModelConfig: input.agentModelConfig,
      tenantId: input.actor.actorTenantId,
      conversationId: input.conversationId,
      turns,
      usedTools,
      outputLanguage: input.outputLanguage,
    })
    if (!distilled.ok) {
      return { ok: false, stage: 'distill', detail: distilled.detail }
    }

    const validation = validateSkill({
      name: distilled.draft.name,
      description: distilled.draft.description,
      content: distilled.draft.content,
      requires,
    })
    if (!validation.ok) {
      return {
        ok: false,
        stage: 'validation',
        detail: validation.errors.join(' · '),
      }
    }

    const provenance = {
      origin: 'distilled' as const,
      sourceId: input.conversationId,
      format: 'conversation',
    }

    if (input.targetSkillId) {
      const existing = await this.getReadableSkill(input.actor.actorTenantId, input.targetSkillId)
      if (!existing) {
        return { ok: false, stage: 'access', detail: 'A cél-skill nem elérhető.' }
      }
      const { versionId } = await this.proposeVersion({
        skillId: input.targetSkillId,
        content: distilled.draft.content,
        requires,
        actor: input.actor,
      })
      return {
        ok: true,
        skillId: input.targetSkillId,
        versionId,
        riskTier: validation.riskTier,
        draft: distilled.draft,
        requires,
        created: false,
      }
    }

    const { skill, versionId } = await this.createSkill({
      name: distilled.draft.name,
      description: distilled.draft.description,
      catalogScope: 'tenant',
      tenantId: input.actor.actorTenantId,
      sourceType: 'authored',
      provenance: provenance as unknown as Prisma.InputJsonValue,
      license: null,
      riskTier: validation.riskTier,
      content: distilled.draft.content,
      requires,
      actor: input.actor,
    })

    return {
      ok: true,
      skillId: skill.id,
      versionId,
      riskTier: validation.riskTier,
      draft: distilled.draft,
      requires,
      created: true,
    }
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

  /**
   * Tanácsadó LLM-review egy skill-verzióhoz (WP-3 §D5). A hardcoded validátor
   * eredménye mindig visszajön; az LLM kimenet CSAK tanácsadó — sosem kapu.
   */
  async advisoryReviewVersion(input: {
    versionId: string
    reviewAgentId: string
    reviewAgentVersion?: number
    /** Provisioning Assistant Registry `modelConfig` — a „Gondolkodási motor” beállítása. */
    reviewAgentModelConfig?: unknown
    actor: ActorContext
    reviewer: SkillReviewAgent
  }): Promise<
    | {
        ok: true
        validation: SkillValidationResult
        review: SkillAdvisoryReview
      }
    | { ok: false; stage: 'access' | 'review'; detail: string; validation?: SkillValidationResult }
  > {
    const target = await this.skills.findVersionById(input.versionId)
    if (!target) {
      return { ok: false, stage: 'access', detail: 'A skill-verzió nem található.' }
    }
    if (
      !isSkillReadableFromTenant(target.skill.tenantId, input.actor.actorTenantId)
    ) {
      return { ok: false, stage: 'access', detail: 'A skill nem olvasható ebből a tenantból.' }
    }

    const content = parseSkillContent(target.content)
    const requires = parseSkillRequires(target.requires)
    const validation = validateSkill({
      name: target.skill.name,
      description: target.skill.description,
      content,
      requires,
    })

    const reviewResult = await input.reviewer.review({
      agentId: input.reviewAgentId,
      agentVersion: input.reviewAgentVersion,
      agentModelConfig: input.reviewAgentModelConfig,
      tenantId: input.actor.actorTenantId,
      name: target.skill.name,
      description: target.skill.description,
      content,
      requires,
      riskTier: target.skill.riskTier,
      sourceType: target.skill.sourceType,
    })
    if (!reviewResult.ok) {
      return {
        ok: false,
        stage: 'review',
        detail: reviewResult.detail,
        validation,
      }
    }

    await this.audit.append({
      actorType: input.actor.actorId ? 'human' : 'system',
      actorId: input.actor.actorId,
      agentVersion: input.reviewAgentVersion ?? null,
      action: 'skill.version.reviewed',
      targetType: 'skill',
      targetId: target.skillId,
      modelUsed: null,
      inputRef: input.versionId,
      outputRef: reviewResult.review.overallAssessment,
      policyDecision: 'advisory',
      tenantId: target.skill.tenantId,
      metadata: {
        skillVersionId: target.id,
        overallAssessment: reviewResult.review.overallAssessment,
        concernCount: reviewResult.review.concerns.length,
        validationOk: validation.ok,
      },
    })

    return { ok: true, validation, review: reviewResult.review }
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
    const { version, agentMigrations } = await this.skills.approveVersion(input.versionId, {
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

    await this.recordAgentSkillMigrations({
      skillId: target.skillId,
      skillVersionId: version.id,
      version: version.version,
      tenantId: target.skill.tenantId,
      trigger: 'approve',
      actorId: input.actor.actorId,
      agentMigrations,
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
    if (target.status !== 'retired' && target.status !== 'rolled_back') {
      throw new SkillAccessError(
        'Rollback csak korábban aktív (retired/rolled_back) verzióra lehetséges. Draftot a Jóváhagyás gombbal aktiválj.',
      )
    }

    const signature = signSkillVersion({
      skillVersionId: target.id,
      contentHash: target.contentHash,
      approverId: input.actor.actorId,
    })
    const { version, agentMigrations } = await this.skills.rollbackToVersion(input.versionId, {
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

    await this.recordAgentSkillMigrations({
      skillId: target.skillId,
      skillVersionId: version.id,
      version: version.version,
      tenantId: target.skill.tenantId,
      trigger: 'rollback',
      actorId: input.actor.actorId,
      agentMigrations,
    })

    return { versionId: version.id, version: version.version }
  }

  /**
   * Aktív verzió visszavonása — a skill nem lesz újra hozzárendelhető; a meglévő
   * agent-hozzárendelések érintetlenek maradnak (nincs új aktív verzió).
   */
  async deactivateSkill(input: {
    skillId: string
    actor: ActorContext
  }): Promise<{ versionId: string; version: number } | null> {
    const skill = await this.getReadableSkill(input.actor.actorTenantId, input.skillId)
    if (!skill) throw new SkillAccessError('Skill not found')
    if (
      !isSkillWritableFromTenant(
        skill.tenantId,
        input.actor.actorTenantId,
        input.actor.isPlatformAdmin,
      )
    ) {
      throw new SkillAccessError()
    }

    const retired = await this.skills.retireActiveVersion(input.skillId)
    if (!retired) {
      throw new SkillAccessError('Nincs aktív verzió — a skill már deaktivált.')
    }

    await this.audit.append({
      actorType: 'human',
      actorId: input.actor.actorId,
      agentVersion: null,
      action: 'skill.deactivated',
      targetType: 'skill',
      targetId: skill.id,
      modelUsed: null,
      inputRef: retired.id,
      outputRef: `v${retired.version}`,
      policyDecision: 'retired',
      tenantId: skill.tenantId,
      metadata: { skillVersionId: retired.id },
    })

    return { versionId: retired.id, version: retired.version }
  }

  /**
   * Skill törlése a katalógusból. Csak ha nincs agent-hozzárendelés egyetlen verzióhoz sem.
   */
  async deleteSkill(input: { skillId: string; actor: ActorContext }): Promise<void> {
    const skill = await this.getReadableSkill(input.actor.actorTenantId, input.skillId)
    if (!skill) throw new SkillAccessError('Skill not found')
    if (
      !isSkillWritableFromTenant(
        skill.tenantId,
        input.actor.actorTenantId,
        input.actor.isPlatformAdmin,
      )
    ) {
      throw new SkillAccessError()
    }

    const assignmentCount = await this.skills.countAssignmentsForSkill(input.skillId)
    if (assignmentCount > 0) {
      throw new SkillAccessError(
        `A skill ${assignmentCount} agenthez van rendelve — előbb vedd le a hozzárendeléseket, vagy deaktiváld.`,
      )
    }

    await this.skills.deleteSkill(input.skillId)

    await this.audit.append({
      actorType: 'human',
      actorId: input.actor.actorId,
      agentVersion: null,
      action: 'skill.deleted',
      targetType: 'skill',
      targetId: skill.id,
      modelUsed: null,
      inputRef: skill.name,
      outputRef: null,
      policyDecision: 'deleted',
      tenantId: skill.tenantId,
      metadata: { skillId: skill.id, versionCount: skill.versions.length },
    })
  }

  // ── Hozzárendelés + readiness (WP-4) ──────────────────────────────────────

  async assign(input: {
    agentId: string
    skillVersionId: string
    actor: ActorContext
  }): Promise<void> {
    const target = await this.skills.findVersionById(input.skillVersionId)
    if (!target) throw new SkillAccessError('Skill version not found')
    // A cél-agentnek is az actor tenantjából elérhetőnek kell lennie — különben
    // egy tenant-admin idegen tenant agentjébe injektálhatna skillt.
    await this.assertAgentReachable(input.agentId, input.actor)
    // Csak olvasható skill rendelhető hozzá (global vagy saját tenant).
    if (!isSkillReadableFromTenant(target.skill.tenantId, input.actor.actorTenantId)) {
      throw new SkillAccessError()
    }
    if (target.status !== 'active') {
      throw new SkillAccessError('Only an active skill version can be assigned')
    }

    const { replacedVersionIds } = await this.skills.assign({
      agentId: input.agentId,
      skillVersionId: input.skillVersionId,
      assignedById: input.actor.actorId,
    })

    for (const replacedVersionId of replacedVersionIds) {
      await this.audit.append({
        actorType: input.actor.actorId ? 'human' : 'system',
        actorId: input.actor.actorId,
        agentVersion: null,
        action: 'skill.unassigned',
        targetType: 'agent',
        targetId: input.agentId,
        modelUsed: null,
        inputRef: target.skillId,
        outputRef: replacedVersionId,
        policyDecision: 'active',
        tenantId: input.actor.actorTenantId,
        metadata: {
          skillVersionId: replacedVersionId,
          skillId: target.skillId,
          reason: 'replaced_by_newer_version',
        },
      })
    }

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
      metadata: {
        skillId: target.skillId,
        skillVersionId: input.skillVersionId,
        replacedVersionIds,
      },
    })
  }

  async unassign(input: {
    agentId: string
    skillVersionId: string
    actor: ActorContext
  }): Promise<void> {
    await this.assertAgentReachable(input.agentId, input.actor)
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

  async setEnabled(input: {
    agentId: string
    skillVersionId: string
    enabled: boolean
    actor: ActorContext
  }) {
    await this.assertAgentReachable(input.agentId, input.actor)
    return this.skills.setEnabled(input.agentId, input.skillVersionId, input.enabled)
  }

  private async recordAgentSkillMigrations(input: {
    skillId: string
    skillVersionId: string
    version: number
    tenantId: string | null
    trigger: 'approve' | 'rollback'
    actorId: string
    agentMigrations: AgentSkillMigration[]
  }): Promise<void> {
    if (input.agentMigrations.length === 0) return

    const agentIds = [...new Set(input.agentMigrations.map((m) => m.agentId))]
    await this.audit.append({
      actorType: 'human',
      actorId: input.actorId,
      agentVersion: null,
      action: 'skill.version.agents_migrated',
      targetType: 'skill',
      targetId: input.skillId,
      modelUsed: null,
      inputRef: input.skillVersionId,
      outputRef: `${agentIds.length} agent`,
      policyDecision: 'active',
      tenantId: input.tenantId,
      metadata: {
        skillVersionId: input.skillVersionId,
        version: input.version,
        trigger: input.trigger,
        agentCount: agentIds.length,
        migrations: input.agentMigrations,
      },
    })
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
   * Explicit skill-verzió-id-k Level-1 előtöltése (board ticket / slash közös út).
   * Csak hozzárendelt, enabled skillek tölthetők — ismeretlen/deny id kimarad.
   */
  async preloadSkillsByVersionIds(input: {
    agentId: string
    skillVersionIds: string[]
    actor: ActorContext
    reason?: string
  }): Promise<SkillPreloadResult> {
    if (input.skillVersionIds.length === 0) {
      return { preloadedPrompts: [], loadedSkillNames: [], loadedSkillVersionIds: [], blocked: [] }
    }
    const index = await this.getAssignedSkillIndex(input.agentId)
    const reason =
      input.reason ??
      'A felhasználó explicit módon kérte ennek a skillnek a betöltését. Kövesd az alábbi instrukciót:'
    const preloadedPrompts: string[] = []
    const loadedSkillNames: string[] = []
    const loadedSkillVersionIds: string[] = []
    const collectedHints: SkillRuntimeHints[] = []
    const collectedParameters: SkillParameter[] = []
    const blocked: SkillPreloadResult['blocked'] = []
    const requiredTools: string[] = []
    let sawSkillWithoutRequires = false
    const seen = new Set<string>()
    const orderedIds: string[] = []
    for (const skillVersionId of input.skillVersionIds) {
      if (seen.has(skillVersionId)) continue
      seen.add(skillVersionId)
      orderedIds.push(skillVersionId)
    }

    const loadableIds = orderedIds.filter((id) => Boolean(resolveLoadableSkill(index, id)))
    const deniedIds = orderedIds.filter((id) => !resolveLoadableSkill(index, id))

    await Promise.all(
      deniedIds.map((skillVersionId) =>
        this.audit.append({
          actorType: 'agent',
          actorId: input.agentId,
          agentVersion: null,
          action: 'skill.access_denied',
          targetType: 'agent',
          targetId: input.agentId,
          modelUsed: null,
          inputRef: skillVersionId,
          outputRef: 'denied',
          policyDecision: 'deny',
          tenantId: input.actor.actorTenantId,
          metadata: { skillVersionId, reason: 'not_assigned' },
        }),
      ),
    )

    if (loadableIds.length === 0) {
      return { preloadedPrompts: [], loadedSkillNames: [], loadedSkillVersionIds: [], blocked: [] }
    }

    const versions = await this.skills.findVersionsByIds(loadableIds)
    const versionById = new Map(versions.map((v) => [v.id, v] as const))

    for (const skillVersionId of loadableIds) {
      const entry = resolveLoadableSkill(index, skillVersionId)
      if (!entry) continue
      const version = versionById.get(skillVersionId)
      if (!version) continue
      const content = parseSkillContent(version.content)

      // Fail-closed readiness-kapu: hiányzó capability-nél nem töltjük be.
      const readiness = await this.checkSkillToolReadiness(input.agentId, version.requires)
      if (!readiness.ok) {
        await this.auditSkillBlocked({
          agentId: input.agentId,
          skillId: entry.skillId,
          skillVersionId,
          version: entry.version,
          missing: readiness.missing,
          actorTenantId: input.actor.actorTenantId,
        })
        blocked.push({
          name: entry.name,
          missingTools: readiness.missing,
          reason: SkillService.unreadySkillReason(entry.name, readiness.missing),
        })
        continue
      }

      const versionRequires = parseSkillRequires(version.requires)
      if (versionRequires.length === 0) sawSkillWithoutRequires = true
      requiredTools.push(...versionRequires.map((r) => r.toolName))
      await this.audit.append({
        actorType: 'agent',
        actorId: input.agentId,
        agentVersion: null,
        action: 'skill.loaded',
        targetType: 'skill',
        targetId: entry.skillId,
        modelUsed: null,
        inputRef: skillVersionId,
        outputRef: `v${entry.version}`,
        policyDecision: 'allow',
        tenantId: input.actor.actorTenantId,
        metadata: { skillVersionId, skillId: entry.skillId },
      })
      loadedSkillNames.push(entry.name)
      loadedSkillVersionIds.push(skillVersionId)
      preloadedPrompts.push(`${reason}\n\n${buildLoadedSkillPrompt(entry, content)}`)
      if (content.runtimeHints) collectedHints.push(content.runtimeHints)
      for (const parameter of content.parameters) {
        if (collectedParameters.some((p) => p.name === parameter.name)) continue
        collectedParameters.push(parameter)
      }
    }
    return {
      preloadedPrompts,
      loadedSkillNames,
      loadedSkillVersionIds,
      blocked,
      ...(collectedParameters.length > 0 ? { parameters: collectedParameters } : {}),
      // A betöltött skillek `allowed-tools`-a = a forduló eszköz-hatóköre. Ha
      // BÁRMELYIK betöltött skill üres requires-szel jön, nincs mit szűkíteni:
      // ilyenkor a hatókört elhagyjuk (undefined), különben a listázatlan skill
      // eszközeit vágnánk le.
      ...(loadedSkillVersionIds.length > 0 && requiredTools.length > 0 && !sawSkillWithoutRequires
        ? { requiredTools: [...new Set(requiredTools)] }
        : {}),
      runtimeHints: aggregateSkillRuntimeHints(collectedHints),
    }
  }

  /**
   * Futásidejű readiness-kapu (§D10 kiegészítés). A readiness eddig CSAK az
   * agent-detail panelen jelent meg; futáskor semmi nem nézte, ezért egy hiányzó
   * capability-grant mellett a skill elindult, a modell pedig a hiányzó eszközt
   * kézi kerülőúttal pótolta — és a hiányos eredményt késznek jelentette. Üzleti
   * hatás: a felhasználó egy hitelesnek látszó, valójában hiányos munkaterméket
   * kap (pl. 182 sorból 10 az egyeztető Excelben), és nincs jelzés, hogy baj van.
   *
   * Ezért a betöltés fail-closed: ha a skill `requires` listájából bármi hiányzik
   * az agent capability-i közül, a skill NEM töltődik be. Jobb nem elkezdeni,
   * mint félkészen befejezni.
   */
  private async checkSkillToolReadiness(
    agentId: string,
    requiresJson: unknown,
  ): Promise<{ ok: true } | { ok: false; missing: string[] }> {
    const requires = parseSkillRequires(requiresJson)
    if (requires.length === 0) return { ok: true }
    const caps = await this.toolBroker.findCapabilitiesForAgent(agentId)
    const allowedTools = new Set(caps.filter((c) => c.allowed).map((c) => c.toolName))
    const missing = requires
      .map((r) => r.toolName)
      .filter((toolName) => !allowedTools.has(toolName))
    return missing.length === 0 ? { ok: true } : { ok: false, missing }
  }

  /** Ember által olvasható indok a blokkolt skill-betöltéshez. */
  private static unreadySkillReason(name: string, missing: string[]): string {
    return (
      `A(z) „${name}" skill nem futtatható, mert az agentnek hiányzik a következő eszköz-jogosultsága: ` +
      `${missing.join(', ')}. Ezek nélkül a munka csak részben készülne el, ezért el sem kezdem. ` +
      `Kérd meg az agent adminisztrátorát, hogy adja meg ezeket a capability-ket az agent adatlapján.`
    )
  }

  private async auditSkillBlocked(input: {
    agentId: string
    skillId: string
    skillVersionId: string
    version: number
    missing: string[]
    actorTenantId: string | null
  }): Promise<void> {
    await this.audit.append({
      actorType: 'agent',
      actorId: input.agentId,
      agentVersion: null,
      action: 'skill.blocked_unready',
      targetType: 'skill',
      targetId: input.skillId,
      modelUsed: null,
      inputRef: input.skillVersionId,
      outputRef: `v${input.version}`,
      policyDecision: 'deny',
      tenantId: input.actorTenantId,
      metadata: {
        skillVersionId: input.skillVersionId,
        skillId: input.skillId,
        missingTools: input.missing,
      },
    })
  }

  /**
   * `/skill-token` slash-parancsok feloldása és Level-1 előtöltése (chat UX).
   * Csak hozzárendelt, enabled skillek tölthetők be — ismeretlen token marad a szövegben.
   */
  async resolveSlashSkillLoads(input: {
    agentId: string
    messageText: string
    actor: ActorContext
  }): Promise<SkillPreloadResult & { modelFacingText: string }> {
    if (!input.messageText.includes('/')) {
      return {
        modelFacingText: input.messageText,
        preloadedPrompts: [],
        loadedSkillNames: [],
        loadedSkillVersionIds: [],
        blocked: [],
      }
    }
    const index = await this.getAssignedSkillIndex(input.agentId)
    const parsed = parseSkillSlashCommands(input.messageText, index)
    if (parsed.skillVersionIds.length === 0) {
      return {
        modelFacingText: input.messageText,
        preloadedPrompts: [],
        loadedSkillNames: [],
        loadedSkillVersionIds: [],
        blocked: [],
      }
    }

    const preloaded = await this.preloadSkillsByVersionIds({
      agentId: input.agentId,
      skillVersionIds: parsed.skillVersionIds,
      actor: input.actor,
      reason:
        'A felhasználó explicit módon kérte ennek a skillnek a betöltését (/slash parancs). Kövesd az alábbi instrukciót:',
    })
    return { ...preloaded, modelFacingText: parsed.modelFacingText }
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
  }): Promise<
    | {
        ok: true
        instructions: string
        runtimeHints?: SkillRuntimeHints
        /** A skill `allowed-tools`-a — a hívó ezzel szűkíti a forduló eszköz-hatókörét. */
        requiredTools?: string[]
      }
    | { ok: false; reason: string }
  > {
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

    // Fail-closed readiness-kapu: hiányzó capability-nél a skill nem töltődik be.
    const readiness = await this.checkSkillToolReadiness(input.agentId, version.requires)
    if (!readiness.ok) {
      await this.auditSkillBlocked({
        agentId: input.agentId,
        skillId: entry.skillId,
        skillVersionId: input.skillVersionId,
        version: entry.version,
        missing: readiness.missing,
        actorTenantId: input.actor.actorTenantId,
      })
      return { ok: false, reason: SkillService.unreadySkillReason(entry.name, readiness.missing) }
    }

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

    const requiredTools = parseSkillRequires(version.requires).map((r) => r.toolName)
    return {
      ok: true,
      instructions: buildLoadedSkillPrompt(entry, content),
      ...(content.runtimeHints ? { runtimeHints: content.runtimeHints } : {}),
      ...(requiredTools.length > 0 ? { requiredTools } : {}),
    }
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
   * Futásidejű snapshot PERZISZTÁLÁS (D9/D12): a futás kezdetén az aktív, enabled
   * skill-verzió-id-ket az audit-láncba írja, a futáshoz (ticket/conversation)
   * kötve — így bármely futásra utólag megmondható, mely skill-verziók voltak
   * élők (reprodukálhatóság). Üres snapshotnál (nincs hozzárendelt skill) nem ír
   * bejegyzést. Idempotens hívási hely: a runtime a tool-loop előtt hívja.
   */
  async recordRunSkillSnapshot(input: {
    agentId: string
    context: { ticketId?: string | null; conversationId?: string | null }
    actorTenantId: string | null
  }): Promise<string[]> {
    const skillVersionIds = await this.getRunSkillSnapshot(input.agentId)
    if (skillVersionIds.length === 0) return []
    await this.audit.append({
      actorType: 'agent',
      actorId: input.agentId,
      agentVersion: null,
      action: 'skill.run_snapshot',
      targetType: 'agent',
      targetId: input.agentId,
      modelUsed: null,
      inputRef: null,
      outputRef: `${skillVersionIds.length} skill`,
      policyDecision: 'active',
      tenantId: input.actorTenantId,
      ticketId: input.context.ticketId ?? null,
      conversationId: input.context.conversationId ?? null,
      metadata: { skillVersionIds },
    })
    return skillVersionIds
  }

  /**
   * Egy skill-verzió kanonikus tartalma (#199). A hozzárendelés-ellenőrzés NEM
   * ennek a dolga — a hívó (feladat-indítás, katalógus) előbb feloldja, hogy az
   * agenten engedélyezett-e a verzió.
   */
  async getSkillContentForVersion(skillVersionId: string): Promise<SkillContent | null> {
    const version = await this.skills.findVersionById(skillVersionId)
    if (!version) return null
    return parseSkillContent(version.content)
  }

  /**
   * Csatolmány-kapu (#199): engedik-e a MEGADOTT skill-verziók a fájlcsatolást?
   *
   * EGY forrás mindkét kapuhoz — a `createBoardTicket` és a workspace-feltöltő
   * endpoint is ezt hívja. A feltöltés ugyanis NEM a ticket létrehozásával egy
   * hívásban történik: ha csak az egyik helyen ellenőriznénk, a kapu egy közvetlen
   * POST-tal megkerülhető lenne.
   *
   * A legszigorúbb szabály nyer: egyetlen tiltó skill is letiltja a csatolást.
   * Ismeretlen skill-verzió nem tilt (a hívó úgyis külön ellenőrzi a hozzárendelést).
   */
  async resolveAttachmentPolicy(skillVersionIds: string[]): Promise<{
    allowAttachments: boolean
    blockingSkillNames: string[]
  }> {
    if (skillVersionIds.length === 0) return { allowAttachments: true, blockingSkillNames: [] }
    const versions = await this.skills.findVersionsByIds(skillVersionIds)
    const blockingSkillNames = versions
      .filter((v) => !skillAllowsAttachments(parseSkillContent(v.content).runtimeHints))
      .map((v) => v.skill.name)
    return { allowAttachments: blockingSkillNames.length === 0, blockingSkillNames }
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
