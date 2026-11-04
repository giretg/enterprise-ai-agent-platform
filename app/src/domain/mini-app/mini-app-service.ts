/**
 * Mini appok (#967): agent által készített, statikus, egyfájlos HTML (A0),
 * verziózva, agentek között megosztva. Az app az agenté (D3); a megosztott
 * címzett olvas és másolhat (D4); szervezeti láthatóság (D11).
 *
 * A HTML SOHA nem kerül auditba — csak appId, verzió, hash, méret, lint-kódok.
 */
import { writeAudit, type AuditSink } from '@/lib/audit/types'
import { GENERAL_WORK_PROJECT_KEY } from '@/lib/work-project'
import { miniAppLinkTtlMs, type MiniAppTenantSettings } from '@/lib/mini-app-settings'
import {
  MINI_APP_LIVE_LINK_TTL_MS,
  parseDataBindingsInput,
  sameBindings,
  type MiniAppDataBinding,
  type MiniAppDataBindingInput,
} from './data-binding'
import { guideConflicts, lintBoundMiniAppHtml, lintMiniAppHtml, miniAppByteSize, miniAppContentHash } from './html-lint'
import type {
  MiniAppListScope,
  MiniAppRecord,
  MiniAppStore,
  MiniAppVersionMeta,
  MiniAppVisibility,
  NewMiniAppVersion,
} from './types'

export const MINI_APP_NAME_MIN = 3
export const MINI_APP_NAME_MAX = 80
export const MINI_APP_DESCRIPTION_MAX = 1_000
export const MINI_APP_CHANGE_NOTE_MAX = 500
export const MINI_APP_GUIDE_MAX = 8_000
export const MINI_APP_SHARE_TARGETS_MAX = 20
/** D9: egy `get source` válasz legfeljebb ennyi karaktert ad vissza; a többi `offset`-tel lapozható. */
export const MINI_APP_SOURCE_PAGE_MAX = 100_000
/** D10: archiválás után ennyi nap múlva a verziók véglegesen törlődnek. */
export const MINI_APP_ARCHIVE_RETENTION_DAYS = 90

export const MINI_APP_PLATFORM_RULES = [
  'A mini app egyetlen önálló HTML-fájl (jellemzően riport), amit az ember böngészőben nyit meg.',
  'Minden adatot ágyazz be a HTML-be (táblázat, JSON egy <script> blokkban, képek data: URI-ként). Beágyazott adat utólag nem frissül magától.',
  'Élő adat: ha a riport mentett adattárház-lekérdezésből dolgozik, kösd hozzá dataBindings-szel, így minden megnyitáskor a legutóbbi betöltés adatát mutatja, új verzió nélkül. Csak a saját mentett lekérdezésed köthető, legfeljebb 5, kötésenként legfeljebb 5000 sor, összesen 2 MB.',
  'Élő adat olvasása: const { alias } = JSON.parse(document.getElementById(\'platform-data\').textContent). Sikeres blokk: { status: "ok", columns, columnLabels, rows, truncated, dataAsOf, warnings }; hibás blokk: { status: "error", code }. Mindkettőt és a truncated értéket is kezeld.',
  'Élő adatnál a cellaérték külső forrásból jöhet, ezért csak textContent-tel írd ki. Tilos, és a platform elutasítja: innerHTML, outerHTML, insertAdjacentHTML, document.write, on*= attribútum, külső szkript, stíluslap és hálózati hívás. Eseménykezelőt addEventListener-rel adj meg. A <script> blokkok csak a mentett tartalmukkal futnak: szkriptet futásidőben ne hozz létre.',
  'Hálózat nincs: külső szkript, stíluslap, betűtípus, fetch, XMLHttpRequest, WebSocket nem töltődik be és nem fut.',
  'Tilos: <iframe>, <object>, <embed>, <form> — az ilyen HTML-t a platform elutasítja.',
  'Sütik, localStorage, sessionStorage nem működnek; a keretoldalon kívülre (window.top, parent) nem hathat.',
  'Inline <style> és <script> használható; a platform felülre információs sávot tesz (cím, készült, utoljára módosítva, készítő, verzió) — ezt ne ismételd meg.',
  'Méret-plafon: a szervezeti beállítás szerint, legfeljebb 1 MB UTF-8.',
].join('\n')

