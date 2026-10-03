/**
 * Hermes Managed Client — heartbeat-regiszter és Managed/Open döntés (#746 V1-7, R8, D14/D15).
 *
 * Managed = az `installId`-hoz (a gateway-JWT-ből) friss heartbeat tartozik ÉS a kérés
 * `X-Excellence-Session` sessionjét a Guard ugyanehhez az installhoz és agenthez regisztrálta.
 * Minden más Open → nincs céges modell. Szerveroldali döntés, mert a Hermes provider-headerei
 * statikusak (nem tudnak dinamikus `X-Excellence-Client` tokent küldeni) — a kliens nem hazudhatja
 * Managednek magát: az installId a JWT-ből jön, a sessiont csak a heartbeat regisztrálja.
 */
import { z } from 'zod'
import type { AuditSink } from '@/lib/audit/types'
import { writeAudit } from '@/lib/audit/types'
import type { GatewayPipelineHooks } from '@/domain/model-gateway/proxy'

export const HEARTBEAT_INTERVAL_SECONDS = 60
export const HEARTBEAT_FRESHNESS_SECONDS = 180
const MAX_SESSIONS_PER_HEARTBEAT = 50
/** Ennél régebbi session-sorokat a heartbeat törli, hogy a tábla ne nőjön korlátlanul. */
const SESSION_RETENTION_MS = 24 * 3600_000

export type ClientPolicyTiming = { intervalSeconds: number; freshnessSeconds: number }

/** A frissességi ablak nem lehet rövidebb két heartbeat-intervallumnál, különben a Managed villogna. */
export function clientPolicyTimingFromEnv(env: Record<string, string | undefined> = process.env): ClientPolicyTiming {
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
  }
  const intervalSeconds = num(env.CLIENT_POLICY_HEARTBEAT_INTERVAL_SECONDS, HEARTBEAT_INTERVAL_SECONDS)
  const freshnessSeconds = Math.max(num(env.CLIENT_POLICY_FRESHNESS_SECONDS, HEARTBEAT_FRESHNESS_SECONDS), intervalSeconds * 2)
  return { intervalSeconds, freshnessSeconds }
}

const text = z.string().trim().min(1).max(200)
/** A `tenantId`/`userId`/`installId`/`agentId` a tokenből jön — a törzs csak a gép állapotát hordozza. */
export const heartbeatBodySchema = z.object({
  configHash: text,
  managedDirHash: text,
  policyVersion: text,
  guardVersion: text,
  hermesVersion: text,
  /** A Guard által éppen futtatott Hermes-sessionök (a token agentjéhez regisztrálódnak). */
  sessions: z.array(text).max(MAX_SESSIONS_PER_HEARTBEAT).default([]),
})
export type HeartbeatBody = z.infer<typeof heartbeatBodySchema>

export type ClientInstallKey = { tenantId: string; userId: string; installId: string }

export interface ClientInstallStore {
  /** Egy tranzakcióban: install upsert, a bejelentett sessionök lastSeenAt-je, régi sessionök törlése. */
  recordHeartbeat(
    input: ClientInstallKey & HeartbeatBody & { agentId: string; now: Date; sessionsOlderThan: Date },
  ): Promise<{ previousHeartbeatAt: Date | null }>
  /** null = ehhez a (tenant, user, installId)-hoz nincs heartbeat. */
  findInstall(
    input: ClientInstallKey & { agentId: string; sessionId: string | null },
  ): Promise<{ lastHeartbeatAt: Date; sessionLastSeenAt: Date | null; managedDirHash: string } | null>
}

export type DeviationKind =
  | 'no_heartbeat'
  | 'stale_heartbeat'
  | 'session_unregistered'
  | 'session_stale'
  | 'heartbeat_gap'
  | 'managed_dir_hash_mismatch'
  | 'managed_dir_unissued'

/** R8 eltérés-jel; v1-ben a riasztási csatorna maga az audit-esemény. */
async function recordDeviation(
  audit: AuditSink | undefined,
  d: ClientInstallKey & { agentId: string; kind: DeviationKind; detail?: Record<string, unknown> },
): Promise<void> {
  await writeAudit(audit, {
    actorType: 'human',
    actorId: d.userId,
    action: 'client_policy.deviation',
    targetType: 'client_install',
    targetId: d.agentId,
    policyDecision: 'flagged',
    metadata: { kind: d.kind, installId: d.installId, ...d.detail },
    tenantId: d.tenantId,
  })
}

