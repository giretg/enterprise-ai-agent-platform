'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import { assertAgentTenantReachable } from '@/lib/agent-tenant-access'
import { fail, ok, type ActionResult } from '@/lib/result'
import { SkillAccessError, type ActorContext } from '@/domain/skill/skill-service'
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_NAME_MAX,
  parseSkillContent,
  parseSkillRequires,
  skillContentSchema,
  skillRequiresSchema,
  type SkillContent,
} from '@/lib/skill/skill-content'
import { validateSkill } from '@/lib/skill/skill-validator'
import { diffSkillVersions } from '@/lib/skill/skill-diff'
import { PROVISIONING_ASSISTANT_TEMPLATE } from '@/domain/provisioning/provisioning-assistant'
import type { TenantAuthContext } from '@/auth/context'
import type { SkillReadiness } from '@/lib/skill/skill-readiness'
import type { SkillRiskTier } from '@prisma/client'
import { readTenantLanguage } from '@/lib/tenant-language'

/**
 * Skill-katalógus server actionök (skill-catalog-spec.md WP-4/6/7). Minden action
 * önmagát autorizálja (tenant-admin kapu) és a fail-closed domain-scope-ra
 * támaszkodik: idegen tenant skillje sosem érhető el. A platform-admin jogot a
 * platformRoles-ból vezetjük le — csak ez írhat/hagyhat jóvá global skillt.
 */

function actorFrom(ctx: TenantAuthContext): ActorContext {
  return {
    actorId: ctx.user.id,
    actorTenantId: ctx.activeTenantId,
    isPlatformAdmin: ctx.platformRoles.some(
      (r) => r === 'superadmin' || r === 'platform_operator',
    ),
  }
}

function messageFrom(err: unknown): string {
  if (err instanceof SkillAccessError) return err.message
  if (err instanceof Error) return err.message
  return 'Ismeretlen hiba a skill-műveletben.'
}

/**
 * Tenant-határ egy agent-célzó skill-olvasáshoz. A reachability-szabályt a közös
 * {@link assertAgentTenantReachable} helper dönti el (egy forrás, egy igazság — a
 * megosztott platform-agent elérhető, más tenant agentje sosem), így az olvasó és
 * a SkillService write-útja nem tud eltérő határt kialakítani. Az idegen agent
 * opak `Agent not found` — nem felderítési orákulum.
 */
async function assertAgentInTenant(agentId: string, activeTenantId: string | null): Promise<void> {
  const agent = await repositories.agents.findById(agentId)
  if (!agent) throw new SkillAccessError('Agent not found')
  assertAgentTenantReachable(agent, activeTenantId)
}

// ── WP-4: agent-detail skill panel (readiness + hozzárendelés) ────────────────

export interface AgentSkillRow {
  agentId: string
  skillVersionId: string
  enabled: boolean
  skillId: string
  name: string
  description: string
  version: number
  riskTier: SkillRiskTier
  requires: Array<{ toolName: string; reason: string }>
  readiness: SkillReadiness
}

export async function getAgentSkillsAction(
  agentId: string,
): Promise<ActionResult<AgentSkillRow[]>> {
  try {
    const ctx = await requireTenantRole('operator')
    await assertAgentInTenant(agentId, ctx.activeTenantId)
    const rows = await services.skills.listAgentSkillsWithReadiness(agentId)
    return ok(
      rows.map((r) => ({
        agentId: r.agentId,
        skillVersionId: r.skillVersionId,
        enabled: r.enabled,
        skillId: r.skillId,
        name: r.name,
        description: r.description,
        version: r.version,
        riskTier: r.riskTier,
        requires: r.requires,
        readiness: r.readiness,
      })),
    )
  } catch (err) {
    return fail(messageFrom(err))
  }
}

export interface AssignableSkill {
  skillId: string
  name: string
  description: string
  riskTier: SkillRiskTier
  activeVersionId: string
  version: number
}

/**
 * A hozzárendelhető skillek: a katalógusban aktív verzióval bíró, még nem
 * hozzárendelt skillek (fail-closed olvasás a saját + global scope-ra).
 */