export type MiniAppLinks = { openUrl: string; openUrlExpiresAt: string; permanentUrl: string }

export type MiniAppServiceDeps = {
  store: MiniAppStore
  /** Agent-nevek a listához és az információs sávhoz (csak a tenanton belül). */
  agentNames(tenantId: string, agentIds: string[]): Promise<Map<string, string>>
  settings(tenantId: string): Promise<MiniAppTenantSettings>
  links: {
    mint(input: {
      tenantId: string
      appId: string
      version: number
      contentHash: string
      requesterUserId: string
      ttlMs: number
    }): MiniAppLinks
    permanentUrl(appId: string): string
  }
  /** Élő adat-kötés (#1083): a tulajdonos saját lekérdezése, próbafuttatással. */
  liveData?: {
    prepare(actor: MiniAppActor, inputs: MiniAppDataBindingInput[]): Promise<{ ok: true; bindings: MiniAppDataBinding[] } | Fail>
    latestQueryVersion(actor: MiniAppActor, queryId: string): Promise<number | null>
  }
  audit?: AuditSink
  now?: () => Date
}

export type MiniAppActor = { tenantId: string; agentId: string; userId: string; role?: string }

type Fail = { ok: false; code: string; extra?: Record<string, unknown> }
type Ok<T> = { ok: true } & T
export type MiniAppResult<T> = Ok<T> | Fail

function fail(code: string, extra?: Record<string, unknown>): Fail {
  return extra ? { ok: false, code, extra } : { ok: false, code }
}

export type MiniAppRelation = 'owner' | 'shared' | 'organization'

export type MiniAppListRow = {
  appId: string
  name: string
  description: string | null
  ownerAgentId: string
  ownerAgentName: string
  relation: MiniAppRelation
  status: MiniAppRecord['status']
  version: number
  createdAt: string
  updatedAt: string
  visibility: MiniAppVisibility
  sharedWith: string
  copiedFrom?: string
}

/** A kötésből csak azonosító kerül auditba, paraméter-érték nem. */
function bindingAudit(bindings: MiniAppDataBinding[]) {
  return bindings.length > 0 ? { dataBindings: bindings.map(({ alias, queryId, queryVersion }) => ({ alias, queryId, queryVersion })) } : {}
}

