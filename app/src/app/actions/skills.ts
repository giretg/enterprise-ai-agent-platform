'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain/gateway-services'
import { repositories } from '@/repositories/postgres'
import { assertAgentTenantReachable } from '@/lib/agent-tenant-access'
import { canManageAgentSkills } from '@/lib/agent-skill-management'
import { fail, ok, type ActionResult } from '@/lib/result'
import { SkillAccessError, type ActorContext } from '@/domain/skill/skill-service'
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_NAME_MAX,
  parseSkillContent,
  parseSkillRequires,
  skillAllowsAttachments,
  skillContentSchema,
  skillRequiresSchema,
  type SkillContent,
} from '@/lib/skill/skill-content'
import { validateSkill } from '@/lib/skill/skill-validator'
import { diffSkillVersions } from '@/lib/skill/skill-diff'
import type { TenantAuthContext } from '@/auth/context'
import type { SkillReadiness } from '@/lib/skill/skill-readiness'
import type { SkillKind, SkillRiskTier } from '@prisma/client'
import {
  catalogScopeForKind,
  isSkillAssignableToAgent,
} from '@/lib/skill/skill-kind'
import { readTenantLanguage } from '@/lib/tenant-language'
import { SKILL_PACKAGE_SKIP_LABEL } from '@/lib/skill/skill-package-adapter'
import {
  SKILL_ATTACHMENTS_TOTAL_MAX_BYTES,
  SKILL_ATTACHMENT_MAX_BYTES,
  SKILL_ATTACHMENT_MAX_COUNT,
  hashAttachmentBytes,
  parseSkillAttachments,
  type SkillAttachment,
} from '@/lib/skill/skill-attachments'

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
    isPlatformAdmin: Boolean(
      ctx.platformRoles?.some((r) => r === 'superadmin' || r === 'platform_operator'),
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
async function assertAgentInTenant(agentId: string, activeTenantId: string | null) {
  const agent = await repositories.agents.findById(agentId)
  if (!agent) throw new SkillAccessError('Agent not found')
  assertAgentTenantReachable(agent, activeTenantId)
  return agent
}

/**
 * Kapu az agenthez RENDELT skillek kezeléséhez (hozzárendel / levesz / ki-bekapcsol).
 * Admin mindig; operátor csak ha az admin EZEN az agenten delegálta
 * (`Agent.operatorCanManageSkills`) — a döntést a közös {@link canManageAgentSkills}
 * hozza, hogy a UI `canEdit` és a szerveroldali kapu ne tudjon szétcsúszni.
 *
 * A katalógus-szerkesztés (verzió, tartalom, jóváhagyás) és a capability-grant
 * változatlanul admin-aktus — ez a kapu csak a hozzárendelésre szól.
 */
async function requireAgentSkillManager(agentId: string) {
  const ctx = await requireTenantRole('operator')
  const agent = await assertAgentInTenant(agentId, ctx.activeTenantId)
  if (!canManageAgentSkills(ctx.activeTenantRole, false)) {
    throw new SkillAccessError(
      'Ezen az agenten a skill-hozzárendelés admin-döntés. Kérd meg az admint, hogy engedélyezze az operátori kezelést.',
    )
  }
  return { ctx, agent }
}

// ── WP-4: agent-detail skill panel (readiness + hozzárendelés) ────────────────

export interface AgentSkillRow {
  agentId: string
  skillVersionId: string
  enabled: boolean
  skillId: string
  name: string
  /** Embernek szóló feladatnév — select / modál. Hiányzik → `name`. */
  displayName: string | null
  description: string
  version: number
  riskTier: SkillRiskTier
  kind: SkillKind
  requires: Array<{ toolName: string; reason: string }>
  readiness: SkillReadiness
  /** A skill deklarált paraméterei (#199) — a feladat-indító űrlap mezői. */
  parameters: Array<{ name: string; description: string }>
  /** Csatolható-e fájl a skillhez kötött feladathoz (#199). Hiányzó érték = engedett. */
  allowAttachments: boolean
  /** Várt csatolmány leírása — a feladat-indító űrlapon jelenik meg (#199). */
  attachmentDescription?: string
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
        displayName: r.displayName,
        description: r.description,
        version: r.version,
        riskTier: r.riskTier,
        kind: r.kind,
        requires: r.requires,
        readiness: r.readiness,
        parameters: r.content.parameters.map((p) => ({
          name: p.name,
          description: p.description,
        })),
        allowAttachments: skillAllowsAttachments(r.content.runtimeHints),
        attachmentDescription: r.content.runtimeHints?.attachmentDescription?.trim() || undefined,
      })),
    )
  } catch (err) {
    return fail(messageFrom(err))
  }
}

