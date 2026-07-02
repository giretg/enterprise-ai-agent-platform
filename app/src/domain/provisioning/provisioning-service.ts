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
      sourceType: 'api_doc' | 'openapi' | 'manual' | 'template'
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
      authMode: config.authMode,
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
      secretAlias?: string
      apiKey?: string
      clientId?: string
      approverId?: string
      criticality?: Criticality
      reason?: string
    },
    actor: ProvisioningActor,
  ): Promise<{ connectorId: string; lifecycleState: 'active' }> {
    const user = this.requireHumanAdmin(actor, 'activateConnector')
    const draft = await this.loadDraftForTenant(input.draftId, actor)
    const config = parseStoredConfig(draft.connector.config)

    // Előfeltételek (§8.5, P5): approved review + nem-failed validáció + sikeres
    // sandbox-teszt + (secretAlias VAGY apiKey).
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
    if (!input.secretAlias?.trim() && !input.apiKey?.trim()) {
      throw new ProvisioningError(
        'SECRET_ALIAS_MISSING',
        'secretAlias or apiKey is required',
      )
    }

    // Ha az admin API-kulcsot ad meg, elmentjük a Secret Store-ba és secret-ref-et kapunk.
    // Ha csak secretAlias-t ad meg, azt változatlanul eltároljuk (env / Secret Manager pointer).
    let resolvedAlias: string
    if (input.apiKey?.trim()) {
      const { saveConnectorApiKey, buildConnectorSecretRef } = await import(
        '@/domain/connector/connector-secret-store'
      )
      await saveConnectorApiKey(draft.connectorId, input.apiKey.trim())
      resolvedAlias = buildConnectorSecretRef(draft.connectorId)
    } else {
      resolvedAlias = input.secretAlias!.trim()
      if (!isResolvableSecretAlias(resolvedAlias)) {
        throw new ProvisioningError(
          'SECRET_ALIAS_MISSING',
          'secretAlias must be env:NAME, secret-manager:projects/.../secrets/<id>, or secret-ref:<id>; provide apiKey to create a managed secret-ref',
        )
      }
    }

    // OAuth2 client_id (nem titok, ezért NEM a Secret Store-ba, hanem a configba
    // → config.auth.clientId). A service-oauth2 runtime (http-api-client) és a
    // delegált grant-flow is innen olvassa. A client_id-t a szolgáltatónál
    // regisztrált OAuth-app adja — a discovery ezt nem tudja kitalálni.
    const trimmedClientId = input.clientId?.trim()
    const existingClientId =
      typeof config.auth.clientId === 'string' ? config.auth.clientId.trim() : ''
    // Service-módú oauth2-nél a client_id kötelező és nincs env-fallback → fail-fast
    // aktiváláskor, hogy ne az első token-refresh csússzon el (§oauth2).
    if (
      config.authMode !== 'user_delegated' &&
      config.auth.type === 'oauth2' &&
      !trimmedClientId &&
      !existingClientId
    ) {
      throw new ProvisioningError(
        'OAUTH_CLIENT_ID_MISSING',
        'oauth2 connector requires config.auth.clientId (from the provider OAuth app registration)',
      )
    }
    // A nyers configra mergeljük (nem a parse-oltra) — így a séma által nem
    // modellezett kulcsokat (pl. delegált `oauth` blokk) nem tüntetjük el.
    let nextConfig: Prisma.InputJsonValue | undefined
    const rawConfig = { ...((draft.connector.config as Record<string, unknown> | null) ?? {}) }
    let configMutated = false

    if (trimmedClientId && trimmedClientId !== existingClientId) {
      const rawAuth = { ...((rawConfig.auth as Record<string, unknown> | undefined) ?? {}) }
      rawAuth.clientId = trimmedClientId
      rawConfig.auth = rawAuth
      configMutated = true
    }

    // Delegált oauth2 → runtime-alak normalizálása (mint a manuális „API-kapcsolat"
    // form, platform.ts buildHttpApiConfig). A provisioning-draft `auth.type=oauth2`
    // alakot a runtime http-api-kliens SERVICE oauth2-ként (client_credentials)
    // értelmezné, kikerülve a user-delegált per-user Bearer-injekciót → minden
    // tool-hívás elhasal. Ezért aktiváláskor átírjuk a futásidejű alakra:
    //   auth: { scheme: 'bearer' }  (a per-user grant access token megy ki Bearerként)
    //   oauth: { authUrl?, tokenUrl?, clientId?, scopes }  (a consent-flow paraméterei;
    //          a ConnectorGrantService olvassa; Google-providernél az endpointok defaultolnak)
    if (config.authMode === 'user_delegated' && config.auth.type === 'oauth2') {
      const authUrl = typeof config.auth.authUrl === 'string' ? config.auth.authUrl.trim() : ''
      const tokenUrl = typeof config.auth.tokenUrl === 'string' ? config.auth.tokenUrl.trim() : ''
      const effectiveClientId = trimmedClientId || existingClientId
      const scopes =
        config.scopesSuggested.length > 0
          ? config.scopesSuggested
          : typeof config.auth.scope === 'string'
            ? config.auth.scope.split(/\s+/).filter(Boolean)
            : []
      rawConfig.auth = { scheme: 'bearer' }
      rawConfig.oauth = {
        ...(authUrl ? { authUrl } : {}),
        ...(tokenUrl ? { tokenUrl } : {}),
        ...(effectiveClientId ? { clientId: effectiveClientId } : {}),
        scopes,
      }
      configMutated = true
    }

    if (configMutated) nextConfig = rawConfig as Prisma.InputJsonValue

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
      secretAlias: resolvedAlias,
      authMode: config.authMode,
      secondApproverId: dualControlRequired ? input.approverId ?? null : null,
      ...(nextConfig ? { config: nextConfig } : {}),
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
    input: { connectorId: string; agentId: string; accessMode: ConnectorAccessMode; apiKey?: string },
    actor: ProvisioningActor,
  ): Promise<{ agentId: string; connectorId: string }> {
    this.requireHumanAdmin(actor, 'assignConnectorToAgent')

    // Ha per-agent API-kulcsot adtak meg, elmentjük a Secret Store-ba és az
    // agentConnector.secretAlias-ba a secret-ref-et írjuk. Ez agent_owned módban
    // minden agent a saját kulcsát használja a megosztott connector-kulcs helyett.
    let agentSecretAlias: string | null = null
    if (input.apiKey?.trim()) {
      const { saveConnectorApiKey, buildConnectorSecretRef } = await import(
        '@/domain/connector/connector-secret-store'
      )
      const scopedId = `${input.agentId}_ac_${input.connectorId}`
      await saveConnectorApiKey(scopedId, input.apiKey.trim())
      agentSecretAlias = buildConnectorSecretRef(scopedId)
    }

    await this.deps.drafts.assignToAgent({
      connectorId: input.connectorId,
      agentId: input.agentId,
      accessMode: input.accessMode,
      secretAlias: agentSecretAlias,
    })

    await this.appendAudit(actor, 'provisioning.connector.assign', input.connectorId, {
      connector_id: input.connectorId,
      agent_id: input.agentId,
      access_mode: input.accessMode,
      agent_owned_key: agentSecretAlias !== null,
      policyDecision: 'allowed',
    })

    return { agentId: input.agentId, connectorId: input.connectorId }
  }

  async unassignConnectorFromAgent(
    input: { connectorId: string; agentId: string; reason?: string },
    actor: ProvisioningActor,
  ): Promise<{ agentId: string; connectorId: string; removed: boolean }> {
    this.requireHumanAdmin(actor, 'unassignConnectorFromAgent')

    const res = await this.deps.drafts.unassignFromAgent({
      connectorId: input.connectorId,
      agentId: input.agentId,
    })

    await this.appendAudit(actor, 'provisioning.connector.unassign', input.connectorId, {
      connector_id: input.connectorId,
      agent_id: input.agentId,
      removed: res.removed,
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
      policyDecision: 'allowed',
    })

    return { agentId: input.agentId, connectorId: input.connectorId, removed: res.removed }
  }

  // ── Javítás: draft-config szerkesztése (EMBERI admin) ─────────────────────

  /**
   * Egy még NEM aktivált (draft/validated) connector config-jának javító szerkesztése.
   * A módosítás resetteli a gate-et (validationResult/review/sandbox), így a javított
   * config újra végigmegy a valid→review→sandbox→aktiválás úton. A secret SOSEM része a
   * confignak — csak a javasolt alias. Agent-aktor tiltott (CR-MVP-002).
   */
  async updateConnectorDraftConfig(
    input: { draftId: string; generatedConfig: unknown },
    actor: ProvisioningActor,
  ): Promise<{ draftId: string; lifecycleState: 'draft'; config: ConnectorConfig }> {
    this.requireHumanAdmin(actor, 'updateConnectorDraftConfig')
    const draft = await this.loadDraftForTenant(input.draftId, actor)

    if (draft.connector.lifecycleState !== 'draft' && draft.connector.lifecycleState !== 'validated') {
      throw new ProvisioningError(
        'DRAFT_NOT_EDITABLE',
        'only a draft/validated connector config is editable; reopen an active connector first',
      )
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

    const sourceHash = config.provenance?.sourceHash
      ? normalizeSourceHash(config.provenance.sourceHash)
      : sha256Hex(JSON.stringify(config))

    await this.deps.drafts.updateDraftConfig({
      draftId: draft.id,
      config: configToJson(config),
      authMode: config.authMode,
      sourceHash,
      secretAliasSuggested: config.auth.secretAliasSuggested ?? null,
    })

    await this.appendAudit(actor, 'provisioning.draft.update', draft.connectorId, {
      draft_id: draft.id,
      connector_id: draft.connectorId,
      source_hash: sourceHash,
      gate_reset: true,
      policyDecision: 'allowed',
    })

    return { draftId: draft.id, lifecycleState: 'draft', config }
  }

  // ── Javítás: aktív connector visszanyitása draftba (EMBERI admin) ──────────

  /**
   * Aktív connector visszanyitása draftba, hogy javítható legyen. A connector offline lesz
   * (Tool Broker deny), a gate resetelődik. A javítás után újra végig kell menni a kapun.
   */
  async reopenConnector(
    input: { draftId: string },
    actor: ProvisioningActor,
  ): Promise<{ connectorId: string; lifecycleState: 'draft' }> {
    this.requireHumanAdmin(actor, 'reopenConnector')
    const draft = await this.loadDraftForTenant(input.draftId, actor)

    if (draft.connector.lifecycleState !== 'active') {
      throw new ProvisioningError('CONNECTOR_NOT_ACTIVE', 'only an active connector can be reopened')
    }

    const connector = await this.deps.drafts.reopen({ draftId: draft.id })

    await this.appendAudit(actor, 'provisioning.connector.reopen', connector.id, {
      draft_id: draft.id,
      connector_id: connector.id,
      policyDecision: 'allowed',
    })

    return { connectorId: connector.id, lifecycleState: 'draft' }
  }

  // ── Megszüntetés: aktív connector auditált leszerelése (EMBERI admin) ──────

  /**
   * Aktív connector auditált megszüntetése: agent-kötések levétele, aktív user-grantek
   * visszavonása, secret-ref törlés, lifecycle_state=archived (nem hard-delete). Dual-control
   * bank-preset / L2–L3 esetén (szimmetrikus az aktiválással). A capability-syncet a hívó
   * action intézi az `affectedAgentIds` alapján (a kemény padló miatt a service a
   * capabilities táblát nem írja).
   */
  async decommissionConnector(
    input: { draftId: string; criticality?: Criticality; approverId?: string; reason?: string },
    actor: ProvisioningActor,
  ): Promise<{ connectorId: string; lifecycleState: 'archived'; affectedAgentIds: string[] }> {
    const user = this.requireHumanAdmin(actor, 'decommissionConnector')
    const draft = await this.loadDraftForTenant(input.draftId, actor)

    if (draft.connector.lifecycleState !== 'active') {
      throw new ProvisioningError(
        'CONNECTOR_NOT_ACTIVE',
        'only an active connector can be decommissioned',
      )
    }

    // Kétszemes kapu (szimmetrikus az aktiválással): bank-preset → mindig; egyébként L2–L3.
    const criticality = input.criticality ?? 'L1'
    const bankPreset = await this.deps.resolveBankPreset(actor.tenantId)
    const dualControlRequired = bankPreset || criticality === 'L2' || criticality === 'L3'
    if (dualControlRequired) {
      if (!input.approverId) {
        throw new ProvisioningError(
          'DUAL_CONTROL_REQUIRED',
          'second approver required to decommission (bank preset / L2–L3)',
          { criticality, bankPreset },
        )
      }
      if (input.approverId === user.userId) {
        throw new ProvisioningError(
          'APPROVAL_SAME_ACTOR',
          'second approver must differ from the decommissioning admin (four-eyes)',
        )
      }
    }

    const secretAlias = draft.connector.secretAlias
    const { connectorId, affectedAgentIds } = await this.deps.drafts.decommission({
      draftId: draft.id,
    })

    // A menedzselt secret-ref best-effort törlése (a leszerelt connector titka ne maradjon).
    if (secretAlias) {
      const { isConnectorSecretRef, deleteConnectorApiKey } = await import(
        '@/domain/connector/connector-secret-store'
      )
      if (isConnectorSecretRef(secretAlias)) {
        await deleteConnectorApiKey(connectorId).catch(() => {})
      }
    }

    await this.appendAudit(actor, 'provisioning.connector.decommission', connectorId, {
      draft_id: draft.id,
      connector_id: connectorId,
      criticality,
      approver_id: dualControlRequired ? input.approverId : null,
      revoked_agent_links: affectedAgentIds.length,
      reason: input.reason ?? null,
      policyDecision: 'allowed',
    })

    return { connectorId, lifecycleState: 'archived', affectedAgentIds }
  }

  // ── Takarítás: sosem aktivált draft hard-delete-je (EMBERI admin) ──────────

  /**
   * SOSEM aktivált draft (draft/validated) végleges törlése — botched draftok takarításához.
   * Aktív connectorra tilos (arra `decommissionConnector` jár).
   */
  async deleteConnectorDraft(
    input: { draftId: string; reason?: string },
    actor: ProvisioningActor,
  ): Promise<{ draftId: string }> {
    this.requireHumanAdmin(actor, 'deleteConnectorDraft')
    const draft = await this.loadDraftForTenant(input.draftId, actor)

    if (draft.connector.lifecycleState !== 'draft' && draft.connector.lifecycleState !== 'validated') {
      throw new ProvisioningError(
        'DRAFT_ALREADY_ACTIVATED',
        'only a never-activated draft can be hard-deleted; decommission an active connector instead',
      )
    }

    const connectorId = draft.connectorId
    await this.deps.drafts.deleteDraft({ draftId: draft.id })

    await this.appendAudit(actor, 'provisioning.draft.delete', connectorId, {
      draft_id: draft.id,
      connector_id: connectorId,
      reason: input.reason ?? null,
      policyDecision: 'allowed',
    })

    return { draftId: draft.id }
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
      connectorType: d.connector.type,
      authMode: d.connector.authMode,
      // A diff-nézethez: a generált deskriptor (§4.3). A secret SOSEM része — csak alias-név.
      config: safeParseStoredConfig(d.connector.config),
      // Fallback nézet, ha a config nem provisioning-ConnectorConfig alakú (pl. az
      // API-szerkesztőn átírt http_api config). Secret-mentes.
      httpApiView: safeHttpApiView(d.connector.config),
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

function isResolvableSecretAlias(value: string): boolean {
  return (
    /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value) ||
    value.startsWith('secret-manager:projects/') ||
    value.startsWith('secret-ref:')
  )
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

export type HttpApiConfigView = {
  baseUrl?: string
  authScheme?: string
  /** Auto-consent (user-delegált) jel: a config.oauth.authUrl jelenléte. */
  isDelegated: boolean
  endpoints: Array<{ method: string; path: string }>
}

/**
 * A http_api futásidejű config (baseUrl/auth/endpoints/oauth) biztonságos, secret-mentes
 * olvasata a provisioning diff-nézet fallbackjéhez — amikor a config NEM a provisioning
 * ConnectorConfig alakú (pl. az „API-kapcsolat" szerkesztőn keresztül lett átírva).
 */
function safeHttpApiView(raw: unknown): HttpApiConfigView | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const cfg = raw as Record<string, unknown>
  const baseUrl = typeof cfg.baseUrl === 'string' ? cfg.baseUrl : undefined
  const auth = typeof cfg.auth === 'object' && cfg.auth !== null ? (cfg.auth as Record<string, unknown>) : {}
  const oauth =
    typeof cfg.oauth === 'object' && cfg.oauth !== null ? (cfg.oauth as Record<string, unknown>) : {}
  const authScheme = typeof auth.scheme === 'string' ? auth.scheme : undefined
  const isDelegated = typeof oauth.authUrl === 'string' && oauth.authUrl.trim().length > 0
  const endpoints = Array.isArray(cfg.endpoints)
    ? cfg.endpoints
        .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null && !Array.isArray(e))
        .map((e) => ({ method: String(e.method ?? ''), path: String(e.path ?? '') }))
        .filter((e) => e.method && e.path)
    : []
  if (!baseUrl && !authScheme && endpoints.length === 0) return null
  return { baseUrl, authScheme, isDelegated, endpoints }
}