export class MiniAppService {
  constructor(private deps: MiniAppServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  /** Olvasási jog: tulajdonos, aktív megosztás, vagy szervezeti láthatóság. */
  async relationOf(app: MiniAppRecord, agentId: string): Promise<MiniAppRelation | null> {
    if (app.ownerAgentId === agentId) return 'owner'
    if (app.status !== 'active') return null
    if (await this.deps.store.hasActiveShare(app.id, agentId)) return 'shared'
    if (app.visibility === 'organization') return 'organization'
    return null
  }

  /** Olvasható app az agentnek, különben `mini_app_not_found` (nem árulja el, hogy létezik). */
  private async readable(actor: MiniAppActor, appId: string): Promise<MiniAppResult<{ app: MiniAppRecord; relation: MiniAppRelation }>> {
    const app = await this.deps.store.findById(actor.tenantId, appId)
    if (!app || app.tenantId !== actor.tenantId) return fail('mini_app_not_found')
    const relation = await this.relationOf(app, actor.agentId)
    if (!relation) return fail('mini_app_not_found')
    return { ok: true, app, relation }
  }

  private async owned(actor: MiniAppActor, appId: string): Promise<MiniAppResult<{ app: MiniAppRecord }>> {
    const found = await this.readable(actor, appId)
    if (!found.ok) return found
    if (found.relation !== 'owner') return fail('mini_app_not_owner')
    return { ok: true, app: found.app }
  }

  private async gate(
    actor: MiniAppActor,
    html: string,
    context: { appId?: string; name?: string },
    dataBindings: MiniAppDataBinding[] = [],
  ): Promise<MiniAppResult<{ version: Omit<NewMiniAppVersion, 'changeNote' | 'idempotencyKey'> }>> {
    const { maxBytes } = await this.deps.settings(actor.tenantId)
    const byteSize = miniAppByteSize(html)
    const base = lintMiniAppHtml(html)
    // Élő adatnál külső forrású szöveg kerül a lapra: a szabályok ott szigorúbbak (§5), a statikus app nem változik.
    const lint = dataBindings.length > 0 ? { errors: [...base.errors, ...lintBoundMiniAppHtml(html)], warnings: base.warnings } : base
    const tooLarge = byteSize > maxBytes
    if (tooLarge || lint.errors.length > 0 || !html.trim()) {
      await this.audit(actor, 'mini_app.validation_failed', context.appId ?? null, {
        byteSize,
        maxBytes,
        lintErrors: lint.errors,
        empty: !html.trim(),
      })
      if (!html.trim()) return fail('mini_app_validation_failed', { errors: ['empty_html'] })
      if (tooLarge) return fail('mini_app_too_large', { byteSize, maxBytes })
      return fail('mini_app_validation_failed', { errors: lint.errors })
    }
    return {
      ok: true,
      version: {
        html,
        contentHash: miniAppContentHash(html),
        byteSize,
        lintWarnings: lint.warnings,
        createdByUserId: actor.userId,
        dataBindings,
      },
    }
  }

  /** JSON-szövegből kötés-lista; hiányzó bemenet `null`, az üres lista a kötés levétele. */
  private async prepareBindings(actor: MiniAppActor, raw: string | undefined): Promise<MiniAppResult<{ bindings: MiniAppDataBinding[] | null }>> {
    if (raw === undefined) return { ok: true, bindings: null }
    const parsed = parseDataBindingsInput(raw)
    if (!parsed.ok) return fail('invalid_data_bindings', { detail: parsed.detail })
    if (parsed.bindings.length === 0) return { ok: true, bindings: [] }
    if (!this.deps.liveData) return fail('invalid_data_bindings', { detail: 'live data is not available' })
    return this.deps.liveData.prepare(actor, parsed.bindings)
  }

  async create(
    actor: MiniAppActor,
    input: {
      name: string
      description?: string
      html?: string
      copyFromAppId?: string
      projectKey?: string
      dataBindings?: string
      idempotencyKey: string
    },
  ): Promise<MiniAppResult<{ app: MiniAppRecord; version: number; contentHash: string; lintWarnings: string[]; links: MiniAppLinks; created: boolean }>> {
    const name = input.name.trim()
    if (name.length < MINI_APP_NAME_MIN || name.length > MINI_APP_NAME_MAX) return fail('invalid_args')
    const description = input.description?.trim() || null
    if (description && description.length > MINI_APP_DESCRIPTION_MAX) return fail('invalid_args')

    const existing = await this.deps.store.findByCreateKey(actor.tenantId, actor.agentId, input.idempotencyKey)
    if (existing) return this.createdResult(actor, existing, false)

    let html = input.html
    let copiedFrom: { appId: string; version: number } | null = null
    if (input.copyFromAppId) {
      const source = await this.readable(actor, input.copyFromAppId)
      if (!source.ok) return source
      const current = await this.deps.store.findVersion(source.app.id, source.app.currentVersion)
      if (!current) return fail('mini_app_not_found')
      // §4.4: a másoló agent nem a saját lekérdezéséből dolgozna, ezért v1-ben nem másolható.
      if (current.dataBindings.length > 0) return fail('mini_app_copy_has_data_binding')
      html ??= current.html
      copiedFrom = { appId: source.app.id, version: current.version }
    }
    if (typeof html !== 'string') return fail('invalid_args')
    const prepared = await this.prepareBindings(actor, input.dataBindings)
    if (!prepared.ok) return prepared
    const gated = await this.gate(actor, html, { name }, prepared.bindings ?? [])
    if (!gated.ok) return gated

    const { app, created } = await this.deps.store.createWithVersion({
      tenantId: actor.tenantId,
      ownerAgentId: actor.agentId,
      projectKey: input.projectKey?.trim().slice(0, 120) || GENERAL_WORK_PROJECT_KEY,
      name,
      description,
      copiedFromAppId: copiedFrom?.appId ?? null,
      copiedFromVersion: copiedFrom?.version ?? null,
      createIdempotencyKey: input.idempotencyKey,
      createdByUserId: actor.userId,
      version: { ...gated.version, changeNote: null, idempotencyKey: null },
    })
    if (created) {
      await this.audit(actor, copiedFrom ? 'mini_app.copied' : 'mini_app.created', app.id, {
        version: 1,
        contentHash: gated.version.contentHash,
        byteSize: gated.version.byteSize,
        lintWarnings: gated.version.lintWarnings,
        ...bindingAudit(gated.version.dataBindings),
        ...(copiedFrom ? { copiedFromAppId: copiedFrom.appId, copiedFromVersion: copiedFrom.version } : {}),
      })
    }
    return this.createdResult(actor, app, created)
  }

  private async createdResult(actor: MiniAppActor, app: MiniAppRecord, created: boolean) {
    const version = await this.deps.store.findVersion(app.id, 1)
    if (!version) return fail('mini_app_not_found')
    const links = await this.issueLinks(actor, app, version)
    return {
      ok: true as const,
      app,
      version: 1,
      contentHash: version.contentHash,
      lintWarnings: version.lintWarnings,
      links,
      created,
    }
  }

  async update(
    actor: MiniAppActor,
    input: { appId: string; html?: string; changeNote?: string; dataBindings?: string; idempotencyKey: string },
  ): Promise<MiniAppResult<{ appId: string; name: string; version: number; contentHash: string; lintWarnings: string[]; unchanged: boolean; links: MiniAppLinks }>> {
    const owned = await this.owned(actor, input.appId)
    if (!owned.ok) return owned
    const { app } = owned
    if (app.status !== 'active') return fail('mini_app_archived')
    const changeNote = input.changeNote?.trim() || null
    if (changeNote && changeNote.length > MINI_APP_CHANGE_NOTE_MAX) return fail('invalid_args')

    const replay = await this.deps.store.findVersionByKey(app.id, input.idempotencyKey)
    if (replay) return this.versionResult(actor, app, replay, false)

    const current = await this.deps.store.findVersion(app.id, app.currentVersion)
    if (input.html === undefined && (input.dataBindings === undefined || !current)) return fail('invalid_args')
    const prepared = await this.prepareBindings(actor, input.dataBindings)
    if (!prepared.ok) return prepared
    // Kötés nélküli frissítésnél az eddigi kötés marad; a HTML nélküli frissítés csak a kötést cseréli.
    const bindings = prepared.bindings ?? current?.dataBindings ?? []
    const gated = await this.gate(actor, input.html ?? current!.html, { appId: app.id }, bindings)
    if (!gated.ok) return gated
    if (current && current.contentHash === gated.version.contentHash && sameBindings(current.dataBindings, bindings)) {
      return this.versionResult(actor, app, current, true)
    }
    const added = await this.deps.store.addVersion({
      appId: app.id,
      tenantId: actor.tenantId,
      expectedCurrentVersion: app.currentVersion,
      version: { ...gated.version, changeNote, idempotencyKey: input.idempotencyKey },
    })
    if (added === 'conflict') return fail('mini_app_conflict')
    await this.audit(actor, 'mini_app.version_added', app.id, {
      version: added.version,
      contentHash: added.contentHash,
      byteSize: added.byteSize,
      lintWarnings: added.lintWarnings,
      ...bindingAudit(added.dataBindings),
    })
    return this.versionResult(actor, { ...app, currentVersion: added.version }, added, false)
  }

  private async versionResult(actor: MiniAppActor, app: MiniAppRecord, version: MiniAppVersionMeta, unchanged: boolean) {
    return {
      ok: true as const,
      appId: app.id,
      name: app.name,
      version: version.version,
      contentHash: version.contentHash,
      lintWarnings: version.lintWarnings,
      unchanged,
      links: await this.issueLinks(actor, app, version),
    }
  }

  /** Gyors link kiadása (+ audit `mini_app.opened` phase=link_issued). */
  async issueLinks(
    actor: { tenantId: string; userId: string; agentId?: string | null },
    app: MiniAppRecord,
    version: Pick<MiniAppVersionMeta, 'version' | 'contentHash' | 'dataBindings'>,
  ): Promise<MiniAppLinks> {
    const { linkTtl } = await this.deps.settings(app.tenantId)
    const ttlMs = miniAppLinkTtlMs(linkTtl)
    const links = this.deps.links.mint({
      tenantId: app.tenantId,
      appId: app.id,
      version: version.version,
      contentHash: version.contentHash,
      requesterUserId: actor.userId,
      // D6: egy kiszivárgott link ne mutassa hetekig a friss adatot.
      ttlMs: version.dataBindings.length > 0 ? Math.min(ttlMs, MINI_APP_LIVE_LINK_TTL_MS) : ttlMs,
    })
    await writeAudit(this.deps.audit, {
      actorType: 'human',
      actorId: actor.userId,
      action: 'mini_app.opened',
      targetType: 'mini_app',
      targetId: app.id,
      policyDecision: 'allowed',
      metadata: {
        phase: 'link_issued',
        version: version.version,
        contentHash: version.contentHash,
        expiresAt: links.openUrlExpiresAt,
        ...(actor.agentId ? { agentId: actor.agentId } : {}),
      },
      tenantId: app.tenantId,
    })
    return links
  }

  async list(
    actor: MiniAppActor,
    input: { scope?: MiniAppListScope; query?: string; includeArchived?: boolean; limit?: number; offset?: number },
  ): Promise<MiniAppResult<{ apps: MiniAppListRow[]; nextOffset: number | null }>> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
    const offset = Math.max(input.offset ?? 0, 0)
    const rows = await this.deps.store.listVisibleToAgent({
      tenantId: actor.tenantId,
      agentId: actor.agentId,
      scope: input.scope ?? 'all',
      query: input.query?.trim() || undefined,
      includeArchived: input.includeArchived === true,
      limit: limit + 1,
      offset,
    })
    const page = rows.slice(0, limit)
    const apps = await this.describe(actor.tenantId, page, actor.agentId)
    return { ok: true, apps, nextOffset: rows.length > limit ? offset + limit : null }
  }