export interface TenantSkillOption {
  skillId: string
  skillVersionId: string
  name: string
  displayName: string | null
  description: string
  version: number
}

/**
 * A tenantból elérhető, AKTÍV verziójú skillek — a `/` slash-választóhoz olyan
 * felületeken, ahol nincs konkrét agent (Playbook-szerző prompt). Ugyanaz a
 * fail-closed olvasás, mint a katalógusban: global + saját tenant, semmi más.
 */
export async function listTenantSkillOptionsAction(): Promise<ActionResult<TenantSkillOption[]>> {
  try {
    const ctx = await requireTenantRole('admin')
    const catalog = await services.skills.listReferenceCatalog(ctx.activeTenantId)
    return ok(
      catalog.map((s) => ({
        skillId: s.skillId,
        skillVersionId: s.skillVersionId,
        name: s.name,
        displayName: s.displayName ?? null,
        description: s.description,
        version: s.version,
      })),
    )
  } catch (err) {
    return fail(messageFrom(err))
  }
}

export interface AssignableSkill {
  skillId: string
  name: string
  displayName: string | null
  description: string
  riskTier: SkillRiskTier
  kind: SkillKind
  activeVersionId: string
  version: number
}

/**
 * Jóváhagyásra váró skill: van a katalógusban, de nincs aktív verziója, ezért
 * még nem rendelhető agenthez. Az agent-oldalon ezt külön megmutatjuk, hogy ne
 * tűnjön üresnek a katalógus.
 */
export interface PendingSkill {
  skillId: string
  name: string
  displayName: string | null
  description: string
  kind: SkillKind
  latestVersion: number
  latestStatus: string
}

/**
 * A hozzárendelhető skillek: a katalógusban aktív verzióval bíró, még nem
 * hozzárendelt skillek (fail-closed olvasás a saját + global scope-ra).
 * A `pending` azokat sorolja, amik aktív verzió híján még nem rendelhetők —
 * ezeket előbb a katalógusban kell jóváhagyni.
 */
export async function listAssignableSkillsAction(
  agentId: string,
): Promise<ActionResult<{ assignable: AssignableSkill[]; pending: PendingSkill[] }>> {
  try {
    const { ctx } = await requireAgentSkillManager(agentId)
    const [catalog, assigned] = await Promise.all([
      services.skills.listForActor(ctx.activeTenantId),
      services.skills.listAgentSkillsWithReadiness(agentId),
    ])
    const assignedSkillIds = new Set(assigned.map((a) => a.skillId))
    const rows: AssignableSkill[] = []
    const pending: PendingSkill[] = []
    for (const skill of catalog) {
      const active = skill.versions.find((v) => v.status === 'active')
      if (!active) {
        if (!assignedSkillIds.has(skill.id) && isSkillAssignableToAgent({ kind: skill.kind })) {
          const latest = skill.versions[0]
          pending.push({
            skillId: skill.id,
            name: skill.name,
            displayName: skill.displayName,
            description: skill.description,
            kind: skill.kind,
            latestVersion: latest?.version ?? 0,
            latestStatus: latest?.status ?? 'proposed',
          })
        }
        continue
      }
      if (assignedSkillIds.has(skill.id)) continue
      if (!isSkillAssignableToAgent({ kind: skill.kind })) {
        continue
      }
      rows.push({
        skillId: skill.id,
        name: skill.name,
        displayName: skill.displayName,
        description: skill.description,
        riskTier: skill.riskTier,
        kind: skill.kind,
        activeVersionId: active.id,
        version: active.version,
      })
    }
    return ok({ assignable: rows, pending })
  } catch (err) {
    return fail(messageFrom(err))
  }
}

