/**
 * Provisioning Assistant (Connector Onboarding) — drafting + validáció + jóváhagyás
 * munkafolyamat a meglévő connector registry köré (Feature-spec — Provisioning-Assistant
 * §3, §5, §8). KÖZPONTI ELV: propose, ne apply. Az asszisztens kimenete adat
 * (draft connector-deskriptor), nem művelet; a connector éles aktiválása és
 * agenthez rendelése EMBERI admin-aktus marad (CR-MVP-002 kemény padló).
 *
 * Kemény padló (§6.2): a `provisioning.draft.*` írási út csak a draft connectort
 * (lifecycle_state IN draft,validated) és a connector_drafts sort érheti — capabilities /
 * agent_connectors / RBAC / Secret Manager elérhetetlen. Az aktiválás és a
 * hozzárendelés agent-aktorral SOHA → `PROVISIONING_FORBIDDEN` + provisioning.access_denied.
 */
import { createHash } from 'crypto'
import type { ConnectorAccessMode, Prisma, UserRole } from '@prisma/client'
import type { AuditRepository, ConnectorDraftRepository } from '@/repositories/interfaces'
import {
  normalizeConnectorConfig,
  ConnectorConfigParseError,
  type ConnectorConfig,
} from './connector-config'
import { validateDraftConfig, type ValidationResult } from './draft-validator'
import { ProvisioningError } from './errors'

export type ProvisioningActor =
  | { type: 'user'; userId: string; role: UserRole; tenantId: string | null }
  | {
      type: 'agent'
      agentId: string
      agentVersion?: number | null
      tenantId: string | null
    }

export type Criticality = 'L1' | 'L2' | 'L3'

/** A draft connectort sandboxban kipróbáló adapter (§8.4). F2-P-D köti be a valódi MCP-proxyt. */
export interface SandboxConnectionTester {
  test(input: {
    config: ConnectorConfig
    secretAlias: string | null
    tenantId: string | null
  }): Promise<{ ok: boolean; statusCode?: number; detail?: string }>
}

export interface ProvisioningDeps {
  drafts: ConnectorDraftRepository
  audit: AuditRepository
  /** A tenant engedélyezett egress-célhostjai (deny-by-default egress-policy, §7.2/§14.2). */
  resolveEgressAllowlist: (tenantId: string | null) => Promise<string[]>
  /** Banki preset: allowlist-only egress + minden aktiválás dual-control (§7.3/§14). */
  resolveBankPreset: (tenantId: string | null) => Promise<boolean>
  /** Sandbox connection-test adapter (§8.4); ha nincs bekötve → a teszt nem sikeresnek minősül. */
  sandboxTester?: SandboxConnectionTester
  /**
   * Az agent engedélyezett `provisioning.*` capability-jei (§6.1/§9, deny-by-default).
   * Ha nincs bekötve, vagy a kért capability nincs benne → agent-aktor TILTOTT a
   * draft-rétegre is. Emberi admin-aktorra nincs hatása.
   */
  resolveAgentCapabilities?: (agentId: string) => Promise<readonly string[]>
}

function sha256Hex(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex')
}

const PRIVILEGED_HUMAN_ROLES: ReadonlySet<UserRole> = new Set<UserRole>(['admin'])

export class ProvisioningService {
  constructor(private deps: ProvisioningDeps) {}

  // ── §8.1 createConnectorDraft ─────────────────────────────────────────────

  async createConnectorDraft(
    input: {
      name: string
      sourceType: 'api_doc' | 'openapi' | 'manual'
      sourceRef?: string | null
      /** A forrásdokumentum nyers tartalma — CSAK a hash számításához, NEM tároljuk/auditáljuk. */
      sourceContent?: string
      generatedConfig: unknown
      generatedFromConversationId?: string | null
    },
    actor: ProvisioningActor,
  ): Promise<{
    connectorId: string
    draftId: string
    lifecycleState: 'draft'
    config: ConnectorConfig
  }> {
    await this.requireDraftCapability(actor, 'provisioning.draft.create')

    if (!input.name?.trim()) {
      throw new ProvisioningError('PROVISIONING_INVALID_INPUT', 'name is required')
    }

    let config: ConnectorConfig
    try {
      config = normalizeConnectorConfig(input.generatedConfig)
    } catch (e) {
      if (e instanceof ConnectorConfigParseError) {
        throw new ProvisioningError('PROVISIONING_INVALID_INPUT', e.message, e.issues)
      }
      throw e
    }

    // A forrás hash-e: a megadott sourceRef-ből vagy a nyers tartalomból. A tartalom
    // SOSEM kerül auditba/DB-be — csak a hash (§7.1, §10.1, P8).
    const sourceHash = config.provenance?.sourceHash
      ? normalizeSourceHash(config.provenance.sourceHash)
      : input.sourceContent != null
        ? sha256Hex(input.sourceContent)
        : sha256Hex(input.sourceRef ?? `${input.name}:${input.sourceType}`)

    const draft = await this.deps.drafts.createDraft({
      tenantId: actor.tenantId,
      name: input.name.trim(),
      sourceType: input.sourceType,
      sourceRef: input.sourceRef ?? null,
      sourceHash,
      config: configToJson(config),
      secretAliasSuggested: config.auth.secretAliasSuggested ?? null,
      generatedByAgentId: actor.type === 'agent' ? actor.agentId : null,
      generatedByAgentVersion: actor.type === 'agent' ? actor.agentVersion ?? null : null,
      generatedFromConversationId: input.generatedFromConversationId ?? null,
    })

    await this.appendAudit(actor, 'provisioning.draft.create', draft.connectorId, {
      draft_id: draft.id,
      connector_id: draft.connectorId,
      source_hash: sourceHash,
      policyDecision: 'allowed',
    })

    return {
      connectorId: draft.connectorId,
      draftId: draft.id,
      lifecycleState: 'draft',
      config,
    }
  }