  /** Lista-sorok névvel, megosztás-chipekkel; a `viewerAgentId` adja a relációt. */
  async describe(tenantId: string, apps: MiniAppRecord[], viewerAgentId: string | null): Promise<MiniAppListRow[]> {
    const shares = new Map(await Promise.all(apps.map(async (app) => [app.id, await this.deps.store.listActiveShares(app.id)] as const)))
    const sources = new Map<string, MiniAppRecord>()
    for (const app of apps) {
      if (app.copiedFromAppId && !sources.has(app.copiedFromAppId)) {
        const source = await this.deps.store.findById(tenantId, app.copiedFromAppId)
        if (source) sources.set(source.id, source)
      }
    }
    const agentIds = new Set<string>()
    for (const app of apps) {
      agentIds.add(app.ownerAgentId)
      for (const share of shares.get(app.id) ?? []) agentIds.add(share.agentId)
    }
    for (const source of sources.values()) agentIds.add(source.ownerAgentId)
    const names = await this.deps.agentNames(tenantId, [...agentIds])
    const nameOf = (id: string) => names.get(id) ?? 'ismeretlen munkatárs'
    return apps.map((app) => {
      const appShares = shares.get(app.id) ?? []
      const relation: MiniAppRelation =
        viewerAgentId === null || app.ownerAgentId === viewerAgentId
          ? 'owner'
          : appShares.some((share) => share.agentId === viewerAgentId)
            ? 'shared'
            : 'organization'
      const source = app.copiedFromAppId ? sources.get(app.copiedFromAppId) : undefined
      return {
        appId: app.id,
        name: app.name,
        description: app.description,
        ownerAgentId: app.ownerAgentId,
        ownerAgentName: nameOf(app.ownerAgentId),
        relation,
        status: app.status,
        version: app.currentVersion,
        createdAt: app.createdAt.toISOString(),
        updatedAt: app.updatedAt.toISOString(),
        visibility: app.visibility,
        sharedWith: appShares.map((share) => nameOf(share.agentId)).join(', '),
        ...(source ? { copiedFrom: `${nameOf(source.ownerAgentId)} / ${source.name} v${app.copiedFromVersion ?? '?'}` } : {}),
      }
    })
  }