export type ClientPolicyDeps = {
  store: ClientInstallStore
  audit?: AuditSink
  timing?: ClientPolicyTiming
  /** A V1-8 által ehhez az installhoz mentett `/etc/hermes` hash. null → az env-tartalék. */
  lookupExpectedManagedDirHash?: (input: ClientInstallKey) => Promise<string | null>
  /** Env-tartalék, ha az installhoz nincs mentett hash. */
  expectedManagedDirHash?: string
  now?: () => Date
}

export async function recordHeartbeat(
  deps: ClientPolicyDeps,
  input: ClientInstallKey & { agentId: string; body: HeartbeatBody },
): Promise<ClientPolicyTiming> {
  const timing = deps.timing ?? clientPolicyTimingFromEnv()
  const now = (deps.now ?? (() => new Date()))()
  const { previousHeartbeatAt } = await deps.store.recordHeartbeat({
    tenantId: input.tenantId,
    userId: input.userId,
    installId: input.installId,
    agentId: input.agentId,
    ...input.body,
    now,
    sessionsOlderThan: new Date(now.getTime() - SESSION_RETENTION_MS),
  })
  const signal = (kind: DeviationKind, detail?: Record<string, unknown>) =>
    recordDeviation(deps.audit, { ...input, kind, detail })
  // Elmaradt heartbeat: lusta észlelés — a kiesés a következő sikeres heartbeatnél derül ki.
  // ponytail: nincs háttér-söprő; ha a riasztás nem várhat a kliens visszatértéig, ütemezett ellenőrzés kell.
  if (previousHeartbeatAt && now.getTime() - previousHeartbeatAt.getTime() > timing.freshnessSeconds * 1000) {
    await signal('heartbeat_gap', { gapSeconds: Math.round((now.getTime() - previousHeartbeatAt.getTime()) / 1000) })
  }
  const fromInstall = deps.lookupExpectedManagedDirHash
    ? await deps.lookupExpectedManagedDirHash({ tenantId: input.tenantId, userId: input.userId, installId: input.installId })
    : null
  const expected = fromInstall || deps.expectedManagedDirHash
  if (expected && input.body.managedDirHash !== expected) {
    await signal('managed_dir_hash_mismatch', { reported: input.body.managedDirHash })
  }
  return timing
}

export const CLIENT_OPEN_MESSAGE =
  'A Hermes most nem céges módban fut, ezért az Excellence modellek nem érhetők el. Indítsd újra normál módban, vagy szólj a rendszergazdának.'

export type ClientMode = { mode: 'managed' } | { mode: 'open'; why: DeviationKind }

export async function resolveClientMode(
  deps: ClientPolicyDeps,
  input: ClientInstallKey & { agentId: string; sessionId: string | null },
): Promise<ClientMode> {
  const timing = deps.timing ?? clientPolicyTimingFromEnv()
  const cutoff = (deps.now ?? (() => new Date()))().getTime() - timing.freshnessSeconds * 1000
  const found = await deps.store.findInstall(input)
  if (!found) return { mode: 'open', why: 'no_heartbeat' }
  if (found.lastHeartbeatAt.getTime() < cutoff) return { mode: 'open', why: 'stale_heartbeat' }
  const fromInstall = deps.lookupExpectedManagedDirHash ? await deps.lookupExpectedManagedDirHash(input) : null
  const expected = fromInstall || deps.expectedManagedDirHash
  if (!expected) return { mode: 'open', why: 'managed_dir_unissued' }
  if (found.managedDirHash !== expected) return { mode: 'open', why: 'managed_dir_hash_mismatch' }
  if (!input.sessionId || !found.sessionLastSeenAt) return { mode: 'open', why: 'session_unregistered' }
  if (found.sessionLastSeenAt.getTime() < cutoff) return { mode: 'open', why: 'session_stale' }
  return { mode: 'managed' }
}

/** A Model Gateway `hooks.gate`-je: Open → szintetikus üzenet (D15) + eltérés-jel az auditban. */
export function createManagedGate(deps: ClientPolicyDeps): NonNullable<GatewayPipelineHooks['gate']> {
  return async (ctx) => {
    const key = { tenantId: ctx.tenantId, userId: ctx.userId, installId: ctx.installId, agentId: ctx.agentId }
    const decision = await resolveClientMode(deps, { ...key, sessionId: ctx.sessionId })
    if (decision.mode === 'managed') return null
    await recordDeviation(deps.audit, { ...key, kind: decision.why, detail: { sessionId: ctx.sessionId } })
    return { block: CLIENT_OPEN_MESSAGE, reason: `client_open:${decision.why}` }
  }
}