  // ── §8.2 validateConnectorDraft (determinisztikus, szerveroldali) ─────────

  async validateConnectorDraft(
    input: { draftId: string },
    actor: ProvisioningActor,
  ): Promise<{ validationResult: ValidationResult }> {
    await this.requireDraftCapability(actor, 'provisioning.draft.validate')
    const draft = await this.loadDraftForTenant(input.draftId, actor)

    const config = parseStoredConfig(draft.connector.config)
    const [egressAllowlist, bankPreset] = await Promise.all([
      this.deps.resolveEgressAllowlist(actor.tenantId),
      this.deps.resolveBankPreset(actor.tenantId),
    ])

    const validationResult = validateDraftConfig(config, { egressAllowlist, bankPreset })

    await this.deps.drafts.setValidationResult(
      draft.id,
      validationResult as unknown as Prisma.InputJsonValue,
    )

    await this.appendAudit(actor, 'provisioning.draft.validate', draft.connectorId, {
      draft_id: draft.id,
      validation_status: validationResult.status,
      policyDecision: validationResult.status === 'failed' ? 'denied' : 'allowed',
    })

    return { validationResult }
  }

  // ── §8.3 reviewConnectorDraft (emberi) ────────────────────────────────────

  async reviewConnectorDraft(
    input: { draftId: string; decision: 'approve' | 'changes_requested' | 'reject'; note?: string },
    actor: ProvisioningActor,
  ): Promise<{ reviewStatus: string }> {
    const user = this.requireHumanAdmin(actor, 'reviewConnectorDraft')
    const draft = await this.loadDraftForTenant(input.draftId, actor)

    const reviewStatus =
      input.decision === 'approve'
        ? 'approved'
        : input.decision === 'reject'
          ? 'rejected'
          : 'changes_requested'

    await this.deps.drafts.setReview({ draftId: draft.id, reviewStatus, reviewedById: user.userId })

    const action =
      input.decision === 'reject' ? 'provisioning.draft.reject' : 'provisioning.draft.review'
    await this.appendAudit(actor, action, draft.connectorId, {
      draft_id: draft.id,
      review_status: reviewStatus,
      policyDecision: 'allowed',
    })

    return { reviewStatus }
  }

  // ── §8.4 testConnectorDraft (sandbox, szűk jogú non-prod token) ───────────

  async testConnectorDraft(
    input: { draftId: string },
    actor: ProvisioningActor,
  ): Promise<{ ok: boolean; statusCode?: number; detail?: string }> {
    this.requireHumanAdmin(actor, 'testConnectorDraft')
    const draft = await this.loadDraftForTenant(input.draftId, actor)
    const config = parseStoredConfig(draft.connector.config)

    let result: { ok: boolean; statusCode?: number; detail?: string }
    if (this.deps.sandboxTester) {
      result = await this.deps.sandboxTester.test({
        config,
        secretAlias: draft.connector.secretAlias,
        tenantId: actor.tenantId,
      })
    } else {
      result = { ok: false, detail: 'sandbox_tester_not_configured' }
    }

    await this.deps.drafts.setSandboxTestResult(draft.id, result.ok)
    await this.appendAudit(actor, 'provisioning.draft.validate', draft.connectorId, {
      draft_id: draft.id,
      sandbox_test_ok: result.ok,
      policyDecision: result.ok ? 'allowed' : 'denied',
    })

    return result
  }

  // ── §8.5 activateConnector (EMBERI admin-aktus — agent NEM hívhatja) ──────