  async get(
    actor: MiniAppActor,
    input: { appId: string; version?: number; include?: 'link' | 'source' | 'both'; offset?: number },
  ): Promise<
    MiniAppResult<{
      app: MiniAppListRow
      version: number
      currentVersion: number
      contentHash: string
      lintWarnings: string[]
      links?: MiniAppLinks
      source?: { html: string; offset: number; totalChars: number; nextOffset: number | null }
      dataBindings?: Array<{ alias: string; queryId: string; queryVersion: number; maxRows: number; latestQueryVersion?: number | null }>
    }>
  > {
    const found = await this.readable(actor, input.appId)
    if (!found.ok) return found
    const { app } = found
    if (app.status !== 'active') return fail('mini_app_archived')
    const version = await this.deps.store.findVersion(app.id, input.version ?? app.currentVersion)
    if (!version) return fail('mini_app_version_not_found')
    const include = input.include ?? 'link'
    const [row] = await this.describe(actor.tenantId, [app], actor.agentId)
    const links = include === 'source' ? undefined : await this.issueLinks(actor, app, version)
    let source
    if (include !== 'link') {
      const offset = Math.min(Math.max(input.offset ?? 0, 0), version.html.length)
      const end = Math.min(offset + MINI_APP_SOURCE_PAGE_MAX, version.html.length)
      source = {
        html: version.html.slice(offset, end),
        offset,
        totalChars: version.html.length,
        nextOffset: end < version.html.length ? end : null,
      }
    }
    // A lekérdezés a tulajdonosé: másnak csak a kötés ténye látszik, a verzió-összevetés nem.
    const dataBindings = await Promise.all(
      version.dataBindings.map(async ({ alias, queryId, queryVersion, maxRows }) => ({
        alias,
        queryId,
        queryVersion,
        maxRows,
        ...(found.relation === 'owner' && this.deps.liveData ? { latestQueryVersion: await this.deps.liveData.latestQueryVersion(actor, queryId) } : {}),
      })),
    )
    return {
      ok: true,
      ...(dataBindings.length > 0 ? { dataBindings } : {}),
      app: row!,
      version: version.version,
      currentVersion: app.currentVersion,
      contentHash: version.contentHash,
      lintWarnings: version.lintWarnings,
      ...(links ? { links } : {}),
      ...(source ? { source } : {}),
    }
  }