export async function listAssignableSkillsAction(
  agentId: string,
): Promise<ActionResult<AssignableSkill[]>> {
  try {
    const ctx = await requireTenantRole('admin')
    await assertAgentInTenant(agentId, ctx.activeTenantId)
    const [catalog, assigned] = await Promise.all([
      services.skills.listForActor(ctx.activeTenantId),
      services.skills.listAgentSkillsWithReadiness(agentId),
    ])
    const assignedSkillIds = new Set(assigned.map((a) => a.skillId))
    const rows: AssignableSkill[] = []
    for (const skill of catalog) {
      const active = skill.versions.find((v) => v.status === 'active')
      if (!active || assignedSkillIds.has(skill.id)) continue
      rows.push({
        skillId: skill.id,
        name: skill.name,
        description: skill.description,
        riskTier: skill.riskTier,
        activeVersionId: active.id,
        version: active.version,
      })
    }
    return ok(rows)
  } catch (err) {
    return fail(messageFrom(err))
  }
}

export async function assignSkillAction(input: {
  agentId: string
  skillVersionId: string
}): Promise<ActionResult<null>> {
  try {
    const ctx = await requireTenantRole('admin')
    await services.skills.assign({
      agentId: input.agentId,
      skillVersionId: input.skillVersionId,
      actor: actorFrom(ctx),
    })
    revalidatePath(`/control-plane/agents/${input.agentId}`)
    return ok(null)
  } catch (err) {
    return fail(messageFrom(err))
  }
}

export async function unassignSkillAction(input: {
  agentId: string
  skillVersionId: string
}): Promise<ActionResult<null>> {
  try {
    const ctx = await requireTenantRole('admin')
    await services.skills.unassign({
      agentId: input.agentId,
      skillVersionId: input.skillVersionId,
      actor: actorFrom(ctx),
    })
    revalidatePath(`/control-plane/agents/${input.agentId}`)
    return ok(null)
  } catch (err) {
    return fail(messageFrom(err))
  }
}

export async function setSkillEnabledAction(input: {
  agentId: string
  skillVersionId: string
  enabled: boolean
}): Promise<ActionResult<null>> {
  try {
    const ctx = await requireTenantRole('admin')
    await services.skills.setEnabled({ ...input, actor: actorFrom(ctx) })
    revalidatePath(`/control-plane/agents/${input.agentId}`)
    return ok(null)
  } catch (err) {
    return fail(messageFrom(err))
  }
}

// ── WP-6/7: katalógus-kezelés (import / kézi szerzés / verziózás / rollback) ──

export interface SkillCatalogEntry {
  id: string
  name: string
  description: string
  catalogScope: 'global' | 'tenant'
  sourceType: 'authored' | 'imported'
  riskTier: SkillRiskTier
  license: string | null
  /** Az aktív verzió futási kerete — a listában olvasható jelzés (issue #161). */
  runtimeHints: SkillContent['runtimeHints']
  versions: Array<{
    id: string
    version: number
    status: string
    contentHash: string
    signed: boolean
    createdAt: string
  }>
}

export async function listSkillCatalogAction(): Promise<ActionResult<SkillCatalogEntry[]>> {
  try {
    const ctx = await requireTenantRole('operator')
    const skills = await services.skills.listForActor(ctx.activeTenantId)
    return ok(
      skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        catalogScope: s.catalogScope,
        sourceType: s.sourceType,
        riskTier: s.riskTier,
        license: s.license,
        runtimeHints: parseSkillContent(
          s.versions.find((v) => v.status === 'active')?.content,
        ).runtimeHints,
        versions: [...s.versions]
          .sort((a, b) => b.version - a.version)
          .map((v) => ({
            id: v.id,
            version: v.version,
            status: v.status,
            contentHash: v.contentHash,
            signed: Boolean(v.signature),
            createdAt: v.createdAt.toISOString(),
          })),
      })),
    )
  } catch (err) {
    return fail(messageFrom(err))
  }
}