  async activateConnector(
    input: {
      draftId: string
      secretAlias: string
      approverId?: string
      criticality?: Criticality
      reason?: string
    },
    actor: ProvisioningActor,
  ): Promise<{ connectorId: string; lifecycleState: 'active' }> {
    const user = this.requireHumanAdmin(actor, 'activateConnector')
    const draft = await this.loadDraftForTenant(input.draftId, actor)

    // Előfeltételek (§8.5, P5): approved review + nem-failed validáció + sikeres
    // sandbox-teszt + létező secret-alias.
    if (draft.reviewStatus !== 'approved') {
      throw new ProvisioningError('DRAFT_NOT_APPROVED', 'review_status must be approved')
    }
    const validation = draft.validationResult as ValidationResult | null
    if (!validation || validation.status === 'failed') {
      throw new ProvisioningError(
        'DRAFT_VALIDATION_FAILED',
        'validation_result must be passed/warned (not failed)',
      )
    }
    if (draft.sandboxTestOk !== true) {
      throw new ProvisioningError('SANDBOX_TEST_FAILED', 'sandbox connection-test must pass first')
    }
    if (!input.secretAlias?.trim()) {
      throw new ProvisioningError('SECRET_ALIAS_MISSING', 'secretAlias is required')
    }

    // Kétszintű emberi kapu (§7.3, §14/4): banki preset → minden aktiválás dual-control;
    // egyébként L2–L3 dual-control, L1 egy admin.
    const criticality = input.criticality ?? 'L1'
    const bankPreset = await this.deps.resolveBankPreset(actor.tenantId)
    const dualControlRequired = bankPreset || criticality === 'L2' || criticality === 'L3'

    if (dualControlRequired) {
      if (!input.approverId) {
        throw new ProvisioningError(
          'DUAL_CONTROL_REQUIRED',
          'second approver required (bank preset / L2–L3)',
          { criticality, bankPreset },
        )
      }
      if (input.approverId === user.userId || input.approverId === draft.reviewedById) {
        throw new ProvisioningError(
          'APPROVAL_SAME_ACTOR',
          'second approver must differ from reviewer/activator (four-eyes)',
        )
      }
    }

    const connector = await this.deps.drafts.activate({
      draftId: draft.id,
      secretAlias: input.secretAlias.trim(),
      secondApproverId: dualControlRequired ? input.approverId ?? null : null,
    })

    await this.appendAudit(actor, 'provisioning.connector.activate', connector.id, {
      draft_id: draft.id,
      connector_id: connector.id,
      criticality,
      approver_id: dualControlRequired ? input.approverId : null,
      validation_status: validation.status,
      policyDecision: 'allowed',
    })

    return { connectorId: connector.id, lifecycleState: 'active' }
  }

  // ── §8.6 assignConnectorToAgent (EMBERI admin-aktus — agent NEM hívhatja) ──

  async assignConnectorToAgent(
    input: { connectorId: string; agentId: string; accessMode: ConnectorAccessMode },
    actor: ProvisioningActor,
  ): Promise<{ agentId: string; connectorId: string }> {
    this.requireHumanAdmin(actor, 'assignConnectorToAgent')

    await this.deps.drafts.assignToAgent({
      connectorId: input.connectorId,
      agentId: input.agentId,
      accessMode: input.accessMode,
    })

    await this.appendAudit(actor, 'provisioning.connector.assign', input.connectorId, {
      connector_id: input.connectorId,
      agent_id: input.agentId,
      access_mode: input.accessMode,
      policyDecision: 'allowed',
    })

    return { agentId: input.agentId, connectorId: input.connectorId }
  }

  // ── §9 catalog.read (meglévő connector-metaadat, secret nélkül) ───────────

  async listCatalog(
    actor: ProvisioningActor,
  ): Promise<Array<{ id: string; type: string; name: string }>> {
    return this.deps.drafts.listActiveCatalog(actor.tenantId)
  }

  async listDrafts(actor: ProvisioningActor) {
    const rows = await this.deps.drafts.list(actor.tenantId)
    return rows.map((d) => ({
      draftId: d.id,
      connectorId: d.connectorId,
      name: d.connector.name,
      lifecycleState: d.connector.lifecycleState,
      reviewStatus: d.reviewStatus,
      validationResult: d.validationResult as ValidationResult | null,
      sandboxTestOk: d.sandboxTestOk,
      secretAliasSuggested: d.connector.secretAlias,
      // A diff-nézethez: a generált deskriptor (§4.3). A secret SOSEM része — csak alias-név.
      config: safeParseStoredConfig(d.connector.config),
      sourceType: d.sourceType,
      sourceHash: d.sourceHash,
      createdAt: d.createdAt,
    }))
  }

