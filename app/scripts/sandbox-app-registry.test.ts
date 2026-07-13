/**
 * Determinisztikus teszt a Sandbox App Registry F-AR-1 magjához
 * (Feature-spec — App Registry §4, §6.4, §8, §10). Futtatás: npm run test:sandbox-app
 *
 * DB és élő hálózat NÉLKÜL igazolja az általános create/version/activate/list/get
 * API-t, a determinisztikus hash-t, a verzió-immutabilitást, a HTML security-lintet,
 * a méretlimitet, a tenant-izolációt és az A0 policy-kényszert. Egyúttal a kötelező
 * negatív teszteket (§10.2 — N1, N2, N3, N8) és az AR10 (HTML nem kerül auditba).
 */
import assert from 'node:assert/strict'
import type {
  AuditLog,
  Conversation,
  SandboxApp,
  SandboxAppVersion,
  Ticket,
} from '@prisma/client'
import type {
  AddSandboxAppVersionInput,
  AuditRepository,
  ConversationRepository,
  CreateSandboxAppInput,
  SandboxAppListFilter,
  SandboxAppListItem,
  SandboxAppRepository,
  SandboxAppWithLatestVersion,
  TicketRepository,
} from '../src/repositories/interfaces'
import { SandboxAppService } from '../src/domain/sandbox/sandbox-app-service'
import { artifactObjectPath, type ArtifactStore } from '../src/domain/sandbox/artifact-store'
import { SandboxAppError } from '../src/domain/sandbox/errors'
import {
  signPreviewToken,
  verifyPreviewToken,
  PreviewTokenError,
} from '../src/domain/sandbox/preview-token'

let failures = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ---- Fake-ek ----------------------------------------------------------------

class FakeArtifactStore implements ArtifactStore {
  private store = new Map<string, string>()
  async put(params: { tenantId: string | null; appId: string; version: number; html: string }) {
    const artifactRef = artifactObjectPath(params)
    this.store.set(artifactRef, params.html)
    return { artifactRef, sizeBytes: Buffer.byteLength(params.html, 'utf8') }
  }
  async get(artifactRef: string) {
    const html = this.store.get(artifactRef)
    if (html == null) throw new SandboxAppError('APP_VERSION_NOT_FOUND', 'artifact missing')
    return html
  }
}

class FakeAudit implements AuditRepository {
  events: AuditLog[] = []
  async append(data: Omit<AuditLog, 'id' | 'seq' | 'createdAt' | 'hash' | 'prevHash'>) {
    const row = {
      ...data,
      id: `audit-${this.events.length + 1}`,
      seq: BigInt(this.events.length + 1),
      createdAt: new Date(),
      hash: null,
      prevHash: null,
    } as AuditLog
    this.events.push(row)
    return row
  }
  async findMany(filter?: { action?: string; limit?: number }) {
    return this.events.filter((e) => !filter?.action || e.action === filter.action)
  }
  async findAll() {
    return this.events
  }
  // A service nem hívja az alábbiakat, de az interfész megköveteli.
  async getActionCounts(): Promise<Record<string, number>> {
    return {}
  }
}

class FakeTickets implements Partial<TicketRepository> {
  async findById(): Promise<Ticket | null> {
    return null
  }
}

class FakeConversations implements Partial<ConversationRepository> {
  async findById(): Promise<Conversation | null> {
    return null
  }
}

class FakeSandboxApps implements SandboxAppRepository {
  apps = new Map<string, SandboxApp>()
  versions: SandboxAppVersion[] = []
  private appSeq = 0
  private verSeq = 0

  async findByIdWithLatestVersion(appId: string): Promise<SandboxAppWithLatestVersion | null> {
    const app = this.apps.get(appId)
    if (!app) return null
    const versions = this.versions
      .filter((v) => v.appId === appId)
      .sort((a, b) => b.version - a.version)
      .slice(0, 1)
    return { ...app, versions }
  }