const importSchema = z.object({
  raw: z.string().min(1, 'A SKILL.md tartalom nem lehet üres.'),
  sourceUrl: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  scope: z.enum(['tenant', 'global']).default('tenant'),
})

export async function importSkillMdAction(
  input: z.input<typeof importSchema>,
): Promise<ActionResult<{ skillId: string; versionId: string; riskTier: SkillRiskTier }>> {
  try {
    const parsed = importSchema.parse(input)
    const ctx = await requireTenantRole('admin')
    const actor = actorFrom(ctx)
    if (parsed.scope === 'global' && !actor.isPlatformAdmin) {
      return fail('Global skillt csak platform-admin importálhat.')
    }
    const result = await services.skills.importSkillMd({
      raw: parsed.raw,
      sourceUrl: parsed.sourceUrl,
      catalogScope: parsed.scope,
      tenantId: ctx.activeTenantId,
      actor,
    })
    if (!result.ok) {
      const reasons = result.validation.errors.join(' · ')
      return fail(`A skill nem felelt meg a hardcoded validátornak: ${reasons}`)
    }
    revalidatePath('/control-plane/skills')
    return ok({
      skillId: result.skill.id,
      versionId: result.versionId,
      riskTier: result.validation.riskTier,
    })
  } catch (err) {
    return fail(messageFrom(err))
  }
}

const createSchema = z.object({
  name: z.string().min(1).max(SKILL_NAME_MAX),
  description: z.string().min(1).max(SKILL_DESCRIPTION_MAX),
  scope: z.enum(['tenant', 'global']).default('tenant'),
  content: skillContentSchema,
  requires: skillRequiresSchema,
})

export async function createSkillAction(
  input: z.input<typeof createSchema>,
): Promise<ActionResult<{ skillId: string; versionId: string }>> {
  try {
    const parsed = createSchema.parse(input)
    const ctx = await requireTenantRole('admin')
    const actor = actorFrom(ctx)
    if (parsed.scope === 'global' && !actor.isPlatformAdmin) {
      return fail('Global skillt csak platform-admin hozhat létre.')
    }
    // A kézi szerzés is a hardcoded validátoron megy át (kód/injection tiltás,
    // tier-levezetés) — a puha rész sosem kap könnyített utat.
    const validation = validateSkill({
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      requires: parsed.requires,
    })
    if (!validation.ok) {
      return fail(`A skill nem felelt meg a validátornak: ${validation.errors.join(' · ')}`)
    }
    const { skill, versionId } = await services.skills.createSkill({
      name: parsed.name,
      description: parsed.description,
      catalogScope: parsed.scope,
      tenantId: parsed.scope === 'global' ? null : ctx.activeTenantId,
      sourceType: 'authored',
      provenance: { origin: 'authored' },
      license: null,
      riskTier: validation.riskTier,
      content: parsed.content,
      requires: parsed.requires,
      actor,
    })
    revalidatePath('/control-plane/skills')
    return ok({ skillId: skill.id, versionId })
  } catch (err) {
    return fail(messageFrom(err))
  }
}

const proposeSchema = z.object({
  skillId: z.string().uuid(),
  content: skillContentSchema,
  requires: skillRequiresSchema,
})

export interface SkillVersionDetail {
  versionId: string
  skillId: string
  version: number
  status: string
  content: SkillContent
  requires: Array<{ toolName: string; reason: string }>
  contentHash: string
}

/** Egy skill-verzió teljes tartalma szerkesztéshez / diff alaphoz (fail-closed olvasás). */
export async function getSkillVersionAction(
  versionId: string,
): Promise<ActionResult<SkillVersionDetail>> {
  try {
    const ctx = await requireTenantRole('operator')
    const target = await repositories.skills.findVersionById(versionId)
    if (!target) return fail('A skill-verzió nem található.')
    const readable = await services.skills.getReadableSkill(ctx.activeTenantId, target.skillId)
    if (!readable) return fail('A skill nem olvasható ebből a tenantból.')
    return ok({
      versionId: target.id,
      skillId: target.skillId,
      version: target.version,
      status: target.status,
      content: parseSkillContent(target.content),
      requires: parseSkillRequires(target.requires),
      contentHash: target.contentHash,
    })
  } catch (err) {
    return fail(messageFrom(err))
  }
}