  /**
   * Megosztás. A célpontok ellenőrzése (azonos tenant, aktív, a principal látja)
   * a hívó dolga a `checkTarget`-tel — a service csak a visszaadott ítéletet alkalmazza.
   */
  async share(
    actor: MiniAppActor,
    input: {
      appId: string
      toAgentIds: string[]
      organization: boolean
      checkTarget: (agentId: string) => Promise<'ok' | 'not_visible'>
    },
  ): Promise<MiniAppResult<{ app: MiniAppRecord; newlySharedAgentIds: string[]; visibility: MiniAppVisibility }>> {
    const owned = await this.owned(actor, input.appId)
    if (!owned.ok) return owned
    const { app } = owned
    if (app.status !== 'active') return fail('mini_app_archived')
    const targets = [...new Set(input.toAgentIds)].filter((id) => id !== app.ownerAgentId)
    if (input.toAgentIds.length > MINI_APP_SHARE_TARGETS_MAX) return fail('invalid_args')
    if (targets.length === 0 && !input.organization) return fail('share_target_required')
    for (const agentId of targets) {
      if ((await input.checkTarget(agentId)) !== 'ok') return fail('share_target_not_visible', { agentId })
    }
    const newly = targets.length
      ? await this.deps.store.activateShares({ tenantId: actor.tenantId, appId: app.id, agentIds: targets, sharedByUserId: actor.userId })
      : []
    if (newly.length) await this.audit(actor, 'mini_app.shared', app.id, { toAgentIds: newly })
    const visibility = await this.recomputeVisibility(actor, app, input.organization ? 'organization' : undefined)
    return { ok: true, app: { ...app, visibility }, newlySharedAgentIds: newly, visibility }
  }

