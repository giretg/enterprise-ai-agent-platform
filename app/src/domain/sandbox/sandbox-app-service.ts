import { createHash } from 'crypto'
import type { Prisma, SandboxAppVersion } from '@prisma/client'
import type {
  AuditRepository,
  ConversationRepository,
  SandboxAppRepository,
  SandboxAppWithLatestVersion,
  TicketRepository,
} from '@/repositories/interfaces'
import type { ArtifactStore } from './artifact-store'
import { SandboxAppError } from './errors'
import { assertArtifactSize, lintHtml, type ValidationResult } from './html-validator'
import { validateAndNormalizeA0Policy, type SandboxAppPolicy } from './app-policy'
import { signPreviewToken, verifyPreviewToken, PREVIEW_TOKEN_TTL_MS } from './preview-token'

/** A preview-kiszolgáló route path-e (origin-agnosztikus; külön aldomain mögé tehető). */
const PREVIEW_ROUTE_PATH = '/api/sandbox-apps/preview'

function buildPreviewUrl(token: string): string {
  const origin = process.env.SANDBOX_PREVIEW_ORIGIN?.replace(/\/$/, '') ?? ''
  return `${origin}${PREVIEW_ROUTE_PATH}?t=${encodeURIComponent(token)}`
}

type Actor =
  | { userId: string; agentId?: undefined; tenantId: string | null }
  | { agentId: string; userId?: undefined; tenantId: string | null }