  // ── belső segédek ─────────────────────────────────────────────────────────

  /**
   * Kemény padló (§6.2, §6.3): a privilegizált aktusokat (review/test/activate/assign)
   * CSAK emberi admin hívhatja. Agent-aktor → PROVISIONING_FORBIDDEN +
   * provisioning.access_denied audit (PN2, PN3).
   */
  private requireHumanAdmin(
    actor: ProvisioningActor,
    attemptedAction: string,
  ): { userId: string } {
    if (actor.type !== 'user' || !PRIVILEGED_HUMAN_ROLES.has(actor.role)) {
      // best-effort audit; a hibadobás nem függ tőle
      void this.appendAudit(actor, 'provisioning.access_denied', null, {
        attempted_action: attemptedAction,
        policyDecision: 'denied',
      })
      throw new ProvisioningError(
        'PROVISIONING_FORBIDDEN',
        `${attemptedAction} is a human admin-only act (CR-MVP-002)`,
      )
    }
    return { userId: actor.userId }
  }

  /**
   * Deny-by-default capability-kapu a draft-rétegre az AGENT-aktorra (§6.1/§9). A
   * felhasználói RBAC az action-rétegben dől el (`requireRole`), ezért user-aktort itt
   * nem szűkítünk. Agent CSAK akkor mehet tovább, ha a kért `provisioning.draft.*`
   * capability-t kifejezetten megkapta; hiányzó dep / capability → PROVISIONING_FORBIDDEN
   * + provisioning.access_denied (a jogosultság nem bővül, CR-MVP-002).
   */
  private async requireDraftCapability(
    actor: ProvisioningActor,
    capability: 'provisioning.draft.create' | 'provisioning.draft.validate',
  ): Promise<void> {
    if (actor.type === 'user') return

    const granted = this.deps.resolveAgentCapabilities
      ? await this.deps.resolveAgentCapabilities(actor.agentId)
      : []
    if (!granted.includes(capability)) {
      void this.appendAudit(actor, 'provisioning.access_denied', null, {
        attempted_action: capability,
        policyDecision: 'denied',
      })
      throw new ProvisioningError(
        'PROVISIONING_FORBIDDEN',
        `agent lacks ${capability} capability (deny-by-default)`,
      )
    }
  }

  private async loadDraftForTenant(draftId: string, actor: ProvisioningActor) {
    const draft = await this.deps.drafts.findById(draftId)
    if (!draft || draft.tenantId !== actor.tenantId) {
      // Tenant-izoláció (§7.5, PN9): nem szivárogtatjuk a létezést.
      void this.appendAudit(actor, 'provisioning.access_denied', null, {
        attempted_action: 'access_draft',
        draft_id: draftId,
        policyDecision: 'denied',
      })
      throw new ProvisioningError(
        'DRAFT_NOT_FOUND_OR_FORBIDDEN',
        'draft not found in tenant',
      )
    }
    return draft
  }

  private async appendAudit(
    actor: ProvisioningActor,
    action: string,
    targetId: string | null,
    metadata: Record<string, unknown> & { policyDecision: string },
  ): Promise<void> {
    const { policyDecision, ...meta } = metadata
    await this.deps.audit.append({
      actorType: actor.type === 'user' ? 'human' : 'agent',
      actorId: actor.type === 'user' ? actor.userId : actor.agentId,
      agentVersion: actor.type === 'agent' ? actor.agentVersion ?? null : null,
      action,
      targetType: 'connector',
      targetId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision,
      // FONTOS: a forrásdoksi TARTALMA és bármilyen secret SOSEM kerül auditba (§10.1, P8).
      metadata: { tenant_id: actor.tenantId, ...meta } as unknown as Prisma.JsonValue,
    })
  }
}

function normalizeSourceHash(value: string): string {
  return value.startsWith('sha256:') ? value : `sha256:${value}`
}

function configToJson(config: ConnectorConfig): Prisma.InputJsonValue {
  return config as unknown as Prisma.InputJsonValue
}

function parseStoredConfig(raw: unknown): ConnectorConfig {
  try {
    return normalizeConnectorConfig(raw)
  } catch (e) {
    if (e instanceof ConnectorConfigParseError) {
      throw new ProvisioningError('PROVISIONING_INVALID_INPUT', 'stored config invalid', e.issues)
    }
    throw e
  }
}

/** Best-effort: listázáshoz a hibás config se bukassa meg az egész oldalt. */
function safeParseStoredConfig(raw: unknown): ConnectorConfig | null {
  try {
    return normalizeConnectorConfig(raw)
  } catch {
    return null
  }
}