/** WP-7 — két skill-verzió tartalmi diff-je (layout-független, determinisztikus). */
export async function diffSkillVersionsAction(input: {
  baseVersionId: string
  targetVersionId: string
}): Promise<
  ActionResult<{
    diff: ReturnType<typeof diffSkillVersions>
    base: { version: number; contentHash: string }
    target: { version: number; contentHash: string }
  }>
> {
  try {
    const ctx = await requireTenantRole('operator')
    const [base, target] = await Promise.all([
      repositories.skills.findVersionById(input.baseVersionId),
      repositories.skills.findVersionById(input.targetVersionId),
    ])
    if (!base || !target) return fail('Az egyik verzió nem található.')
    if (base.skillId !== target.skillId) {
      return fail('A diff csak ugyanazon skill két verziója között értelmezhető.')
    }
    const readable = await services.skills.getReadableSkill(ctx.activeTenantId, base.skillId)
    if (!readable) return fail('A skill nem olvasható ebből a tenantból.')
    const diff = diffSkillVersions(
      {
        content: parseSkillContent(base.content),
        requires: parseSkillRequires(base.requires),
      },
      {
        content: parseSkillContent(target.content),
        requires: parseSkillRequires(target.requires),
      },
    )
    return ok({
      diff,
      base: { version: base.version, contentHash: base.contentHash },
      target: { version: target.version, contentHash: target.contentHash },
    })
  } catch (err) {
    return fail(messageFrom(err))
  }
}

export async function proposeSkillVersionAction(
  input: z.input<typeof proposeSchema>,
): Promise<ActionResult<{ versionId: string; version: number }>> {
  try {
    const parsed = proposeSchema.parse(input)
    const ctx = await requireTenantRole('admin')
    const validation = validateSkill({
      name: 'placeholder',
      description: 'placeholder',
      content: parsed.content,
      requires: parsed.requires,
    })
    if (!validation.ok) {
      return fail(`A javasolt verzió nem felelt meg a validátornak: ${validation.errors.join(' · ')}`)
    }
    const res = await services.skills.proposeVersion({
      skillId: parsed.skillId,
      content: parsed.content,
      requires: parsed.requires,
      actor: actorFrom(ctx),
    })
    revalidatePath('/control-plane/skills')
    return ok(res)
  } catch (err) {
    return fail(messageFrom(err))
  }
}

export async function approveSkillVersionAction(
  versionId: string,
): Promise<ActionResult<{ versionId: string; version: number }>> {
  try {
    const ctx = await requireTenantRole('admin')
    const res = await services.skills.approveVersion({ versionId, actor: actorFrom(ctx) })
    revalidatePath('/control-plane/skills')
    return ok(res)
  } catch (err) {
    return fail(messageFrom(err))
  }
}

export async function rollbackSkillVersionAction(
  versionId: string,
): Promise<ActionResult<{ versionId: string; version: number }>> {
  try {
    const ctx = await requireTenantRole('admin')
    const res = await services.skills.rollbackToVersion({ versionId, actor: actorFrom(ctx) })
    revalidatePath('/control-plane/skills')
    return ok(res)
  } catch (err) {
    return fail(messageFrom(err))
  }
}

export async function deactivateSkillAction(
  skillId: string,
): Promise<ActionResult<{ versionId: string; version: number }>> {
  try {
    const ctx = await requireTenantRole('admin')
    const res = await services.skills.deactivateSkill({ skillId, actor: actorFrom(ctx) })
    if (!res) return fail('Nincs aktív verzió.')
    revalidatePath('/control-plane/skills')
    return ok(res)
  } catch (err) {
    return fail(messageFrom(err))
  }
}