  async findLatestByTicketId(ticketId: string): Promise<SandboxAppWithLatestVersion | null> {
    const v = this.versions
      .filter((x) => x.sourceTicketId === ticketId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
    return v ? this.findByIdWithLatestVersion(v.appId) : null
  }

  async findById(appId: string): Promise<SandboxApp | null> {
    return this.apps.get(appId) ?? null
  }

  async create(input: CreateSandboxAppInput): Promise<SandboxApp> {
    const id = `app-${++this.appSeq}`
    const now = new Date()
    const app = {
      id,
      tenantId: input.tenantId,
      sandboxId: input.sandboxId ?? null,
      name: input.name,
      description: input.description ?? null,
      level: 'A0',
      type: 'single_html',
      status: 'draft',
      criticality: input.criticality,
      activeVersionId: null,
      createdByType: input.createdByType,
      createdByUserId: input.createdByUserId ?? null,
      createdByAgentId: input.createdByAgentId ?? null,
      createdFromTicketId: input.createdFromTicketId ?? null,
      createdFromConversationId: input.createdFromConversationId ?? null,
      policy: input.policy,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    } as unknown as SandboxApp
    this.apps.set(id, app)
    return app
  }

  async findVersionByContentHash(appId: string, contentHash: string): Promise<SandboxAppVersion | null> {
    return (
      this.versions
        .filter((v) => v.appId === appId && v.contentHash === contentHash)
        .sort((a, b) => b.version - a.version)[0] ?? null
    )
  }

  async deleteVersion(versionId: string): Promise<void> {
    this.versions = this.versions.filter((v) => v.id !== versionId)
  }

  async addVersion(input: AddSandboxAppVersionInput): Promise<SandboxAppVersion> {
    const existing = this.versions.filter((v) => v.appId === input.appId)
    const version = existing.reduce((m, v) => Math.max(m, v.version), 0) + 1
    const artifactRef = artifactObjectPath({
      tenantId: input.tenantId,
      appId: input.appId,
      version,
    })
    const row = {
      id: `ver-${++this.verSeq}`,
      tenantId: input.tenantId,
      appId: input.appId,
      version,
      status: 'draft',
      changeSummary: input.changeSummary,
      artifactRef,
      artifactSizeBytes: input.artifactSizeBytes,
      contentHash: input.contentHash,
      mimeType: input.mimeType ?? 'text/html; charset=utf-8',
      createdByType: input.createdByType,
      createdByUserId: input.createdByUserId ?? null,
      createdByAgentId: input.createdByAgentId ?? null,
      createdFromRunId: input.createdFromRunId ?? null,
      sourceTicketId: input.sourceTicketId ?? null,
      validationResult: input.validationResult,
      createdAt: new Date(),
    } as unknown as SandboxAppVersion
    this.versions.push(row)
    return row
  }

  async setActiveVersion(params: { appId: string; versionId: string }): Promise<void> {
    for (const v of this.versions) {
      if (v.appId === params.appId && v.status === 'active' && v.id !== params.versionId) {
        ;(v as { status: string }).status = 'superseded'
      }
    }
    const target = this.versions.find((v) => v.id === params.versionId)
    if (target) (target as { status: string }).status = 'active'
    const app = this.apps.get(params.appId)
    if (app) {
      ;(app as { activeVersionId: string | null; status: string }).activeVersionId = params.versionId
      ;(app as { status: string }).status = 'active'
    }
  }

  async archive(appId: string): Promise<SandboxApp> {
    const app = this.apps.get(appId)
    if (!app) throw new Error(`App not found: ${appId}`)
    ;(app as { status: string; archivedAt: Date | null }).status = 'archived'
    ;(app as { archivedAt: Date | null }).archivedAt = new Date()
    return app
  }

  async getVersion(appId: string, version: number): Promise<SandboxAppVersion | null> {
    return this.versions.find((v) => v.appId === appId && v.version === version) ?? null
  }

  async getVersionById(versionId: string): Promise<SandboxAppVersion | null> {
    return this.versions.find((v) => v.id === versionId) ?? null
  }

  async listVersions(appId: string): Promise<SandboxAppVersion[]> {
    return this.versions
      .filter((v) => v.appId === appId)
      .sort((a, b) => b.version - a.version)
  }

  async list(
    filter: SandboxAppListFilter,
  ): Promise<{ items: SandboxAppListItem[]; nextCursor?: string }> {
    const items = [...this.apps.values()]
      .filter((a) => a.tenantId === filter.tenantId)
      .filter((a) => !filter.status || a.status === filter.status)
      .map((a) => ({
        ...a,
        activeVersion: this.versions.find((v) => v.id === a.activeVersionId) ?? null,
      }))
    return { items }
  }

  async getRegistryMetrics(tenantId: string | null) {
    const apps = [...this.apps.values()].filter((a) => a.tenantId === tenantId)
    const appIds = apps.map((a) => a.id)
    const appsByStatus: Record<string, number> = {}
    let agent = 0
    let user = 0
    for (const a of apps) {
      appsByStatus[a.status] = (appsByStatus[a.status] ?? 0) + 1
      if (a.createdByType === 'agent') agent += 1
      else user += 1
    }
    const versions = this.versions.filter((v) => appIds.includes(v.appId))
    const versionsTotal = versions.length
    const avgSize =
      versionsTotal > 0
        ? versions.reduce((s, v) => s + v.artifactSizeBytes, 0) / versionsTotal
        : 0
    return {
      appsTotal: apps.length,
      appsByStatus,
      appsByCreator: { agent, user },
      versionsTotal,
      avgVersionsPerApp: apps.length > 0 ? versionsTotal / apps.length : 0,
      avgArtifactSizeBytes: Math.round(avgSize),
      appIds,
    }
  }
}

// ---- Fixture ----------------------------------------------------------------

const ACTOR_A = { userId: 'user-A', tenantId: 'tenant-A' }
const ACTOR_B = { userId: 'user-B', tenantId: 'tenant-B' }
const GOOD_HTML = '<!doctype html><html><body><h1>Riport</h1><p>Helló</p></body></html>'

function buildService() {
  const apps = new FakeSandboxApps()
  const audit = new FakeAudit()
  const service = new SandboxAppService(
    apps,
    new FakeTickets() as unknown as TicketRepository,
    new FakeConversations() as unknown as ConversationRepository,
    audit,
    new FakeArtifactStore(),
  )
  return { service, apps, audit }
}

// ---- Tesztek ----------------------------------------------------------------

async function main() {
  console.log('Sandbox App Registry — F-AR-1 determinisztikus teszt\n')

  await test('AR2 — create + version determinisztikus SHA-256 hash (64 hex)', async () => {
    const { service } = buildService()
    const a = await service.createSandboxApp({ name: 'Riport A', criticality: 'L1' }, ACTOR_A)
    assert.equal(a.status, 'draft')
    const v = await service.upsertSandboxAppVersion(
      { appId: a.appId, html: GOOD_HTML, changeSummary: 'első', activate: true },
      ACTOR_A,
    )
    assert.equal(v.version, 1)
    assert.equal(v.status, 'active')
    assert.match(v.contentHash, /^[0-9a-f]{64}$/)

    // Ugyanaz a HTML → ugyanaz a hash (másik appon, hogy ne ütközzön a unique).
    const b = await service.createSandboxApp({ name: 'Riport B', criticality: 'L1' }, ACTOR_A)
    const v2 = await service.upsertSandboxAppVersion(
      { appId: b.appId, html: GOOD_HTML, changeSummary: 'első' },
      ACTOR_A,
    )
    assert.equal(v2.contentHash, v.contentHash)
  })

  await test('AR3 — régi verzió immutable, új verzió növekvő számot kap', async () => {
    const { service, apps } = buildService()
    const a = await service.createSandboxApp({ name: 'Verziózott', criticality: 'L1' }, ACTOR_A)
    await service.upsertSandboxAppVersion(
      { appId: a.appId, html: GOOD_HTML, changeSummary: 'v1', activate: true },
      ACTOR_A,
    )
    const v1Snapshot = (await apps.listVersions(a.appId)).find((v) => v.version === 1)
    const v2 = await service.upsertSandboxAppVersion(
      { appId: a.appId, html: GOOD_HTML.replace('Helló', 'Szia'), changeSummary: 'v2' },
      ACTOR_A,
    )
    assert.equal(v2.version, 2)
    const v1After = (await apps.listVersions(a.appId)).find((v) => v.version === 1)
    assert.equal(v1After?.contentHash, v1Snapshot?.contentHash, 'v1 hash nem változhat')
    assert.notEqual(v2.contentHash, v1Snapshot?.contentHash)
  })

  await test('AR4 — aktív verzió visszaállítható korábbira (rollback)', async () => {
    const { service } = buildService()
    const a = await service.createSandboxApp({ name: 'Rollback', criticality: 'L1' }, ACTOR_A)
    await service.upsertSandboxAppVersion(
      { appId: a.appId, html: GOOD_HTML, changeSummary: 'v1', activate: true },
      ACTOR_A,
    )
    await service.upsertSandboxAppVersion(
      { appId: a.appId, html: GOOD_HTML.replace('Helló', 'Szia'), changeSummary: 'v2', activate: true },
      ACTOR_A,
    )
    const res = await service.activateSandboxAppVersion({ appId: a.appId, version: 1 }, ACTOR_A)
    assert.equal(res.activeVersion, 1)
    const detail = await service.getSandboxApp({ appId: a.appId }, ACTOR_A)
    const v1 = detail.versions.find((v) => v.version === 1)
    const v2 = detail.versions.find((v) => v.version === 2)
    assert.equal(v1?.status, 'active')
    assert.equal(v2?.status, 'superseded')
  })

  await test('N3 — <object> hard-fail → APP_VALIDATION_FAILED + validation_failed audit', async () => {
    const { service, audit } = buildService()
    const a = await service.createSandboxApp({ name: 'Veszélyes', criticality: 'L1' }, ACTOR_A)
    await assert.rejects(
      service.upsertSandboxAppVersion(
        { appId: a.appId, html: '<object data="x"></object>', changeSummary: 'rossz' },
        ACTOR_A,
      ),
      (e) => e instanceof SandboxAppError && e.code === 'APP_VALIDATION_FAILED',
    )
    assert.ok((await audit.findMany({ action: 'sandbox_app.validation_failed' })).length === 1)
  })

  await test('N2 — méretlimit felett → APP_ARTIFACT_TOO_LARGE, nincs verzió', async () => {
    const { service, apps } = buildService()
    const a = await service.createSandboxApp(
      { name: 'Limit', criticality: 'L1', policy: { maxArtifactSizeBytes: 100 } },
      ACTOR_A,
    )
    const big = `<!doctype html><body>${'x'.repeat(500)}</body>`
    await assert.rejects(
      service.upsertSandboxAppVersion({ appId: a.appId, html: big, changeSummary: 'nagy' }, ACTOR_A),
      (e) => e instanceof SandboxAppError && e.code === 'APP_ARTIFACT_TOO_LARGE',
    )
    assert.equal((await apps.listVersions(a.appId)).length, 0)
  })

  await test('N1 — cross-tenant hozzáférés → APP_NOT_FOUND_OR_FORBIDDEN + access_denied audit', async () => {
    const { service, audit } = buildService()
    const a = await service.createSandboxApp({ name: 'Tenant A app', criticality: 'L1' }, ACTOR_A)
    await assert.rejects(
      service.getSandboxApp({ appId: a.appId }, ACTOR_B),
      (e) => e instanceof SandboxAppError && e.code === 'APP_NOT_FOUND_OR_FORBIDDEN',
    )
    assert.ok((await audit.findMany({ action: 'sandbox_app.access_denied' })).length === 1)
  })

  await test('N1 (archive) — más tenant nem archiválhat sandbox appot', async () => {
    const { service, audit } = buildService()
    const a = await service.createSandboxApp({ name: 'Tenant A archive', criticality: 'L1' }, ACTOR_A)
    await assert.rejects(
      service.archiveSandboxApp({ appId: a.appId, reason: 'cleanup' }, ACTOR_B),
      (e) => e instanceof SandboxAppError && e.code === 'APP_NOT_FOUND_OR_FORBIDDEN',
    )
    assert.ok((await audit.findMany({ action: 'sandbox_app.access_denied' })).length === 1)

    const archived = await service.archiveSandboxApp({ appId: a.appId, reason: 'cleanup' }, ACTOR_A)
    assert.deepEqual(archived, { appId: a.appId, status: 'archived' })
    assert.ok((await audit.findMany({ action: 'sandbox_app.archive' })).length === 1)
  })

  await test('N8 — A0 policy kényszer: connector / magasabb szint → POLICY_NOT_ALLOWED_FOR_A0', async () => {
    const { service } = buildService()
    await assert.rejects(
      service.createSandboxApp({ name: 'Connector app', policy: { connectors: ['gmail'] } }, ACTOR_A),
      (e) => e instanceof SandboxAppError && e.code === 'POLICY_NOT_ALLOWED_FOR_A0',
    )
    await assert.rejects(
      service.createSandboxApp({ name: 'A2 app', policy: { level: 'A2' } }, ACTOR_A),
      (e) => e instanceof SandboxAppError && e.code === 'POLICY_NOT_ALLOWED_FOR_A0',
    )
  })

  await test('AR10 — audit payload SEM tartalmaz HTML-t', async () => {
    const { service, audit } = buildService()
    const marker = 'SECRET_HTML_MARKER_42'
    const a = await service.createSandboxApp({ name: 'No HTML in audit', criticality: 'L1' }, ACTOR_A)
    await service.upsertSandboxAppVersion(
      { appId: a.appId, html: `<!doctype html><body>${marker}</body>`, changeSummary: 'x', activate: true },
      ACTOR_A,
    )
    const serialized = JSON.stringify(
      (await audit.findAll()).map((e) => ({
        action: e.action,
        inputRef: e.inputRef,
        outputRef: e.outputRef,
        metadata: e.metadata,
      })),
    )
    assert.ok(!serialized.includes(marker), 'a HTML-marker nem szivároghat auditba')
    assert.ok(serialized.includes('sandbox_app.version.create'))
  })

  // ── F-AR-2: preview izoláció ───────────────────────────────────────────────

  await test('AR5 — aláírt preview URL + cookieless servePreviewByToken visszaadja a HTML-t', async () => {
    const { service, audit } = buildService()
    const a = await service.createSandboxApp({ name: 'Preview app', criticality: 'L1' }, ACTOR_A)
    await service.upsertSandboxAppVersion(
      { appId: a.appId, html: GOOD_HTML, changeSummary: 'v1', activate: true },
      ACTOR_A,
    )
    const { previewUrl, contentHash } = await service.getSandboxAppPreviewUrl(
      { appId: a.appId },
      ACTOR_A,
    )
    assert.match(previewUrl, /\/api\/sandbox-apps\/preview\?t=/)
    assert.ok((await audit.findMany({ action: 'sandbox_app.preview' })).length === 1)

    const token = decodeURIComponent(previewUrl.split('t=')[1])
    const served = await service.servePreviewByToken(token)
    assert.equal(served.html, GOOD_HTML)
    assert.equal(served.contentHash, contentHash)
  })

  await test('preview token: lejárt token → PreviewTokenError', () => {
    const token = signPreviewToken({
      tenantId: 'tenant-A',
      appId: 'app-1',
      version: 1,
      contentHash: 'abc',
      expiresAt: Date.now() - 1000,
    })
    assert.throws(() => verifyPreviewToken(token), (e) => e instanceof PreviewTokenError)
  })

  await test('preview token: manipulált aláírás → PreviewTokenError', () => {
    const token = signPreviewToken({
      tenantId: 'tenant-A',
      appId: 'app-1',
      version: 1,
      contentHash: 'abc',
      expiresAt: Date.now() + 60_000,
    })
    const [payload] = token.split('.')
    assert.throws(
      () => verifyPreviewToken(`${payload}.tampered_signature`),
      (e) => e instanceof PreviewTokenError,
    )
  })

  await test('N1 (preview) — más tenant nem kérhet preview URL-t', async () => {
    const { service } = buildService()
    const a = await service.createSandboxApp({ name: 'Tenant A preview', criticality: 'L1' }, ACTOR_A)
    await service.upsertSandboxAppVersion(
      { appId: a.appId, html: GOOD_HTML, changeSummary: 'v1', activate: true },
      ACTOR_A,
    )
    await assert.rejects(
      service.getSandboxAppPreviewUrl({ appId: a.appId }, ACTOR_B),
      (e) => e instanceof SandboxAppError && e.code === 'APP_NOT_FOUND_OR_FORBIDDEN',
    )
  })

  await test('preview token verzióhoz/integritáshoz kötött (más app tokenje nem érvényes)', async () => {
    const { service } = buildService()
    const a = await service.createSandboxApp({ name: 'Pinned', criticality: 'L1' }, ACTOR_A)
    await service.upsertSandboxAppVersion(
      { appId: a.appId, html: GOOD_HTML, changeSummary: 'v1', activate: true },
      ACTOR_A,
    )
    // Hamis contentHash-re aláírt token → integritás-ellenőrzés elbukik.
    const forged = signPreviewToken({
      tenantId: ACTOR_A.tenantId,
      appId: a.appId,
      version: 1,
      contentHash: 'deadbeef',
      expiresAt: Date.now() + 60_000,
    })
    await assert.rejects(
      service.servePreviewByToken(forged),
      (e) => e instanceof SandboxAppError && e.code === 'APP_NOT_FOUND_OR_FORBIDDEN',
    )
  })

  // ── §8.3: observability metrikák ───────────────────────────────────────────
  await test('§8.3 — getRegistryMetrics tenant-scoped: app/verzió/creator + eseményszámok', async () => {
    const { service } = buildService()

    // tenant-A: 2 app, az egyikhez 2 verzió; egy preview; egy validációs hiba.
    const a1 = await service.createSandboxApp({ name: 'App-A1', criticality: 'L1' }, ACTOR_A)
    await service.upsertSandboxAppVersion(
      { appId: a1.appId, html: GOOD_HTML, changeSummary: 'v1', activate: true },
      ACTOR_A,
    )
    await service.upsertSandboxAppVersion(
      { appId: a1.appId, html: GOOD_HTML.replace('Helló', 'Szia'), changeSummary: 'v2', activate: true },
      ACTOR_A,
    )
    const a2 = await service.createSandboxApp({ name: 'App-A2', criticality: 'L1' }, ACTOR_A)
    await service.upsertSandboxAppVersion(
      { appId: a2.appId, html: GOOD_HTML, changeSummary: 'v1', activate: true },
      ACTOR_A,
    )
    await service.getSandboxAppPreviewUrl({ appId: a1.appId, version: 1 }, ACTOR_A)
    await assert.rejects(
      service.upsertSandboxAppVersion(
        { appId: a2.appId, html: '<object data="x"></object>', changeSummary: 'bad' },
        ACTOR_A,
      ),
    )

    // tenant-B: külön app — nem szivároghat A metrikáiba; cross-tenant deny A appjára.
    await service.createSandboxApp({ name: 'App-B1', criticality: 'L1' }, ACTOR_B)
    await assert.rejects(service.getSandboxApp({ appId: a1.appId }, ACTOR_B))

    const m = await service.getRegistryMetrics(ACTOR_A)
    assert.equal(m.appsTotal, 2, 'csak tenant-A appok')
    assert.equal(m.versionsTotal, 3)
    assert.equal(m.appsByCreator.user, 2)
    assert.equal(m.appsByCreator.agent, 0)
    assert.equal(m.avgVersionsPerApp, 1.5)
    assert.ok(m.avgArtifactSizeBytes > 0)
    assert.equal(m.events.preview, 1)
    assert.equal(m.events.validationFailed, 1)
    assert.equal(m.events.accessDenied, 1, 'cross-tenant deny A appjára számít')

    const mb = await service.getRegistryMetrics(ACTOR_B)
    assert.equal(mb.appsTotal, 1)
    assert.equal(mb.versionsTotal, 0)
    assert.equal(mb.events.preview, 0)
  })

  if (failures > 0) {
    console.error(`\n❌ ${failures} teszt elbukott`)
    process.exit(1)
  }
  console.log('\n✅ minden sandbox app registry teszt zöld')
}

void main()
