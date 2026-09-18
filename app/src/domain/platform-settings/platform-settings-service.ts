import { Prisma } from '@prisma/client'
import type { AuditRepository, PlatformSettingsRepository } from '@/repositories/interfaces'
import { matchForbiddenHost } from '@/domain/net/egress-guard'
import {
  GOOGLE_OAUTH_PLATFORM_KEY,
  GOOGLE_OAUTH_SERVICE_KEYS,
  loadGoogleOAuthConfig,
  loadGoogleDrivePickerConfig,
  type GoogleDrivePickerConfig,
  type GoogleOAuthConfig,
  type GoogleOAuthResolved,
} from '@/lib/platform-google-oauth-config'

export const PROVISIONING_EGRESS_ALLOWLIST_KEY = 'provisioning.egress_allowlist'
const EGRESS_GLOBAL_BUCKET = '__global__'
type EgressAllowlistStore = Record<string, string[]>

function normalizeEgressHost(input: string): string | null {
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return null
  let host = trimmed
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
    try {
      host = new URL(host).hostname.toLowerCase()
    } catch {
      return null
    }
  } else {
    host = host.split('/')[0]!.split('@').pop()!.split(':')[0]!
  }
  if (!host || host.length > 253) return null
  return host
}

export class PlatformSettingsService {
  constructor(
    private settings: PlatformSettingsRepository,
    private audit: AuditRepository,
  ) {}

  async getEgressAllowlist(tenantId: string | null): Promise<string[]> {
    const raw = (await this.settings.get(PROVISIONING_EGRESS_ALLOWLIST_KEY)) as EgressAllowlistStore | null
    if (!raw || typeof raw !== 'object') return []
    const pick = (k: string): string[] => (Array.isArray(raw[k]) ? raw[k] : [])
    return [
      ...new Set(
        [...pick(EGRESS_GLOBAL_BUCKET), ...(tenantId ? pick(tenantId) : [])]
          .filter((h): h is string => typeof h === 'string')
          .map((h) => h.toLowerCase()),
      ),
    ]
  }