export async function deleteSkillAction(skillId: string): Promise<ActionResult<null>> {
  try {
    const ctx = await requireTenantRole('admin')
    await services.skills.deleteSkill({ skillId, actor: actorFrom(ctx) })
    revalidatePath('/control-plane/skills')
    return ok(null)
  } catch (err) {
    return fail(messageFrom(err))
  }
}

// ── WP-3: tanácsadó LLM-review (nem kapu) ────────────────────────────────────

export interface SkillAdvisoryReviewResult {
  validation: {
    ok: boolean
    errors: string[]
    warnings: string[]
    riskTier: SkillRiskTier
  }
  review: {
    riskSummary: string
    overallAssessment: 'low' | 'medium' | 'high'
    concerns: string[]
    suggestedRequires: Array<{ toolName: string; reason: string }>
  }
}

export async function reviewSkillVersionAction(
  versionId: string,
): Promise<ActionResult<SkillAdvisoryReviewResult>> {
  try {
    const ctx = await requireTenantRole('admin')
    // A seedelt Provisioning Assistant — audit-attribúció + Registry modelConfig (feladat-specifikus prompt a review agentben).
    const agents = await repositories.agents.findMany()
    const assistant = agents.find((a) => a.name === PROVISIONING_ASSISTANT_TEMPLATE.name)
    if (!assistant) {
      return fail('A review-agent nincs seedelve. Futtasd: npm run db:seed.')
    }

    const result = await services.skills.advisoryReviewVersion({
      versionId,
      reviewAgentId: assistant.id,
      reviewAgentVersion: assistant.currentVersion,
      reviewAgentModelConfig: assistant.modelConfig,
      actor: actorFrom(ctx),
      reviewer: services.skillReviewAgent,
    })
    if (!result.ok) {
      const prefix = result.stage === 'access' ? 'Hozzáférés megtagadva' : 'LLM-review sikertelen'
      return fail(`${prefix}: ${result.detail}`)
    }
    return ok({ validation: result.validation, review: result.review })
  } catch (err) {
    return fail(messageFrom(err))
  }
}

// ── WP-6 / D14: desztilláció beszélgetésből ─────────────────────────────────

const distillSchema = z.object({
  conversationId: z.string().uuid(),
  agentId: z.string().uuid(),
  targetSkillId: z.string().uuid().optional(),
})

export interface DistilledSkillPreview {
  skillId: string
  versionId: string
  name: string
  description: string
  riskTier: SkillRiskTier
  requires: Array<{ toolName: string; reason: string }>
  created: boolean
}

export async function distillSkillFromConversationAction(
  input: z.input<typeof distillSchema>,
): Promise<ActionResult<DistilledSkillPreview>> {
  try {
    const parsed = distillSchema.parse(input)
    const ctx = await requireTenantRole('admin')
    const agent = await repositories.agents.findById(parsed.agentId)
    if (!agent) return fail('Az agent nem található.')

    const tenant = await repositories.tenants.findById(ctx.activeTenantId!)
    const outputLanguage = readTenantLanguage(tenant?.settings)

    const result = await services.skills.distillFromConversation({
      conversationId: parsed.conversationId,
      agentId: parsed.agentId,
      agentVersion: agent.currentVersion,
      agentModelConfig: agent.modelConfig,
      actor: actorFrom(ctx),
      distiller: services.skillDistillerAgent,
      targetSkillId: parsed.targetSkillId,
      outputLanguage,
    })

    if (!result.ok) {
      const prefix =
        result.stage === 'validation'
          ? 'A desztillált skill nem felelt meg a validátornak'
          : result.stage === 'distill'
            ? 'A desztilláló nem tudott érvényes draftot készíteni'
            : result.stage === 'empty'
              ? 'Nincs desztillálható tartalom'
              : 'Hozzáférés megtagadva'
      return fail(`${prefix}: ${result.detail}`)
    }

    revalidatePath('/control-plane/skills')
    return ok({
      skillId: result.skillId,
      versionId: result.versionId,
      name: result.draft.name,
      description: result.draft.description,
      riskTier: result.riskTier,
      requires: result.requires,
      created: result.created,
    })
  } catch (err) {
    return fail(messageFrom(err))
  }
}