export async function assignSkillAction(input: {
  agentId: string
  skillVersionId: string
}): Promise<ActionResult<null>> {
  try {
    const { ctx } = await requireAgentSkillManager(input.agentId)
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
    const { ctx } = await requireAgentSkillManager(input.agentId)
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
    const { ctx } = await requireAgentSkillManager(input.agentId)
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
  displayName: string | null
  description: string
  catalogScope: 'global' | 'tenant'
  kind: SkillKind
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
        displayName: s.displayName,
        description: s.description,
        catalogScope: s.catalogScope,
        kind: s.kind,
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
            signed: false,
            createdAt: v.createdAt.toISOString(),
          })),
      })),
    )
  } catch (err) {
    return fail(messageFrom(err))
  }
}

const skillKindSchema = z.enum(['tenant', 'published', 'system'])
const systemRoleSchema = z.enum(['run_analyst', 'web_egress']).nullable().optional()

const importSchema = z.object({
  raw: z.string().min(1, 'A SKILL.md tartalom nem lehet üres.'),
  sourceUrl: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  kind: skillKindSchema.default('tenant'),
})

export async function importSkillMdAction(
  input: z.input<typeof importSchema>,
): Promise<ActionResult<{ skillId: string; versionId: string; riskTier: SkillRiskTier }>> {
  try {
    const parsed = importSchema.parse(input)
    const ctx = await requireTenantRole('admin')
    const actor = actorFrom(ctx)
    const result = await services.skills.importSkillMd({
      raw: parsed.raw,
      sourceUrl: parsed.sourceUrl,
      kind: parsed.kind,
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

const skillPackageSchema = z.object({
  sourceUrl: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  subpath: z.string().trim().max(500).optional().or(z.literal('').transform(() => undefined)),
  kind: skillKindSchema.default('tenant'),
})

const SKILL_PACKAGE_UPLOAD_MAX_BYTES = 9 * 1024 * 1024

/** Szabványos, SKILL.md-t és opcionális referenciafájlokat tartalmazó ZIP importja. */
export async function importSkillPackageAction(
  formData: FormData,
): Promise<ActionResult<{ skillId: string; versionId: string; notice: string }>> {
  try {
    const archive = formData.get('archive')
    if (!(archive instanceof File) || archive.size === 0) {
      return fail('Válassz ki egy ZIP-csomagot.')
    }
    if (!archive.name.toLowerCase().endsWith('.zip')) {
      return fail('A skill-csomag ZIP-fájl legyen.')
    }
    if (archive.size > SKILL_PACKAGE_UPLOAD_MAX_BYTES) {
      return fail('A ZIP-csomag legfeljebb 9 MB lehet.')
    }

    const field = (name: string) => {
      const value = formData.get(name)
      return typeof value === 'string' ? value : undefined
    }
    const parsed = skillPackageSchema.parse({
      sourceUrl: field('sourceUrl'),
      subpath: field('subpath'),
      kind: field('kind'),
    })
    const ctx = await requireTenantRole('admin')
    const result = await services.skills.importSkillPackage({
      archive: new Uint8Array(await archive.arrayBuffer()),
      subpath: parsed.subpath,
      sourceUrl: parsed.sourceUrl,
      sourceLabel: archive.name.slice(0, 255),
      kind: parsed.kind,
      tenantId: ctx.activeTenantId,
      actor: actorFrom(ctx),
    })

    if (!result.ok) {
      if (result.stage === 'validation') {
        return fail(`A skill nem felelt meg a hardcoded validátornak: ${result.validation.errors.join(' · ')}`)
      }
      const candidates = result.stage === 'package' && result.candidates.length > 0
        ? ` Lehetséges skill-almappák: ${result.candidates.join(', ')}.`
        : ''
      return fail(`${result.message}${candidates}`)
    }

    const skipped = result.skipped.length > 0
      ? ` Kimaradt ${result.skipped.length} fájl: ${result.skipped
          .slice(0, 3)
          .map((item) => `${item.path} (${SKILL_PACKAGE_SKIP_LABEL[item.reason]})`)
          .join(' · ')}${result.skipped.length > 3 ? ' · …' : ''}`
      : ''
    revalidatePath('/control-plane/skills')
    return ok({
      skillId: result.skill.id,
      versionId: result.versionId,
      notice: `Skill-csomag importálva — ${result.attachments.length} referenciafájllal, proposed verzióként.${skipped}`,
    })
  } catch (err) {
    return fail(messageFrom(err))
  }
}

const skillPackageVersionSchema = z.object({
  skillId: z.string().uuid(),
  sourceUrl: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  subpath: z.string().trim().max(500).optional().or(z.literal('').transform(() => undefined)),
})

/** Meglévő skillhez új verzió javaslata ZIP-csomagból (proposed — jóváhagyás külön). */
export async function importSkillPackageVersionAction(
  formData: FormData,
): Promise<ActionResult<{ versionId: string; version: number; notice: string }>> {
  try {
    const archive = formData.get('archive')
    if (!(archive instanceof File) || archive.size === 0) {
      return fail('Válassz ki egy ZIP-csomagot.')
    }
    if (!archive.name.toLowerCase().endsWith('.zip')) {
      return fail('A skill-csomag ZIP-fájl legyen.')
    }
    if (archive.size > SKILL_PACKAGE_UPLOAD_MAX_BYTES) {
      return fail('A ZIP-csomag legfeljebb 9 MB lehet.')
    }

    const field = (name: string) => {
      const value = formData.get(name)
      return typeof value === 'string' ? value : undefined
    }
    const parsed = skillPackageVersionSchema.parse({
      skillId: field('skillId'),
      sourceUrl: field('sourceUrl'),
      subpath: field('subpath'),
    })
    const ctx = await requireTenantRole('admin')
    const result = await services.skills.importSkillPackageVersion({
      skillId: parsed.skillId,
      archive: new Uint8Array(await archive.arrayBuffer()),
      subpath: parsed.subpath,
      sourceUrl: parsed.sourceUrl,
      sourceLabel: archive.name.slice(0, 255),
      actor: actorFrom(ctx),
    })

    if (!result.ok) {
      if (result.stage === 'validation') {
        return fail(`A skill nem felelt meg a hardcoded validátornak: ${result.validation.errors.join(' · ')}`)
      }
      const candidates = result.stage === 'package' && result.candidates.length > 0
        ? ` Lehetséges skill-almappák: ${result.candidates.join(', ')}.`
        : ''
      return fail(`${result.message}${candidates}`)
    }

    const skipped = result.skipped.length > 0
      ? ` Kimaradt ${result.skipped.length} fájl: ${result.skipped
          .slice(0, 3)
          .map((item) => `${item.path} (${SKILL_PACKAGE_SKIP_LABEL[item.reason]})`)
          .join(' · ')}${result.skipped.length > 3 ? ' · …' : ''}`
      : ''
    revalidatePath('/control-plane/skills')
    return ok({
      versionId: result.versionId,
      version: result.version,
      notice: `ZIP-csomag v${result.version} javaslatként — ${result.attachments.length} referenciafájllal.${skipped}`,
    })
  } catch (err) {
    return fail(messageFrom(err))
  }
}

const createSchema = z.object({
  name: z.string().min(1).max(SKILL_NAME_MAX),
  displayName: z
    .string()
    .max(SKILL_NAME_MAX)
    .optional()
    .nullable()
    .transform((v) => {
      const t = v?.trim()
      return t ? t : null
    }),
  description: z.string().min(1).max(SKILL_DESCRIPTION_MAX),
  kind: skillKindSchema.default('tenant'),
  content: skillContentSchema,
  requires: skillRequiresSchema,
  /** Level-2 fájlok kézi szerzésnél is — ugyanaz a szerveroldali kapu, mint a javaslatnál. */
  attachments: z
    .array(z.object({ path: z.string().min(1).max(300), text: z.string() }))
    .max(SKILL_ATTACHMENT_MAX_COUNT)
    .optional(),
})

export async function createSkillAction(
  input: z.input<typeof createSchema>,
): Promise<ActionResult<{ skillId: string; versionId: string }>> {
  try {
    const parsed = createSchema.parse(input)
    const ctx = await requireTenantRole('admin')
    const actor = actorFrom(ctx)
    // A kézi szerzés is a hardcoded validátoron megy át (injection tiltás,
    // tier-levezetés) — a puha rész sosem kap könnyített utat.
    const validation = validateSkill({
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      requires: parsed.requires,
      attachmentPaths: (parsed.attachments ?? []).map((attachment) => attachment.path),
    })
    if (!validation.ok) {
      return fail(`A skill nem felelt meg a validátornak: ${validation.errors.join(' · ')}`)
    }
    const catalogScope = catalogScopeForKind(parsed.kind)
    const createAttachments = materializeAttachments(parsed.attachments)
    const { skill, versionId } = await services.skills.createSkill({
      name: parsed.name,
      displayName: parsed.displayName,
      description: parsed.description,
      catalogScope,
      tenantId: catalogScope === 'global' ? null : ctx.activeTenantId,
      kind: parsed.kind,
      sourceType: 'authored',
      provenance: { origin: 'authored' },
      license: null,
      riskTier: validation.riskTier,
      content: parsed.content,
      requires: parsed.requires,
      ...(createAttachments ? { attachments: createAttachments } : {}),
      actor,
    })
    revalidatePath('/control-plane/skills')
    return ok({ skillId: skill.id, versionId })
  } catch (err) {
    return fail(messageFrom(err))
  }
}

const updateDisplayNameSchema = z.object({
  skillId: z.string().uuid(),
  displayName: z
    .string()
    .max(SKILL_NAME_MAX)
    .nullable()
    .optional()
    .transform((v) => {
      const t = v?.trim()
      return t ? t : null
    }),
})

export async function updateSkillDisplayNameAction(
  input: z.input<typeof updateDisplayNameSchema>,
): Promise<ActionResult<{ displayName: string | null }>> {
  try {
    const parsed = updateDisplayNameSchema.parse(input)
    const ctx = await requireTenantRole('admin')
    const skill = await services.skills.updateDisplayName({
      skillId: parsed.skillId,
      displayName: parsed.displayName,
      actor: actorFrom(ctx),
    })
    revalidatePath('/control-plane/skills')
    return ok({ displayName: skill.displayName })
  } catch (err) {
    return fail(messageFrom(err))
  }
}

const updateKindSchema = z.object({
  skillId: z.string().uuid(),
  kind: skillKindSchema,
})

export async function updateSkillKindAction(
  input: z.input<typeof updateKindSchema>,
): Promise<ActionResult<{ kind: SkillKind }>> {
  try {
    const parsed = updateKindSchema.parse(input)
    const ctx = await requireTenantRole('admin')
    const skill = await services.skills.updateKind({
      skillId: parsed.skillId,
      kind: parsed.kind,
      actor: actorFrom(ctx),
    })
    revalidatePath('/control-plane/skills')
    return ok({ kind: skill.kind })
  } catch (err) {
    return fail(messageFrom(err))
  }
}

const updateDescriptionSchema = z.object({
  skillId: z.string().uuid(),
  description: z.string().min(1).max(SKILL_DESCRIPTION_MAX),
})

export async function updateSkillDescriptionAction(
  input: z.input<typeof updateDescriptionSchema>,
): Promise<ActionResult<{ description: string }>> {
  try {
    const parsed = updateDescriptionSchema.parse(input)
    const ctx = await requireTenantRole('admin')
    const skill = await services.skills.updateDescription({
      skillId: parsed.skillId,
      description: parsed.description,
      actor: actorFrom(ctx),
    })
    revalidatePath('/control-plane/skills')
    return ok({ description: skill.description })
  } catch (err) {
    return fail(messageFrom(err))
  }
}

const proposeSchema = z.object({
  skillId: z.string().uuid(),
  content: skillContentSchema,
  requires: skillRequiresSchema,
  /** A kliens csak útvonalat + szöveget küld; bytes/sha256 szerveroldalon készül. */
  attachments: z
    .array(z.object({ path: z.string().min(1).max(300), text: z.string() }))
    .max(SKILL_ATTACHMENT_MAX_COUNT)
    .optional(),
})

/**
 * Kliens-küldte melléklet → tárolt alak. A méret- és útvonal-kapuk itt (bizalmi
 * határon) élnek: a bytes/sha256 sosem a kliensé, különben a provenience hazudható.
 */
function materializeAttachments(
  input: Array<{ path: string; text: string }> | undefined,
): SkillAttachment[] | undefined {
  if (!input) return undefined
  const seen = new Set<string>()
  let total = 0
  return input.map((raw) => {
    const path = raw.path.trim().replace(/^\/+/, '')
    if (!path) throw new SkillAccessError('A melléklet útvonala nem lehet üres.')
    if (path.split('/').includes('..')) {
      throw new SkillAccessError(`Nem megengedett melléklet-útvonal: ${raw.path}`)
    }
    if (seen.has(path)) throw new SkillAccessError(`Ismétlődő melléklet-útvonal: ${path}`)
    seen.add(path)
    const buf = Buffer.from(raw.text, 'utf8')
    if (buf.byteLength > SKILL_ATTACHMENT_MAX_BYTES) {
      throw new SkillAccessError(
        `A(z) „${path}” melléklet túl nagy (max ${Math.floor(SKILL_ATTACHMENT_MAX_BYTES / 1024)} KB).`,
      )
    }
    total += buf.byteLength
    if (total > SKILL_ATTACHMENTS_TOTAL_MAX_BYTES) {
      throw new SkillAccessError(
        `A mellékletek együtt túllépik a ${Math.floor(SKILL_ATTACHMENTS_TOTAL_MAX_BYTES / 1024)} KB-os keretet.`,
      )
    }
    return { path, text: raw.text, bytes: buf.byteLength, sha256: hashAttachmentBytes(buf) }
  })
}

export interface SkillVersionDetail {
  versionId: string
  skillId: string
  version: number
  status: string
  content: SkillContent
  requires: Array<{ toolName: string; reason: string }>
  /** Level-2 melléklet-fájlok teljes szövege (megnyitás / szerkesztés). */
  attachments: SkillAttachment[]
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
      attachments: parseSkillAttachments(target.attachments),
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
      attachmentPaths: (parsed.attachments ?? []).map((attachment) => attachment.path),
    })
    if (!validation.ok) {
      return fail(`A javasolt verzió nem felelt meg a validátornak: ${validation.errors.join(' · ')}`)
    }
    const attachments = materializeAttachments(parsed.attachments)
    const res = await services.skills.proposeVersion({
      skillId: parsed.skillId,
      content: parsed.content,
      requires: parsed.requires,
      ...(attachments ? { attachments } : {}),
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
): Promise<ActionResult<{ versionId: string; version: number; detachedAssignmentCount: number }>> {
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
    await requireTenantRole('admin')
    void versionId
    return fail('A skill LLM-review a control plane-ből kikerült (Phase 0).')
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
  attachmentCount: number
}

export async function distillSkillFromConversationAction(
  _input: z.input<typeof distillSchema>,
): Promise<ActionResult<DistilledSkillPreview>> {
  return fail('A skill-desztilláció a control plane-ből kikerült (Phase 0).')
}