  async unshare(
    actor: MiniAppActor,
    input: { appId: string; fromAgentIds: string[]; organization: boolean },
  ): Promise<MiniAppResult<{ revokedAgentIds: string[]; visibility: MiniAppVisibility }>> {
    const owned = await this.owned(actor, input.appId)
    if (!owned.ok) return owned
    const { app } = owned
    if (input.fromAgentIds.length === 0 && !input.organization) return fail('share_target_required')
    const revoked = input.fromAgentIds.length ? await this.deps.store.revokeShares(app.id, input.fromAgentIds) : []
    if (revoked.length) await this.audit(actor, 'mini_app.unshared', app.id, { fromAgentIds: revoked })
    const visibility = await this.recomputeVisibility(
      actor,
      input.organization ? { ...app, visibility: 'private' } : app,
    )
    return { ok: true, revokedAgentIds: revoked, visibility }
  }

  /** `organization` felülír; különben `agents`, ha van aktív megosztás, egyébként `private`. */
  private async recomputeVisibility(actor: MiniAppActor, app: MiniAppRecord, force?: 'organization'): Promise<MiniAppVisibility> {
    let next: MiniAppVisibility
    if (force === 'organization' || app.visibility === 'organization') next = 'organization'
    else next = (await this.deps.store.listActiveShares(app.id)).length > 0 ? 'agents' : 'private'
    const before = (await this.deps.store.findById(actor.tenantId, app.id))?.visibility ?? app.visibility
    if (before !== next) {
      await this.deps.store.setVisibility(app.id, next)
      await this.audit(actor, 'mini_app.visibility_changed', app.id, { from: before, to: next })
    }
    return next
  }

  async archive(actor: MiniAppActor, input: { appId: string; reason?: string }): Promise<MiniAppResult<{ appId: string }>> {
    const owned = await this.owned(actor, input.appId)
    if (!owned.ok) return owned
    if (owned.app.status === 'archived') return { ok: true, appId: owned.app.id }
    await this.deps.store.setStatus(owned.app.id, 'archived', this.now())
    await this.audit(actor, 'mini_app.archived', owned.app.id, { reason: input.reason?.slice(0, 500) ?? null })
    return { ok: true, appId: owned.app.id }
  }

  async restore(actor: MiniAppActor, input: { appId: string }): Promise<MiniAppResult<{ appId: string }>> {
    const owned = await this.owned(actor, input.appId)
    if (!owned.ok) return owned
    if (owned.app.status === 'active') return { ok: true, appId: owned.app.id }
    await this.deps.store.setStatus(owned.app.id, 'active', null)
    await this.audit(actor, 'mini_app.restored', owned.app.id, {})
    return { ok: true, appId: owned.app.id }
  }

  /** §3.7: platform-szabályok + az agent publikált útmutatója; a szervezeti útmutató helye v2 (D16). */
  guide(snapshotGuide: string | undefined, definitionVersion: number) {
    const agentGuide = snapshotGuide?.trim() ? snapshotGuide.trim() : null
    const conflicts = agentGuide ? guideConflicts(agentGuide) : []
    return {
      platformRules: MINI_APP_PLATFORM_RULES,
      agentGuide,
      agentGuideVersion: agentGuide ? definitionVersion : null,
      organizationGuide: null,
      ...(conflicts.length ? { conflicts, conflictNote: 'Where the agent guide conflicts with platformRules, platformRules win (those resources will not load).' } : {}),
    }
  }

  /** D10: az archiválás után 90 napnál régebbi appok végleges törlése (napi retenciós sweep). */
  async purgeExpiredArchives(): Promise<{ deleted: number }> {
    const cutoff = new Date(this.now().getTime() - MINI_APP_ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    const purged = await this.deps.store.purgeArchivedBefore(cutoff)
    for (const row of purged) {
      await writeAudit(this.deps.audit, {
        actorType: 'system',
        action: 'mini_app.purged',
        targetType: 'mini_app',
        targetId: row.id,
        policyDecision: 'allowed',
        metadata: { retentionDays: MINI_APP_ARCHIVE_RETENTION_DAYS },
        tenantId: row.tenantId,
      })
    }
    return { deleted: purged.length }
  }

  private async audit(actor: MiniAppActor, action: string, appId: string | null, metadata: Record<string, unknown>) {
    await writeAudit(this.deps.audit, {
      actorType: 'human',
      actorId: actor.userId,
      action,
      targetType: 'mini_app',
      targetId: appId,
      policyDecision: action === 'mini_app.validation_failed' ? 'denied' : 'allowed',
      metadata: { agentId: actor.agentId, ...metadata },
      tenantId: actor.tenantId,
    })
  }
}
