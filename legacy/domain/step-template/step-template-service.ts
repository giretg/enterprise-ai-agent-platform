/**
 * StepTemplate admin CRUD + "certified" eval-tier (WP-3, §3.2/§6, D3, D8).
 *
 * Governance-korlátok:
 *  - A template SOHA nem ad futásidejű tool-jogot (D3) — a `requiredCapabilities` csak JAVASLAT.
 *  - Globális (tenantId=null) template-eket a seed karbantartja; tenant-admin CSAK a saját
 *    tenantjához kötött template-eket szerkesztheti/törölheti (ownership-check a mutációkban).
 *  - "certified" tier (D8): a published-höz NEM kell eval; a certify-hoz legalább egy
 *    eval-minta kell. A v1 szimbolikus és opcionális — nem blokkolja a katalógust.
 */
import type { PrismaClient, StepTemplateStatus } from '@prisma/client'
import { computePlaybookContentHash } from '@/lib/playbook-v2/spec'
import type { StepTemplateFragment } from './step-template-catalog'

export class StepTemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StepTemplateError'
  }
}

export type EvalSample = { sampleInput: Record<string, unknown>; expectations: string[] }

export type StepTemplateVersionView = {
  id: string
  version: number
  contentHash: string
  certified: boolean
  evalSampleCount: number
  isCurrentPublished: boolean
  createdAt: string
}

export type StepTemplateAdminView = {
  id: string
  tenantId: string | null
  key: string
  name: string
  description: string
  category: string
  status: StepTemplateStatus
  editable: boolean
  latestVersion: number
  fragment: StepTemplateFragment | null
  currentPublishedVersionId: string | null
  versions: StepTemplateVersionView[]
  updatedAt: string
}

function asFragment(value: unknown): StepTemplateFragment | null {
  if (!value || typeof value !== 'object') return null
  const f = value as { step?: unknown; suggestedGate?: unknown }
  if (!f.step || typeof f.step !== 'object') return null
  return {
    step: f.step as Record<string, unknown>,
    suggestedGate: (f.suggestedGate as Record<string, unknown> | null) ?? null,
  }
}

/** A fragment minimál-validációja (nem ad jogot; csak alakhelyesség). */
function assertFragment(fragment: unknown): StepTemplateFragment {
  const f = asFragment(fragment)
  if (!f) throw new StepTemplateError('A fragment kötelező `step` objektumot kell tartalmazzon.')
  const name = (f.step as { name?: unknown }).name
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new StepTemplateError('A fragment `step.name` mezője kötelező.')
  }
  return f
}

function parseEvalSamples(value: unknown): EvalSample[] {
  if (!Array.isArray(value)) return []
  const out: EvalSample[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const s = raw as { sampleInput?: unknown; expectations?: unknown }
    out.push({
      sampleInput:
        s.sampleInput && typeof s.sampleInput === 'object'
          ? (s.sampleInput as Record<string, unknown>)
          : {},
      expectations: Array.isArray(s.expectations)
        ? s.expectations.filter((e): e is string => typeof e === 'string')
        : [],
    })
  }
  return out
}

/** Minden StepTemplate (draft/published/retired), globális + a hívó tenantja; admin nézet. */
export async function listStepTemplatesForAdmin(
  prisma: PrismaClient,
  tenantId: string,
): Promise<StepTemplateAdminView[]> {
  const templates = await prisma.stepTemplate.findMany({
    where: { archivedAt: null, OR: [{ tenantId: null }, { tenantId }] },
    include: { versions: { orderBy: { version: 'asc' } } },
    orderBy: [{ tenantId: 'asc' }, { name: 'asc' }],
  })

  return templates.map((t) => {
    const sorted = [...t.versions].sort((a, b) => b.version - a.version)
    const latest = sorted[0]
    return {
      id: t.id,
      tenantId: t.tenantId,
      key: t.key,
      name: t.name,
      description: t.description ?? '',
      category: t.category ?? '',
      status: t.status,
      // Globális template read-only a tenant-adminnak (seed karbantartja).
      editable: t.tenantId === tenantId,
      latestVersion: latest?.version ?? 0,
      fragment: latest ? asFragment(latest.fragment) : null,
      currentPublishedVersionId: t.currentPublishedVersionId,
      updatedAt: t.updatedAt.toISOString(),
      versions: sorted.map((v) => ({
        id: v.id,
        version: v.version,
        contentHash: v.contentHash,
        certified: v.certified,
        evalSampleCount: parseEvalSamples(v.evalSamples).length,
        isCurrentPublished: v.id === t.currentPublishedVersionId,
        createdAt: v.createdAt.toISOString(),
      })),
    }
  })
}