  async extendEgressAllowlist(
    tenantId: string | null,
    host: string,
    actorId: string,
    provenance?: { sourceType?: 'official' | 'vendor_doc'; draftId?: string },
  ): Promise<
    | { ok: false; reason: 'invalid_host' | 'forbidden_host' }
    | { ok: true; added: boolean; host: string; hosts: string[] }
  > {
    const normalized = normalizeEgressHost(host)
    if (!normalized) return { ok: false, reason: 'invalid_host' }
    if (matchForbiddenHost(normalized)) return { ok: false, reason: 'forbidden_host' }

    const bucket = tenantId ?? EGRESS_GLOBAL_BUCKET
    const raw = (await this.settings.get(PROVISIONING_EGRESS_ALLOWLIST_KEY)) as EgressAllowlistStore | null
    const store: EgressAllowlistStore = raw && typeof raw === 'object' ? { ...raw } : {}
    const current = (Array.isArray(store[bucket]) ? store[bucket] : [])
      .filter((h): h is string => typeof h === 'string')
      .map((h) => h.toLowerCase())
    if (current.includes(normalized)) {
      return { ok: true, added: false, host: normalized, hosts: current }
    }
    const next = [...current, normalized].sort()
    store[bucket] = next
    await this.settings.set(
      PROVISIONING_EGRESS_ALLOWLIST_KEY,
      store as unknown as Prisma.InputJsonObject,
      actorId,
    )
    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'connector.egress_allowlist.extend',
      targetType: 'connector',
      targetId: provenance?.draftId ?? null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: {
        host: normalized,
        tenantId: tenantId ?? null,
        sourceType: provenance?.sourceType ?? null,
        draftId: provenance?.draftId ?? null,
      },
    })
    return { ok: true, added: true, host: normalized, hosts: next }
  }

  async getGoogleOAuthConfig(): Promise<GoogleOAuthResolved | null> {
    return loadGoogleOAuthConfig({
      service: 'gmail',
      getPlatformValue: () => this.settings.get(GOOGLE_OAUTH_SERVICE_KEYS.gmail),
      getLegacyPlatformValue: () => this.settings.get(GOOGLE_OAUTH_PLATFORM_KEY),
    })
  }

  async getGoogleDriveOAuthConfig(): Promise<GoogleOAuthResolved | null> {
    return loadGoogleOAuthConfig({
      service: 'drive',
      getPlatformValue: () => this.settings.get(GOOGLE_OAUTH_SERVICE_KEYS.drive),
    })
  }

  async getGoogleDrivePickerConfig(): Promise<{
    config: GoogleDrivePickerConfig
    source: GoogleOAuthResolved['source']
  } | null> {
    return loadGoogleDrivePickerConfig({
      getPlatformValue: () => this.settings.get('oauth.google.drive.picker'),
    })
  }

  async upsertGoogleDriveOAuthConfig(
    input: { clientId: string; clientSecret?: string; redirectUri?: string },
    actorId: string,
  ): Promise<GoogleOAuthResolved> {
    const existing = await this.getGoogleDriveOAuthConfig()
    const clientSecret = input.clientSecret?.trim() || existing?.config.clientSecret
    if (!clientSecret) {
      throw new Error('Client Secret szükséges az első beállításhoz.')
    }
    const redirectUri =
      input.redirectUri === undefined
        ? existing?.config.redirectUri
        : input.redirectUri.trim() || undefined
    const config: GoogleOAuthConfig = {
      clientId: input.clientId.trim(),
      clientSecret,
      ...(redirectUri ? { redirectUri } : {}),
    }
    await this.settings.set(
      GOOGLE_OAUTH_SERVICE_KEYS.drive,
      config as unknown as Prisma.InputJsonObject,
      actorId,
    )
    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'platform.oauth.google_drive.update',
      targetType: 'platform_setting',
      targetId: null,
      modelUsed: null,
      inputRef: 'google_drive',
      outputRef: config.clientId,
      policyDecision: existing?.source === 'platform' ? 'updated' : 'configured',
      metadata: {
        settingKey: GOOGLE_OAUTH_SERVICE_KEYS.drive,
        redirectUri: config.redirectUri ?? null,
        secretRotated: Boolean(input.clientSecret?.trim()),
        previousSource: existing?.source ?? null,
      },
    })
    return { config, source: 'platform' }
  }

  async upsertGoogleDrivePickerConfig(
    input: { apiKey: string; appId: string },
    actorId: string,
  ): Promise<{ config: GoogleDrivePickerConfig; source: GoogleOAuthResolved['source'] }> {
    const config: GoogleDrivePickerConfig = {
      apiKey: input.apiKey.trim(),
      appId: input.appId.trim(),
    }
    await this.settings.set(
      'oauth.google.drive.picker',
      config as unknown as Prisma.InputJsonObject,
      actorId,
    )
    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'platform.oauth.google_drive_picker.update',
      targetType: 'platform_setting',
      targetId: null,
      modelUsed: null,
      inputRef: 'google_drive_picker',
      outputRef: config.appId,
      policyDecision: 'configured',
      metadata: { settingKey: 'oauth.google.drive.picker', appId: config.appId },
    })
    return { config, source: 'platform' }
  }

  async upsertGoogleOAuthConfig(
    input: { clientId: string; clientSecret?: string; redirectUri?: string },
    actorId: string,
  ): Promise<GoogleOAuthResolved> {
    const existing = await this.getGoogleOAuthConfig()
    const clientSecret = input.clientSecret?.trim() || existing?.config.clientSecret
    if (!clientSecret) {
      throw new Error('Client Secret szükséges az első beállításhoz.')
    }
    const redirectUri =
      input.redirectUri === undefined
        ? existing?.config.redirectUri
        : input.redirectUri.trim() || undefined
    const config: GoogleOAuthConfig = {
      clientId: input.clientId.trim(),
      clientSecret,
      ...(redirectUri ? { redirectUri } : {}),
    }
    await this.settings.set(
      GOOGLE_OAUTH_PLATFORM_KEY,
      config as unknown as Prisma.InputJsonObject,
      actorId,
    )
    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'platform.oauth.google.update',
      targetType: 'platform_setting',
      targetId: null,
      modelUsed: null,
      inputRef: 'google',
      outputRef: config.clientId,
      policyDecision: existing?.source === 'platform' ? 'updated' : 'configured',
      metadata: {
        settingKey: GOOGLE_OAUTH_PLATFORM_KEY,
        redirectUri: config.redirectUri ?? null,
        secretRotated: Boolean(input.clientSecret?.trim()),
        previousSource: existing?.source ?? null,
      },
    })
    return { config, source: 'platform' }
  }
}
