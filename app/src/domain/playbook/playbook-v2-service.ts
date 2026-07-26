/**
 * PlaybookV2Service (Feature-spec — Playbook §8.1, §11, §12 F2-A).
 *
 * A Fázis 2 objektum-alapú Playbook-regiszter CRUD + verziózás + publish + assignment
 * rétege. A determinisztikus magot (`PlaybookValidator`, `PlaybookCompiler`,
 * `computePlaybookContentHash`) köti a repository- és audit-réteghez.
 *
 * Kulcs-invariánsok, amelyeket KÓDSZINTEN véd (§2):
 *  - published verzió immutable; módosítás csak új verzió (§4.3);
 *  - publish csak valid + (four-eyes esetén) készítő ≠ jóváhagyó mellett (§11.2);
 *  - draft tárolható szemantikai hibákkal is, de Zod-alak kötelező (§15);
 *  - az audit payloadba SOHA nem kerül a teljes spec, csak ref/hash/metaadat (§10.2, §15).
 *
 * FONTOS: ez NEM a meglévő `PlaybookService` (wiki-horgok, tömb-spec) — párhuzamos réteg.
 */
import type { Prisma, PlaybookV2, PlaybookVersionV2, PlaybookAssignment } from '@prisma/client'
import {
  safeParsePlaybookSpecV2,
  computePlaybookContentHash,
  formatPlaybookRefV2,
  type PlaybookSpecV2,
  type ErrorPolicy,
} from '@/lib/playbook-v2/spec'
import {
  PlaybookValidator,
  type ValidationResult,
  type TenantValidationContext,
} from '@/domain/playbook/playbook-validator'
import { PlaybookCompiler } from '@/domain/playbook/playbook-compiler'
import type { AuditRepository, PlaybookV2Repository } from '@/repositories/interfaces'

export type PlaybookV2ErrorCode =
  | 'PLAYBOOK_EXISTS'
  | 'NOT_FOUND_OR_FORBIDDEN'
  | 'SCHEMA_INVALID'
  | 'DUPLICATE_CONTENT'
  | 'NOT_VALID'
  | 'INVALID_STATE'
  | 'FOUR_EYES_REQUIRED'
  | 'VERSION_NOT_PUBLISHED'
  | 'ASSIGNMENT_TYPE_DEPRECATED'

export class PlaybookV2Error extends Error {
  constructor(
    readonly code: PlaybookV2ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'PlaybookV2Error'
  }
}

type Actor = { type: 'human' | 'agent' | 'system'; id: string | null }

export class PlaybookV2Service {
  private readonly validator = new PlaybookValidator()
  private readonly compiler = new PlaybookCompiler()

  constructor(
    private readonly repo: PlaybookV2Repository,
    private readonly audit: AuditRepository,
    /**
     * Hibapolicy spec §4.2/WP-4 — a tenant publish-időben feloldott alapértelmezett
     * hibapolicy-jának lekérdezője (`PlatformSettingsService.getTenantDefaultErrorPolicy`).
     * Függvényként (nem szolgáltatás-referenciaként) injektált — ugyanaz a minta, mint a
     * `TicketService`-nél a ticket-type-config lekérdezőnél (domain/index.ts) —, hogy
     * elkerüljük a `PlatformSettingsService` ↔ `PlaybookV2Service` kör-függőséget.
     * Opcionális: híján a tenant-default lépés csendben kimarad (visszafelé kompatibilis).
     */
    private readonly getTenantDefaultErrorPolicy?: (
      tenantId: string | null,
    ) => Promise<ErrorPolicy | null>,
  ) {}

  // --- §8.1 createPlaybook ---------------------------------------------------