export type CreateStepTemplateInput = {
  tenantId: string
  key: string
  name: string
  description?: string
  category?: string
  fragment: unknown
}

/** Új tenant-scoped StepTemplate draftként, 1. verzióval. */
export async function createStepTemplate(
  prisma: PrismaClient,
  input: CreateStepTemplateInput,
): Promise<{ id: string; versionId: string }> {
  const fragment = assertFragment(input.fragment)
  const existing = await prisma.stepTemplate.findFirst({
    where: { tenantId: input.tenantId, key: input.key },
  })
  if (existing) throw new StepTemplateError(`Már létezik ilyen kulcsú sablon: '${input.key}'.`)

  const contentHash = computePlaybookContentHash(fragment)
  const created = await prisma.stepTemplate.create({
    data: {
      tenantId: input.tenantId,
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      category: input.category ?? null,
      status: 'draft',
    },
  })
  const version = await prisma.stepTemplateVersion.create({
    data: { templateId: created.id, version: 1, fragment: fragment as unknown as object, contentHash },
  })
  return { id: created.id, versionId: version.id }
}

/** Tulajdon-ellenőrzés: csak a hívó tenantjához kötött (nem globális) template szerkeszthető. */
async function requireEditable(prisma: PrismaClient, id: string, tenantId: string) {
  const template = await prisma.stepTemplate.findUnique({
    where: { id },
    include: { versions: { orderBy: { version: 'desc' } } },
  })
  if (!template || template.archivedAt) throw new StepTemplateError('A sablon nem található.')
  if (template.tenantId !== tenantId) {
    throw new StepTemplateError('Globális sablon nem szerkeszthető (a seed karbantartja).')
  }
  return template
}

/**
 * Verzió-szintű mutáció tulajdon-kapuja: a `versionId` kliens-oldali érték, ezért nem elég a
 * sablon tulajdonjogát ellenőrizni — a verziót IS a saját sablon verziói közül kell feloldani.
 * Máskülönben egy tenant-admin a saját (jogszerű) template-id-jét megadva egy MÁSIK tenant vagy
 * a globális seed-katalógus verziójának ID-jét célozhatná meg (cross-tenant írási IDOR). Ez a
 * közös helper garantálja, hogy egyetlen verzió-író út se felejthesse el az újra-feloldást.
 */
async function requireOwnedVersion(
  prisma: PrismaClient,
  id: string,
  tenantId: string,
  versionId: string,
) {
  const template = await requireEditable(prisma, id, tenantId)
  const version = template.versions.find((v) => v.id === versionId)
  if (!version) throw new StepTemplateError('A verzió nem található.')
  return { template, version }
}

export type UpdateStepTemplateInput = {
  id: string
  tenantId: string
  name?: string
  description?: string
  category?: string
  /** Ha megadva ÉS eltér a legfrissebb verziótól, új verziót fűz be (a fragment hash-elt). */
  fragment?: unknown
}

/**
 * Metaadat frissítése + opcionális új verzió a szerkesztett fragmentből. Publikált template
 * a régi published verzióra mutat, amíg újra nem publikálják — így a fragment-edit nem élesít.
 */
export async function updateStepTemplate(
  prisma: PrismaClient,
  input: UpdateStepTemplateInput,
): Promise<{ newVersionId: string | null }> {
  const template = await requireEditable(prisma, input.id, input.tenantId)

  let newVersionId: string | null = null
  if (input.fragment !== undefined) {
    const fragment = assertFragment(input.fragment)
    const contentHash = computePlaybookContentHash(fragment)
    const latest = template.versions[0]
    if (!latest || latest.contentHash !== contentHash) {
      const nextVersion = (latest?.version ?? 0) + 1
      const version = await prisma.stepTemplateVersion.create({
        data: {
          templateId: template.id,
          version: nextVersion,
          fragment: fragment as unknown as object,
          contentHash,
        },
      })
      newVersionId = version.id
    }
  }

  await prisma.stepTemplate.update({
    where: { id: template.id },
    data: {
      name: input.name ?? undefined,
      description: input.description ?? undefined,
      category: input.category ?? undefined,
    },
  })
  return { newVersionId }
}