type SandboxAppView = {
  id: string
  name: string
  version: number
  htmlHash: string
  sourceTicketId: string
  createdAt: Date
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Determinisztikus normalizálás a hash és a tárolás előtt (§4.2/4.). */
function normalizeHtml(html: string): string {
  return html.replace(/\r\n/g, '\n')
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderSources(sources: unknown): string {
  if (!Array.isArray(sources) || sources.length === 0) {
    return '<p class="muted">Nincs megadott forrás.</p>'
  }

  return `<ul>${sources
    .map((source) => {
      if (source && typeof source === 'object') {
        const item = source as Record<string, unknown>
        return `<li><strong>${escapeHtml(item.docId ?? 'source')}</strong><span>${escapeHtml(
          item.sectionRef ?? '',
        )}</span></li>`
      }
      return `<li><strong>${escapeHtml(source)}</strong></li>`
    })
    .join('')}</ul>`
}

function renderWikiReportHtml(params: {
  title: string
  question: string
  answer: string
  rationale: string
  confidence: string
  sources: unknown
}): string {
  const generatedAt = new Date().toISOString()
  return `<!doctype html>
<html lang="hu">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(params.title)}</title>
  <style>
    :root { color-scheme: light; --ink: #18241f; --muted: #596b63; --line: #d8e0da; --sage: #5d8a4f; --paper: #fbfcf9; --wash: #eef4ec; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--paper); color: var(--ink); }
    main { max-width: 860px; margin: 0 auto; padding: 48px 24px 64px; }
    header { border-bottom: 1px solid var(--line); padding-bottom: 24px; margin-bottom: 28px; }
    .eyebrow { margin: 0 0 10px; color: var(--sage); font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 0; font-size: 34px; line-height: 1.08; letter-spacing: 0; }
    h2 { margin: 28px 0 10px; font-size: 16px; letter-spacing: 0; }
    p { line-height: 1.65; }
    .answer { border-left: 4px solid var(--sage); padding: 14px 18px; background: var(--wash); }
    .muted { color: var(--muted); }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
    .pill { border: 1px solid var(--line); border-radius: 999px; padding: 5px 10px; color: var(--muted); font-size: 12px; font-weight: 700; }
    ul { padding-left: 20px; }
    li { margin: 9px 0; }
    li span { color: var(--muted); margin-left: 8px; }
    footer { margin-top: 40px; border-top: 1px solid var(--line); padding-top: 16px; color: var(--muted); font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">A0 sandbox riport</p>
      <h1>${escapeHtml(params.title)}</h1>
      <div class="meta">
        <span class="pill">confidence: ${escapeHtml(params.confidence || 'unknown')}</span>
        <span class="pill">${escapeHtml(generatedAt)}</span>
      </div>
    </header>

    <section>
      <h2>Kérdés</h2>
      <p>${escapeHtml(params.question)}</p>
    </section>

    <section>
      <h2>Válasz</h2>
      <p class="answer">${escapeHtml(params.answer)}</p>
    </section>

    <section>
      <h2>Indoklás</h2>
      <p class="muted">${escapeHtml(params.rationale || 'Nincs külön indoklás.')}</p>
    </section>

    <section>
      <h2>Források</h2>
      ${renderSources(params.sources)}
    </section>

    <footer>
      Excellence AI Agent Platform MVP · single-file HTML export · sha256 hash a registryben
    </footer>
  </main>
</body>
</html>`
}

function toView(app: SandboxAppWithLatestVersion): SandboxAppView {
  const latest = app.versions[0]
  if (!latest) throw new Error('Sandbox app has no versions')
  return {
    id: app.id,
    name: app.name,
    version: latest.version,
    htmlHash: latest.contentHash,
    sourceTicketId: latest.sourceTicketId ?? '',
    createdAt: latest.createdAt,
  }
}

/** A policy network/connectors mezője auditba kerülhet — HTML SOHA (§8.2). */
function auditablePolicy(policy: SandboxAppPolicy): {
  level: string
  network: string
  connectors: string[]
} {
  return { level: policy.level, network: policy.network, connectors: policy.connectors }
}

function resolveActorFields(actor: Actor) {
  if (actor.agentId) {
    return {
      actorType: 'agent' as const,
      actorId: actor.agentId,
      createdByType: 'agent' as const,
      createdByUserId: null as string | null,
      createdByAgentId: actor.agentId,
    }
  }
  return {
    actorType: 'human' as const,
    actorId: actor.userId!,
    createdByType: 'user' as const,
    createdByUserId: actor.userId!,
    createdByAgentId: null as string | null,
  }
}

export class SandboxAppService {
  constructor(
    private sandboxApps: SandboxAppRepository,
    private tickets: TicketRepository,
    private conversations: ConversationRepository,
    private audit: AuditRepository,
    private artifacts: ArtifactStore,
  ) {}

  // ── Általános App Registry API (Feature-spec §4) ──────────────────────────

  async createSandboxApp(
    input: {
      name: string
      description?: string
      sandboxId?: string
      criticality?: 'L0' | 'L1'
      createdFromTicketId?: string
      createdFromConversationId?: string
      tags?: string[]
      policy?: Record<string, unknown>
    },
    actor: Actor,
  ): Promise<{ appId: string; status: 'draft' }> {
    if (input.name.trim().length < 3 || input.name.length > 80) {
      throw new SandboxAppError('APP_INVALID_INPUT', 'name must be 3-80 characters')
    }
    if (input.description && input.description.length > 1000) {
      throw new SandboxAppError('APP_INVALID_INPUT', 'description must be at most 1000 characters')
    }
    const criticality = input.criticality ?? 'L1'
    if (criticality !== 'L0' && criticality !== 'L1') {
      throw new SandboxAppError('POLICY_NOT_ALLOWED_FOR_A0', 'criticality must be L0 or L1 for A0')
    }

    if (input.createdFromTicketId) {
      const ticket = await this.tickets.findById(input.createdFromTicketId)
      if (!ticket || ticket.tenantId !== actor.tenantId) {
        throw new SandboxAppError('APP_INVALID_INPUT', 'createdFromTicketId not found in tenant')
      }
    }
    if (input.createdFromConversationId) {
      const conversation = await this.conversations.findById(input.createdFromConversationId)
      if (!conversation || conversation.tenantId !== actor.tenantId) {
        throw new SandboxAppError('APP_INVALID_INPUT', 'createdFromConversationId not found in tenant')
      }
    }

    const policy = validateAndNormalizeA0Policy(input.policy)
    const af = resolveActorFields(actor)

    const app = await this.sandboxApps.create({
      tenantId: actor.tenantId,
      sandboxId: input.sandboxId ?? null,
      name: input.name,
      description: input.description ?? null,
      criticality,
      createdByType: af.createdByType,
      createdByUserId: af.createdByUserId,
      createdByAgentId: af.createdByAgentId,
      createdFromTicketId: input.createdFromTicketId ?? null,
      createdFromConversationId: input.createdFromConversationId ?? null,
      policy: policy as unknown as Prisma.InputJsonValue,
      tags: input.tags,
    })

    await this.audit.append({
      actorType: af.actorType,
      actorId: af.actorId,
      agentVersion: null,
      action: 'sandbox_app.create',
      targetType: 'sandbox_app',
      targetId: app.id,
      modelUsed: null,
      inputRef: input.createdFromTicketId ?? input.createdFromConversationId ?? null,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: { level: 'A0', criticality, policy: auditablePolicy(policy) },
    })

    return { appId: app.id, status: 'draft' }
  }

  async upsertSandboxAppVersion(
    input: {
      appId: string
      html: string
      changeSummary: string
      activate?: boolean
      createdFromRunId?: string
      sourceTicketId?: string
    },
    actor: Actor,
  ): Promise<{
    versionId: string
    version: number
    contentHash: string
    validationResult: ValidationResult
    status: 'draft' | 'active'
  }> {
    const app = await this.ensureReadable(await this.sandboxApps.findById(input.appId), actor)

    if (!input.changeSummary.trim()) {
      throw new SandboxAppError('APP_INVALID_INPUT', 'changeSummary is required')
    }

    const policy = validateAndNormalizeA0Policy(
      (app.policy as Record<string, unknown> | null) ?? undefined,
    )
    const html = normalizeHtml(input.html)
    const sizeBytes = assertArtifactSize(html, policy.maxArtifactSizeBytes)
    const validationResult = lintHtml(html)

    const af = resolveActorFields(actor)

    if (validationResult.status === 'failed') {
      await this.audit.append({
        actorType: af.actorType,
        actorId: af.actorId,
        agentVersion: null,
        action: 'sandbox_app.validation_failed',
        targetType: 'sandbox_app',
        targetId: app.id,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: 'denied',
        metadata: { errors: validationResult.errors, level: 'A0' },
      })
      throw new SandboxAppError('APP_VALIDATION_FAILED', 'HTML failed security lint', {
        errors: validationResult.errors,
      })
    }

    const contentHash = sha256(html)

    const version = await this.sandboxApps.addVersion({
      appId: app.id,
      tenantId: app.tenantId,
      changeSummary: input.changeSummary,
      artifactSizeBytes: sizeBytes,
      contentHash,
      createdByType: af.createdByType,
      createdByUserId: af.createdByUserId,
      createdByAgentId: af.createdByAgentId,
      createdFromRunId: input.createdFromRunId ?? null,
      sourceTicketId: input.sourceTicketId ?? null,
      validationResult: validationResult as unknown as Prisma.InputJsonValue,
    })

    // Az artefakt a verziósor artifactRef-jére kerül (path = artifactObjectPath).
    await this.artifacts.put({
      tenantId: app.tenantId,
      appId: app.id,
      version: version.version,
      html,
    })

    let status: 'draft' | 'active' = 'draft'
    if (input.activate) {
      await this.sandboxApps.setActiveVersion({ appId: app.id, versionId: version.id })
      status = 'active'
    }

    await this.audit.append({
      actorType: af.actorType,
      actorId: af.actorId,
      agentVersion: null,
      action: 'sandbox_app.version.create',
      targetType: 'sandbox_app',
      targetId: app.id,
      modelUsed: null,
      inputRef: input.sourceTicketId ?? null,
      outputRef: contentHash,
      policyDecision: 'allowed',
      metadata: {
        version: version.version,
        level: 'A0',
        artifactSizeBytes: sizeBytes,
        warnings: validationResult.warnings,
      },
    })

    if (input.activate) {
      await this.appendActivateAudit(actor, app.id, version.version, null)
    }

    return { versionId: version.id, version: version.version, contentHash, validationResult, status }
  }

  async activateSandboxAppVersion(
    input: { appId: string; version: number; reason?: string },
    actor: Actor,
  ): Promise<{ appId: string; activeVersion: number }> {
    const app = await this.ensureReadable(await this.sandboxApps.findById(input.appId), actor)

    const version = await this.sandboxApps.getVersion(app.id, input.version)
    if (!version) {
      throw new SandboxAppError('APP_VERSION_NOT_FOUND', `Version ${input.version} not found`)
    }

    await this.sandboxApps.setActiveVersion({ appId: app.id, versionId: version.id })
    await this.appendActivateAudit(actor, app.id, version.version, input.reason ?? null)

    return { appId: app.id, activeVersion: version.version }
  }

  async listSandboxApps(
    input: {
      sandboxId?: string
      status?: 'draft' | 'active' | 'archived' | 'blocked'
      search?: string
      limit?: number
      cursor?: string
    },
    actor: Actor,
  ) {
    const { items, nextCursor } = await this.sandboxApps.list({
      tenantId: actor.tenantId,
      sandboxId: input.sandboxId,
      status: input.status,
      search: input.search,
      limit: input.limit,
      cursor: input.cursor,
    })

    return {
      apps: items.map((app) => ({
        appId: app.id,
        name: app.name,
        description: app.description ?? undefined,
        status: app.status,
        level: 'A0' as const,
        type: 'single_html' as const,
        activeVersion: app.activeVersion?.version,
        contentHash: app.activeVersion?.contentHash,
        createdByLabel: app.createdByType === 'agent' ? 'agent' : 'user',
        updatedAt: app.updatedAt.toISOString(),
      })),
      nextCursor,
    }
  }

  async getSandboxApp(input: { appId: string }, actor: Actor) {
    const app = await this.ensureReadable(await this.sandboxApps.findById(input.appId), actor)
    const versions = await this.sandboxApps.listVersions(app.id)

    return {
      app: {
        appId: app.id,
        name: app.name,
        description: app.description ?? undefined,
        status: app.status,
        level: app.level,
        type: app.type,
        criticality: app.criticality,
        activeVersionId: app.activeVersionId ?? undefined,
        createdFromTicketId: app.createdFromTicketId ?? undefined,
        createdFromConversationId: app.createdFromConversationId ?? undefined,
        createdByLabel: app.createdByType === 'agent' ? 'agent' : 'user',
        createdAt: app.createdAt.toISOString(),
        updatedAt: app.updatedAt.toISOString(),
      },
      versions: versions.map((v) => this.toVersionSummary(v)),
    }
  }

  // ── Wiki-riport convenience wrapper (CR-MVP-001 kompatibilitás) ────────────

  async createOrVersionWikiReport(ticketId: string, actor: Actor): Promise<SandboxAppView> {
    const ticket = await this.tickets.findById(ticketId)
    if (!ticket) throw new Error('Ticket not found')
    if (ticket.type !== 'interaction') throw new Error('Only interaction tickets can become A0 reports')

    const payload = ticket.payload as Record<string, unknown>
    if (typeof payload.answer !== 'string' || !payload.answer.trim()) {
      throw new Error('Ticket has no wiki answer payload')
    }

    const title = `Wiki-riport: ${ticket.title.replace(/^Wiki kérdés:\s*/i, '').slice(0, 80)}`
    const html = renderWikiReportHtml({
      title,
      question: typeof payload.question === 'string' ? payload.question : ticket.title,
      answer: payload.answer,
      rationale: typeof payload.rationale === 'string' ? payload.rationale : '',
      confidence: typeof payload.confidence === 'string' ? payload.confidence : '',
      sources: payload.sources,
    })

    const existing = await this.sandboxApps.findLatestByTicketId(ticketId)
    let appId: string
    let changeSummary: string
    if (existing) {
      await this.ensureReadable(existing, actor)
      appId = existing.id
      changeSummary = 'Wiki riport frissített verzió'
    } else {
      const created = await this.createSandboxApp(
        { name: title, criticality: 'L1', createdFromTicketId: ticketId },
        actor,
      )
      appId = created.appId
      changeSummary = 'Első önálló riportnézet létrehozása'
    }

    await this.upsertSandboxAppVersion(
      { appId, html, changeSummary, activate: true, sourceTicketId: ticketId },
      actor,
    )

    const refreshed = await this.sandboxApps.findByIdWithLatestVersion(appId)
    if (!refreshed) throw new Error('Sandbox app not found after version creation')
    return toView(refreshed)
  }

  async getLatestForTicket(ticketId: string, actor: Actor): Promise<SandboxAppView | null> {
    const app = await this.sandboxApps.findLatestByTicketId(ticketId)
    if (!app) return null
    await this.ensureReadable(app, actor)
    return toView(app)
  }

  async getRenderableApp(
    appId: string,
    actor: Actor,
    action: 'sandbox_app.preview' | 'sandbox_app.export',
  ) {
    const af = resolveActorFields(actor)
    const app = await this.ensureReadable(
      await this.sandboxApps.findByIdWithLatestVersion(appId),
      actor,
    )
    const latest = app.versions[0]
    if (!latest) throw new SandboxAppError('APP_VERSION_NOT_FOUND', 'Sandbox app has no versions')

    const htmlContent = await this.artifacts.get(latest.artifactRef)

    await this.audit.append({
      actorType: af.actorType,
      actorId: af.actorId,
      agentVersion: null,
      action,
      targetType: 'sandbox_app',
      targetId: app.id,
      modelUsed: null,
      inputRef: latest.sourceTicketId,
      outputRef: latest.contentHash,
      policyDecision: 'allowed',
      metadata: { version: latest.version, level: app.level },
    })

    return { app, version: { ...latest, htmlContent, htmlHash: latest.contentHash } }
  }

  /** Tool Broker `sandbox_app.export` — artifact metaadat visszaadása letöltési refként. */
  async exportSandboxApp(
    input: { appId: string; version?: number },
    actor: Actor,
  ): Promise<{ filename: string; contentRef: string; contentHash: string; sizeBytes: number }> {
    const af = resolveActorFields(actor)
    const app = await this.ensureReadable(await this.sandboxApps.findById(input.appId), actor)
    const ver = await this.resolvePreviewVersion(app.id, app.activeVersionId, input.version)

    await this.audit.append({
      actorType: af.actorType,
      actorId: af.actorId,
      agentVersion: null,
      action: 'sandbox_app.export',
      targetType: 'sandbox_app',
      targetId: app.id,
      modelUsed: null,
      inputRef: ver.sourceTicketId,
      outputRef: ver.contentHash,
      policyDecision: 'allowed',
      metadata: { version: ver.version, level: app.level },
    })

    const filename = `${app.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'sandbox-app'}-v${ver.version}.html`

    return {
      filename,
      contentRef: ver.artifactRef,
      contentHash: ver.contentHash,
      sizeBytes: ver.artifactSizeBytes,
    }
  }

  // ── Preview izoláció (Feature-spec §4.5, §6.1) ────────────────────────────

  /**
   * Rövid életű, aláírt preview URL-t ad (NEM hordoz platform sessiont). A token
   * `tenantId+appId+version+contentHash`-re érvényes; a kiszolgáló route ez alapján,
   * cookie nélkül szolgál ki. Az esemény itt auditálódik (`sandbox_app.preview`).
   */
  async getSandboxAppPreviewUrl(
    input: { appId: string; version?: number },
    actor: Actor,
  ): Promise<{ previewUrl: string; contentHash: string; expiresAt: string }> {
    const app = await this.ensureReadable(await this.sandboxApps.findById(input.appId), actor)
    const version = await this.resolvePreviewVersion(app.id, app.activeVersionId, input.version)

    const expiresAt = Date.now() + PREVIEW_TOKEN_TTL_MS
    const token = signPreviewToken({
      tenantId: app.tenantId,
      appId: app.id,
      version: version.version,
      contentHash: version.contentHash,
      expiresAt,
    })

    const af = resolveActorFields(actor)
    await this.audit.append({
      actorType: af.actorType,
      actorId: af.actorId,
      agentVersion: null,
      action: 'sandbox_app.preview',
      targetType: 'sandbox_app',
      targetId: app.id,
      modelUsed: null,
      inputRef: version.sourceTicketId,
      outputRef: version.contentHash,
      policyDecision: 'allowed',
      metadata: { version: version.version, level: app.level },
    })

    return {
      previewUrl: buildPreviewUrl(token),
      contentHash: version.contentHash,
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }

  /**
   * A cookieless preview route hívja: aláírt token alapján visszaadja a HTML-t,
   * platform-session NÉLKÜL. A token tenantId-ja és contentHash-e kötelezően
   * egyezik a tárolt verzióval (tenant-izoláció + integritás); eltérés → not found.
   */
  async servePreviewByToken(token: string): Promise<{ html: string; contentHash: string }> {
    const payload = verifyPreviewToken(token)
    const version = await this.sandboxApps.getVersion(payload.a, payload.v)
    if (
      !version ||
      version.tenantId !== payload.t ||
      version.contentHash !== payload.h
    ) {
      throw new SandboxAppError('APP_NOT_FOUND_OR_FORBIDDEN', 'Preview not available')
    }
    const html = await this.artifacts.get(version.artifactRef)
    return { html, contentHash: version.contentHash }
  }

  // ── Belső segédek ─────────────────────────────────────────────────────────

  /** Preview verzió feloldása: explicit verzió → aktív verzió → legutolsó. */
  private async resolvePreviewVersion(
    appId: string,
    activeVersionId: string | null,
    requested?: number,
  ): Promise<SandboxAppVersion> {
    if (requested !== undefined) {
      const v = await this.sandboxApps.getVersion(appId, requested)
      if (!v) throw new SandboxAppError('APP_VERSION_NOT_FOUND', `Version ${requested} not found`)
      return v
    }
    if (activeVersionId) {
      const v = await this.sandboxApps.getVersionById(activeVersionId)
      if (v) return v
    }
    const withLatest = await this.sandboxApps.findByIdWithLatestVersion(appId)
    const latest = withLatest?.versions[0]
    if (!latest) throw new SandboxAppError('APP_VERSION_NOT_FOUND', 'Sandbox app has no versions')
    return latest
  }

  private toVersionSummary(v: SandboxAppVersion) {
    return {
      versionId: v.id,
      version: v.version,
      status: v.status,
      changeSummary: v.changeSummary,
      contentHash: v.contentHash,
      artifactSizeBytes: v.artifactSizeBytes,
      validationResult: v.validationResult,
      createdByLabel: v.createdByType === 'agent' ? 'agent' : 'user',
      createdAt: v.createdAt.toISOString(),
    }
  }

  private async appendActivateAudit(
    actor: Actor,
    appId: string,
    version: number,
    reason: string | null,
  ) {
    const af = resolveActorFields(actor)
    await this.audit.append({
      actorType: af.actorType,
      actorId: af.actorId,
      agentVersion: null,
      action: 'sandbox_app.version.activate',
      targetType: 'sandbox_app',
      targetId: appId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: { version, level: 'A0', ...(reason ? { reason } : {}) },
    })
  }

  /**
   * Tenant-izoláció kapu (§2.3/7.). Hiányzó app vagy más tenant → egységes
   * APP_NOT_FOUND_OR_FORBIDDEN, tenant-eltérésnél sandbox_app.access_denied audit.
   * A nem-null appot visszaadja, hogy a hívó típusa szűküljön.
   */
  private async ensureReadable<T extends { id: string; tenantId: string | null }>(
    app: T | null,
    actor: Actor,
  ): Promise<T> {
    if (!app) {
      throw new SandboxAppError('APP_NOT_FOUND_OR_FORBIDDEN', 'Sandbox app not found')
    }
    if (app.tenantId === actor.tenantId) return app

    const af = resolveActorFields(actor)
    await this.audit.append({
      actorType: af.actorType,
      actorId: af.actorId,
      agentVersion: null,
      action: 'sandbox_app.access_denied',
      targetType: 'sandbox_app',
      targetId: app.id,
      modelUsed: null,
      inputRef: actor.tenantId,
      outputRef: app.tenantId,
      policyDecision: 'denied',
      metadata: { reason: 'tenant_mismatch' },
    })
    throw new SandboxAppError('APP_NOT_FOUND_OR_FORBIDDEN', 'Sandbox app access denied')
  }
}