  async createPlaybook(input: {
    tenantId: string | null
    key: string
    name: string
    description?: string | null
    processType: string
    ownerUserId?: string | null
    actorUserId: string
  }): Promise<PlaybookV2> {
    const existing = await this.repo.findPlaybookByKey(input.tenantId, input.key)
    if (existing) {
      throw new PlaybookV2Error('PLAYBOOK_EXISTS', `A(z) '${input.key}' kulcs már létezik a tenantban.`)
    }

    const playbook = await this.repo.createPlaybook({
      tenantId: input.tenantId,
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      processType: input.processType,
      ownerUserId: input.ownerUserId ?? null,
    })

    await this.append(playbook.tenantId, { type: 'human', id: input.actorUserId }, {
      action: 'playbook.create',
      targetType: 'playbook',
      targetId: playbook.id,
      inputRef: playbook.key,
      outputRef: playbook.processType,
      policyDecision: 'created',
      metadata: { key: playbook.key, processType: playbook.processType },
    })

    return playbook
  }

  // --- §8.1 createPlaybookVersion -------------------------------------------

  async createPlaybookVersion(input: {
    tenantId: string | null
    playbookId: string
    spec: unknown
    changeSummary: string
    actorUserId: string
    // Canvas node-pozíciók (D2) — nem hash-elt; a contentHash-t NEM befolyásolja.
    layout?: Record<string, unknown>
    validationContext?: TenantValidationContext
  }): Promise<{ version: PlaybookVersionV2; validation: ValidationResult }> {
    const playbook = await this.requirePlaybook(input.tenantId, input.playbookId)

    // §15 — Zod-alak kötelező; szemantikai hibás draft tárolható.
    const parsed = safeParsePlaybookSpecV2(input.spec)
    if (!parsed.success) {
      throw new PlaybookV2Error('SCHEMA_INVALID', 'A spec nem felel meg a sémának.', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.') || '(root)',
          message: i.message,
        })),
      })
    }
    const spec = parsed.data

    const contentHash = computePlaybookContentHash(spec)
    const duplicate = await this.repo.findVersionByContentHash(
      input.tenantId,
      playbook.id,
      contentHash,
    )
    if (duplicate) {
      throw new PlaybookV2Error(
        'DUPLICATE_CONTENT',
        `Azonos tartalmú verzió már létezik (v${duplicate.version}).`,
        { existingVersionId: duplicate.id, version: duplicate.version },
      )
    }

    const validation = this.validator.validateSpec(spec, input.validationContext ?? {})
    const version = await this.repo.createVersion({
      tenantId: input.tenantId,
      playbookId: playbook.id,
      version: await this.repo.nextVersionNumber(playbook.id),
      spec: spec as unknown as Prisma.InputJsonValue,
      changeSummary: input.changeSummary,
      contentHash,
      validationResult: validation as unknown as Prisma.InputJsonValue,
      layout: (input.layout ?? {}) as Prisma.InputJsonValue,
      createdById: input.actorUserId,
    })

    await this.append(input.tenantId, { type: 'human', id: input.actorUserId }, {
      action: 'playbook.version.create',
      targetType: 'playbook_version',
      targetId: version.id,
      inputRef: formatPlaybookRefV2(playbook.key, version.version),
      outputRef: contentHash,
      policyDecision: validation.valid ? 'valid' : 'invalid',
      metadata: {
        playbookVersionId: version.id,
        contentHash,
        playbookRef: formatPlaybookRefV2(playbook.key, version.version),
        errorCount: validation.errors.length,
        warningCount: validation.warnings.length,
      },
    })

    return { version, validation }
  }

  // --- §8.1 updateDraftPlaybookVersion (in-place draft szerkesztés) ----------

  /**
   * Egy DRAFT verzió tartalmának helyben szerkesztése. A published/pending/rejected
   * verzió immutable (§4.3) — csak `status === 'draft'` esetén engedett. Zod-alak
   * kötelező, szemantikai hibás draft tárolható (mint createnál). A content-hash
   * újraszámol; ha az új tartalom egy MÁSIK verzióval egyezik, DUPLICATE_CONTENT.
   */
  async updateDraftPlaybookVersion(input: {
    tenantId: string | null
    playbookVersionId: string
    spec: unknown
    changeSummary: string
    actorUserId: string
    // Canvas node-pozíciók (D2). Ha undefined, a meglévő layout érintetlen marad.
    layout?: Record<string, unknown>
    validationContext?: TenantValidationContext
  }): Promise<{ version: PlaybookVersionV2; validation: ValidationResult }> {
    const { playbook, version } = await this.requireVersion(input.tenantId, input.playbookVersionId)
    if (version.status !== 'draft') {
      throw new PlaybookV2Error(
        'INVALID_STATE',
        `Csak draft verzió szerkeszthető helyben (jelenleg: ${version.status}). Publikált verzióhoz új verziót kell létrehozni.`,
      )
    }

    const parsed = safeParsePlaybookSpecV2(input.spec)
    if (!parsed.success) {
      throw new PlaybookV2Error('SCHEMA_INVALID', 'A spec nem felel meg a sémának.', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.') || '(root)',
          message: i.message,
        })),
      })
    }
    const spec = parsed.data

    const contentHash = computePlaybookContentHash(spec)
    if (contentHash !== version.contentHash) {
      const duplicate = await this.repo.findVersionByContentHash(
        input.tenantId,
        playbook.id,
        contentHash,
      )
      if (duplicate && duplicate.id !== version.id) {
        throw new PlaybookV2Error(
          'DUPLICATE_CONTENT',
          `Azonos tartalmú verzió már létezik (v${duplicate.version}).`,
          { existingVersionId: duplicate.id, version: duplicate.version },
        )
      }
    }

    const validation = this.validator.validateSpec(spec, input.validationContext ?? {})
    const updated = await this.repo.updateVersion(version.id, {
      spec: spec as unknown as Prisma.InputJsonValue,
      changeSummary: input.changeSummary,
      contentHash,
      validationResult: validation as unknown as Prisma.InputJsonValue,
      // A layout külön perzisztál, a spec/hash-től függetlenül (D2). Ha undefined, nem íródik.
      ...(input.layout !== undefined
        ? { layout: input.layout as Prisma.InputJsonValue }
        : {}),
    })

    await this.append(input.tenantId, { type: 'human', id: input.actorUserId }, {
      action: 'playbook.version.update',
      targetType: 'playbook_version',
      targetId: version.id,
      inputRef: formatPlaybookRefV2(playbook.key, version.version),
      outputRef: contentHash,
      policyDecision: validation.valid ? 'valid' : 'invalid',
      metadata: {
        playbookVersionId: version.id,
        contentHash,
        playbookRef: formatPlaybookRefV2(playbook.key, version.version),
        errorCount: validation.errors.length,
        warningCount: validation.warnings.length,
      },
    })

    return { version: updated, validation }
  }

  // --- §8.1 validatePlaybookVersion -----------------------------------------

  async validatePlaybookVersion(input: {
    tenantId: string | null
    playbookVersionId: string
    actorUserId: string
    validationContext?: TenantValidationContext
  }): Promise<ValidationResult> {
    const { playbook, version } = await this.requireVersion(input.tenantId, input.playbookVersionId)
    const validation = this.validator.validateSpec(version.spec, input.validationContext ?? {})

    await this.repo.updateVersion(version.id, {
      validationResult: validation as unknown as Prisma.InputJsonValue,
    })

    await this.append(input.tenantId, { type: 'human', id: input.actorUserId }, {
      action: 'playbook.version.validate',
      targetType: 'playbook_version',
      targetId: version.id,
      inputRef: formatPlaybookRefV2(playbook.key, version.version),
      outputRef: version.contentHash,
      policyDecision: validation.valid ? 'valid' : 'invalid',
      metadata: {
        playbookVersionId: version.id,
        contentHash: version.contentHash,
        errorCount: validation.errors.length,
        warningCount: validation.warnings.length,
      },
    })

    return validation
  }

  // --- §8.1 submitForApproval -----------------------------------------------

  async submitForApproval(input: {
    tenantId: string | null
    playbookVersionId: string
    actorUserId: string
    validationContext?: TenantValidationContext
  }): Promise<PlaybookVersionV2> {
    const { playbook, version } = await this.requireVersion(input.tenantId, input.playbookVersionId)
    if (version.status !== 'draft') {
      throw new PlaybookV2Error(
        'INVALID_STATE',
        `Csak draft verzió küldhető jóváhagyásra (jelenleg: ${version.status}).`,
      )
    }

    const validation = this.validator.validateSpec(version.spec, input.validationContext ?? {})
    if (!validation.valid) {
      throw new PlaybookV2Error('NOT_VALID', 'Hibás spec nem küldhető jóváhagyásra.', {
        errors: validation.errors,
      })
    }

    const updated = await this.repo.updateVersion(version.id, {
      status: 'pending_approval',
      validationResult: validation as unknown as Prisma.InputJsonValue,
    })

    await this.append(input.tenantId, { type: 'human', id: input.actorUserId }, {
      action: 'playbook.version.submit',
      targetType: 'playbook_version',
      targetId: version.id,
      inputRef: formatPlaybookRefV2(playbook.key, version.version),
      outputRef: version.contentHash,
      policyDecision: 'pending_approval',
      metadata: { playbookVersionId: version.id, contentHash: version.contentHash },
    })

    return updated
  }

  // --- §8.1 publishPlaybookVersion (§11.2 four-eyes) ------------------------

  async publishPlaybookVersion(input: {
    tenantId: string | null
    playbookVersionId: string
    approverUserId: string
    validationContext?: TenantValidationContext
  }): Promise<PlaybookVersionV2> {
    const { playbook, version } = await this.requireVersion(input.tenantId, input.playbookVersionId)
    if (version.status !== 'pending_approval' && version.status !== 'draft') {
      throw new PlaybookV2Error(
        'INVALID_STATE',
        `Csak draft/pending_approval verzió publikálható (jelenleg: ${version.status}).`,
      )
    }

    const parsed = safeParsePlaybookSpecV2(version.spec)
    if (!parsed.success) {
      throw new PlaybookV2Error('SCHEMA_INVALID', 'A tárolt spec érvénytelen.')
    }
    const spec = parsed.data

    // Hibapolicy spec §4.2/WP-4 — a tenant-default publish-időben olvasódik fel (TE-2: NEM
    // a hash-elt spec része, csak a validációba és a compilerbe kerül be — a `version.spec`/
    // `contentHash` érintetlen marad, csak a `compiled_spec` tükrözi a feloldott eredményt).
    const tenantDefaultErrorPolicy =
      (await this.getTenantDefaultErrorPolicy?.(input.tenantId)) ?? undefined

    const validation = this.validator.validateSpec(spec, {
      ...(input.validationContext ?? {}),
      tenantDefaultErrorPolicy,
    })
    if (!validation.valid) {
      throw new PlaybookV2Error('NOT_VALID', 'Hibás spec nem publikálható.', {
        errors: validation.errors,
      })
    }

    // §11.2 — four-eyes: L2/L3 kritikus Playbooknál a jóváhagyó ≠ készítő.
    if (this.isFourEyesRequired(spec) && input.approverUserId === version.createdById) {
      throw new PlaybookV2Error(
        'FOUR_EYES_REQUIRED',
        'L2/L3 kritikus Playbook publikálásához a jóváhagyó nem lehet a készítő.',
      )
    }

    const compiled = this.compiler.compile(spec, {
      playbookVersionId: version.id,
      tenantDefaultErrorPolicy,
    })
    const published = await this.repo.publishVersion({
      versionId: version.id,
      playbookId: playbook.id,
      approverId: input.approverUserId,
      compiledSpec: compiled as unknown as Prisma.InputJsonValue,
    })

    await this.append(input.tenantId, { type: 'human', id: input.approverUserId }, {
      action: 'playbook.version.publish',
      targetType: 'playbook_version',
      targetId: version.id,
      inputRef: formatPlaybookRefV2(playbook.key, version.version),
      outputRef: version.contentHash,
      policyDecision: 'published',
      metadata: {
        playbookVersionId: version.id,
        contentHash: version.contentHash,
        playbookRef: formatPlaybookRefV2(playbook.key, version.version),
        fourEyes: this.isFourEyesRequired(spec),
      },
    })

    return published
  }

  // --- §10.1 rejectVersion --------------------------------------------------

  async rejectPlaybookVersion(input: {
    tenantId: string | null
    playbookVersionId: string
    approverUserId: string
    reason: string
  }): Promise<PlaybookVersionV2> {
    const { playbook, version } = await this.requireVersion(input.tenantId, input.playbookVersionId)
    if (version.status !== 'pending_approval') {
      throw new PlaybookV2Error(
        'INVALID_STATE',
        `Csak pending_approval verzió utasítható el (jelenleg: ${version.status}).`,
      )
    }

    const updated = await this.repo.updateVersion(version.id, { status: 'rejected' })

    await this.append(input.tenantId, { type: 'human', id: input.approverUserId }, {
      action: 'playbook.version.reject',
      targetType: 'playbook_version',
      targetId: version.id,
      inputRef: formatPlaybookRefV2(playbook.key, version.version),
      outputRef: version.contentHash,
      policyDecision: 'rejected',
      metadata: { playbookVersionId: version.id, reason: input.reason },
    })

    return updated
  }

  // --- §8.1 assignPlaybook --------------------------------------------------

  async assignPlaybook(input: {
    tenantId: string | null
    playbookVersionId: string
    assignmentType: 'process_type' | 'ticket_type' | 'agent_role'
    assignmentKey: string
    isDefault: boolean
    actorUserId: string
  }): Promise<PlaybookAssignment> {
    if (input.assignmentType === 'agent_role') {
      throw new PlaybookV2Error(
        'ASSIGNMENT_TYPE_DEPRECATED',
        'Az agent_role roster le van építve; szerep→agent kötést Folyamaton kell rögzíteni.',
      )
    }
    const { playbook, version } = await this.requireVersion(input.tenantId, input.playbookVersionId)
    if (version.status !== 'published') {
      throw new PlaybookV2Error(
        'VERSION_NOT_PUBLISHED',
        'Csak published verzió rendelhető hozzá.',
      )
    }

    const assignment = await this.repo.createAssignment({
      tenantId: input.tenantId,
      playbookId: playbook.id,
      playbookVersionId: version.id,
      assignmentType: input.assignmentType,
      assignmentKey: input.assignmentKey,
      isDefault: input.isDefault,
      createdById: input.actorUserId,
    })

    await this.append(input.tenantId, { type: 'human', id: input.actorUserId }, {
      action: 'playbook.assignment.create',
      targetType: 'playbook_assignment',
      targetId: assignment.id,
      inputRef: `${input.assignmentType}:${input.assignmentKey}`,
      outputRef: formatPlaybookRefV2(playbook.key, version.version),
      policyDecision: input.isDefault ? 'default' : 'assigned',
      metadata: {
        playbookVersionId: version.id,
        assignmentType: input.assignmentType,
        assignmentKey: input.assignmentKey,
        isDefault: input.isDefault,
      },
    })

    return assignment
  }

  // --- Olvasás ---------------------------------------------------------------

  async listPlaybooks(tenantId: string | null, opts?: Parameters<PlaybookV2Repository['listPlaybooks']>[1]) {
    return this.repo.listPlaybooks(tenantId, opts)
  }

  async listStartablePlaybooks(tenantId: string | null) {
    const assignments = await this.repo.listDefaultAssignments(tenantId, 'process_type')
    if (assignments.length === 0) return []

    // Egy processType-hoz több történeti default lehet; a legfrissebb (createdAt desc) nyer.
    const latestByKey = new Map<string, (typeof assignments)[number]>()
    for (const assignment of assignments) {
      if (!latestByKey.has(assignment.assignmentKey)) {
        latestByKey.set(assignment.assignmentKey, assignment)
      }
    }
    const chosen = [...latestByKey.values()]
    const versionIds = [...new Set(chosen.map((a) => a.playbookVersionId))]
    const playbookIds = [...new Set(chosen.map((a) => a.playbookId))]

    const [versions, playbooks] = await Promise.all([
      this.repo.findVersionsByIds(tenantId, versionIds),
      this.repo.findPlaybooksByIds(tenantId, playbookIds),
    ])
    const versionById = new Map(versions.map((v) => [v.id, v]))
    const playbookById = new Map(playbooks.map((p) => [p.id, p]))

    const startable: Array<{
      playbookId: string
      name: string
      processType: string
      publishedVersionId: string
      version: number
    }> = []

    for (const assignment of chosen) {
      const playbook = playbookById.get(assignment.playbookId)
      const version = versionById.get(assignment.playbookVersionId)
      if (!playbook || !version || version.status !== 'published') continue
      // Batch feloldásnál külön ellenőrizzük a relációt is: egy hibás/stale
      // assignment nem indíthatja el egy másik playbook verzióját.
      if (version.playbookId !== playbook.id) continue

      startable.push({
        playbookId: playbook.id,
        name: playbook.name,
        processType: playbook.processType,
        publishedVersionId: version.id,
        version: version.version,
      })
    }

    return startable
  }

  async getPlaybook(tenantId: string | null, playbookId: string) {
    const playbook = await this.requirePlaybook(tenantId, playbookId)
    const versions = await this.repo.listVersions(playbook.id)
    return { playbook, versions }
  }

  async updatePlaybookMeta(input: {
    tenantId: string | null
    playbookId: string
    name: string
    description: string | null
    actorUserId: string
  }): Promise<PlaybookV2> {
    const playbook = await this.requirePlaybook(input.tenantId, input.playbookId)
    const updated = await this.repo.updatePlaybook(playbook.id, {
      name: input.name,
      description: input.description,
    })
    await this.append(updated.tenantId, { type: 'human', id: input.actorUserId }, {
      action: 'playbook.update_meta',
      targetType: 'playbook',
      targetId: updated.id,
      inputRef: updated.key,
      outputRef: null,
      policyDecision: 'updated',
      metadata: { name: input.name },
    })
    return updated
  }

  // --- Belső segédek ---------------------------------------------------------

  private isFourEyesRequired(spec: PlaybookSpecV2): boolean {
    const isCritical = (c?: string) => c === 'L2' || c === 'L3'
    if (isCritical(spec.criticality)) return true
    return spec.gates.some((g) => isCritical(g.criticality))
  }

  private async requirePlaybook(tenantId: string | null, id: string): Promise<PlaybookV2> {
    const playbook = await this.repo.findPlaybook(tenantId, id)
    if (!playbook) {
      throw new PlaybookV2Error('NOT_FOUND_OR_FORBIDDEN', 'A Playbook nem található vagy nincs jogosultság.')
    }
    return playbook
  }

  private async requireVersion(
    tenantId: string | null,
    versionId: string,
  ): Promise<{ playbook: PlaybookV2; version: PlaybookVersionV2 }> {
    const version = await this.repo.findVersion(tenantId, versionId)
    if (!version) {
      throw new PlaybookV2Error('NOT_FOUND_OR_FORBIDDEN', 'A verzió nem található vagy nincs jogosultság.')
    }
    const playbook = await this.requirePlaybook(tenantId, version.playbookId)
    return { playbook, version }
  }

  private async append(
    tenantId: string | null,
    actor: Actor,
    entry: {
      action: string
      targetType: string
      targetId: string
      inputRef?: string | null
      outputRef?: string | null
      policyDecision?: string | null
      metadata?: Record<string, unknown>
    },
  ) {
    await this.audit.append({
      actorType: actor.type,
      actorId: actor.id,
      agentVersion: null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      modelUsed: null,
      inputRef: entry.inputRef ?? null,
      outputRef: entry.outputRef ?? null,
      policyDecision: entry.policyDecision ?? null,
      metadata: { tenantId, ...(entry.metadata ?? {}) },
    })
  }
}