/** Publikálás: a legfrissebb verzió lesz a current published, a template status=published. */
export async function publishStepTemplate(prisma: PrismaClient, id: string, tenantId: string) {
  const template = await requireEditable(prisma, id, tenantId)
  const latest = template.versions[0]
  if (!latest) throw new StepTemplateError('A sablonhoz nincs verzió a publikáláshoz.')
  await prisma.stepTemplate.update({
    where: { id: template.id },
    data: { status: 'published', currentPublishedVersionId: latest.id },
  })
  return { publishedVersionId: latest.id }
}

/** Visszavonás: status=retired (a palettáról eltűnik, de a pin-elt hivatkozások megmaradnak). */
export async function retireStepTemplate(prisma: PrismaClient, id: string, tenantId: string) {
  await requireEditable(prisma, id, tenantId)
  await prisma.stepTemplate.update({ where: { id }, data: { status: 'retired' } })
}

/** Hard-delete — CSAK draft (sosem volt published). Cascade törli a verziókat. */
export async function deleteStepTemplate(prisma: PrismaClient, id: string, tenantId: string) {
  const template = await requireEditable(prisma, id, tenantId)
  if (template.status !== 'draft' || template.currentPublishedVersionId) {
    throw new StepTemplateError('Csak vázlat (soha nem publikált) sablon törölhető véglegesen.')
  }
  await prisma.stepTemplate.delete({ where: { id } })
}

/** Eval-minták mentése a megadott (a hívó saját sablonjához kötött) verzióhoz — a hash-elt
 *  fragmenten kívül, D8. A verzió tulajdon-feloldását a `requireOwnedVersion` végzi. */
export async function setStepTemplateEvalSamples(
  prisma: PrismaClient,
  input: { id: string; tenantId: string; versionId: string; evalSamples: unknown },
) {
  const { version } = await requireOwnedVersion(prisma, input.id, input.tenantId, input.versionId)
  const samples = parseEvalSamples(input.evalSamples)
  await prisma.stepTemplateVersion.update({
    where: { id: version.id },
    data: { evalSamples: samples as unknown as object },
  })
  return { count: samples.length }
}

/**
 * Certify (D8, szimbolikus v1): a verzió eval-mintái ellen "certified"-re jelöli. Feltétel:
 *  - legalább egy eval-minta,
 *  - minden mintának legyen legalább egy elvárása,
 *  - az outputContract.requiredFields mezőit valamelyik minta elvárása lefedi (rubrika-jelzés).
 * NEM hív LLM-et (D4-szellem) — determinista, olcsó kapu.
 */
export async function certifyStepTemplateVersion(
  prisma: PrismaClient,
  input: { id: string; tenantId: string; versionId: string },
): Promise<{ certified: boolean }> {
  const { version } = await requireOwnedVersion(prisma, input.id, input.tenantId, input.versionId)

  const samples = parseEvalSamples(version.evalSamples)
  if (samples.length === 0) {
    throw new StepTemplateError('A certifikáláshoz legalább egy eval-minta szükséges (D8).')
  }
  if (samples.some((s) => s.expectations.length === 0)) {
    throw new StepTemplateError('Minden eval-mintának legalább egy elvárást kell tartalmaznia.')
  }
  const fragment = asFragment(version.fragment)
  const requiredFields =
    (fragment?.step as { outputContract?: { requiredFields?: unknown } } | undefined)?.outputContract
      ?.requiredFields
  if (Array.isArray(requiredFields) && requiredFields.length > 0) {
    const covered = new Set(samples.flatMap((s) => s.expectations.map((e) => e.toLowerCase())))
    const uncovered = (requiredFields as unknown[])
      .filter((f): f is string => typeof f === 'string')
      .filter((f) => ![...covered].some((c) => c.includes(f.toLowerCase())))
    if (uncovered.length > 0) {
      throw new StepTemplateError(
        `Az eval-elvárások nem fedik le a kötelező kimeneti mezőket: ${uncovered.join(', ')}.`,
      )
    }
  }

  await prisma.stepTemplateVersion.update({
    where: { id: version.id },
    data: { certified: true },
  })
  return { certified: true }
}
