'use server'

import { z } from 'zod'
import { getAuthContext } from '@/auth/context'
import { requireTenantRole } from '@/auth/tenant-context'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import { ensureActiveDatabaseMode } from '@/lib/db'
import { fail, ok } from '@/lib/result'
import {
  CHANNEL_DEFAULT_PROJECT_KEY,
  isValidProjectKey,
  type ChannelAgentGrantView,
} from '@/domain/channel/channel-types'

/**
 * Csatorna-agent-engedélyek, projektkötés és szervezeti kill-switch server-action réteg
 * (Telegram feature-spec #70/#75, D5/D9/D13/D54).
 *
 * - Az agent-engedélyt a tenant-admin adja/vonja vissza (kötött tagonként, agentenként).
 * - A projektkulcsot a felhasználó a weben állítja a SAJÁT engedélyén.
 * - A szervezeti kapcsolóval a tenant-admin azonnal elzárhatja a csatornát (fail-closed).
 *
 * Minden hibaüzenet hétköznapi magyar (NFR-1, D16): megmondja, mi történt és mi a teendő.
 */

const idSchema = z.string().uuid()
const grantSchema = z.object({ identityId: idSchema, agentId: idSchema })
const projectSchema = z.object({
  identityId: idSchema,
  agentId: idSchema,
  projectKey: z
    .string()
    .trim()
    .min(1, 'A projektkulcs nem lehet üres.')
    .refine(isValidProjectKey, 'A projektkulcs csak betűt, számot és a _ . : - jeleket tartalmazhat (szóköz nélkül).'),
})
const killSwitchSchema = z.object({ killSwitch: z.boolean() })

// ── Admin nézet és műveletek ─────────────────────────────────────────────────

export type TenantChannelIdentityAgents = {
  identityId: string
  userName: string
  userEmail: string
  agents: ChannelAgentGrantView[]
}

export type TenantChannelAgentsView = {
  killSwitch: boolean
  identities: TenantChannelIdentityAgents[]
  grantableAgents: Array<{ id: string; name: string }>
  defaultProjectKey: string
}

/**
 * Tenant-admin nézet: a szervezet kötött tagjai, tagonként a Telegramra engedélyezett agentek
 * (metszet-jelzéssel), az engedélyezhető agentek listája, és a szervezeti kapcsoló állapota.
 */
export async function listTenantChannelAgents(): Promise<TenantChannelAgentsView | null> {
  const ctx = await getAuthContext()
  if (!ctx || ctx.kind !== 'tenant' || ctx.activeTenantRole !== 'admin' || !ctx.activeTenantId) {
    return null
  }
  const tenantId = ctx.activeTenantId
  const [linkRows, controls, agents] = await Promise.all([
    repositories.channelIdentities.listByTenantWithUsers(tenantId),
    services.platformSettings.getTenantChannelControls(tenantId),
    repositories.agents.findMany({ tenantId }),
  ])

  const identities: TenantChannelIdentityAgents[] = []
  for (const row of linkRows) {
    const view = await services.channelAgentAccess.describeIdentityAgents(row.id)
    identities.push({
      identityId: row.id,
      userName: row.user.name,
      userEmail: row.user.email,
      agents: view.agents,
    })
  }

  return {
    killSwitch: controls.killSwitch,
    identities,
    grantableAgents: agents
      .filter((a) => a.status === 'active')
      .map((a) => ({ id: a.id, name: a.name })),
    defaultProjectKey: CHANNEL_DEFAULT_PROJECT_KEY,
  }
}

/** Admin-hibakód → hétköznapi magyar üzenet (NFR-1). */
function grantMessageFor(reason: string): string {
  switch (reason) {
    case 'identity_not_found':
      return 'Ez a Telegram-kötés már nem létezik. Frissítsd az oldalt.'
    case 'cross_tenant':
      return 'Ez a Telegram-kötés nem ehhez a szervezethez tartozik.'
    case 'identity_inactive':
      return 'Ez a kötés már nem aktív, ezért nem engedélyezhetsz hozzá agentet.'
    case 'agent_not_found':
      return 'Ez az agent nem található ebben a szervezetben.'
    case 'agent_not_usable':
      return 'Ez az agent jelenleg nem aktív a platformon, ezért nem tehető elérhetővé Telegramon.'
    case 'not_found':
      return 'Ehhez a taghoz ez az agent nincs engedélyezve Telegramra.'
    default:
      return 'A művelet nem sikerült.'
  }
}

/** Tenant-admin: egy tag számára engedélyez egy agentet Telegramra. */
export async function grantChannelAgent(input: unknown) {
  try {
    await ensureActiveDatabaseMode()
    const ctx = await requireTenantRole('admin')
    const parsed = grantSchema.parse(input)
    const res = await services.channelAgentAccess.grantAgent({
      identityId: parsed.identityId,
      agentId: parsed.agentId,
      actorUserId: ctx.user.id,
      actorTenantId: ctx.activeTenantId,
    })
    if (!res.ok) return fail(grantMessageFor(res.reason))
    return ok({ created: res.created })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült engedélyezni az agentet.')
  }
}

/** Tenant-admin: visszavonja egy tag Telegram-agent engedélyét — azonnal fail-closed. */
export async function revokeChannelAgent(input: unknown) {
  try {
    await ensureActiveDatabaseMode()
    const ctx = await requireTenantRole('admin')
    const parsed = grantSchema.parse(input)
    const res = await services.channelAgentAccess.revokeAgent({
      identityId: parsed.identityId,
      agentId: parsed.agentId,
      actorUserId: ctx.user.id,
      actorTenantId: ctx.activeTenantId,
    })
    if (!res.ok) return fail(grantMessageFor(res.reason))
    return ok({ ok: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült visszavonni az engedélyt.')
  }
}

/** Tenant-admin: a szervezeti Telegram-kapcsoló ki-/bekapcsolása (kill-switch, D54). */
export async function setTenantChannelKillSwitch(input: unknown) {
  try {
    await ensureActiveDatabaseMode()
    const ctx = await requireTenantRole('admin')
    const parsed = killSwitchSchema.parse(input)
    const next = await services.platformSettings.setTenantChannelControls(
      ctx.activeTenantId,
      { killSwitch: parsed.killSwitch },
      ctx.user.id,
    )
    return ok({ killSwitch: next.killSwitch })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült módosítani a szervezeti kapcsolót.')
  }
}

// ── Felhasználói nézet és projektkulcs ───────────────────────────────────────

export type MyChannelAgentsView = {
  linked: boolean
  channelEnabled: boolean
  identityId: string | null
  agents: ChannelAgentGrantView[]
}

/** A saját aktív Telegram-kötés agentjei (metszet-jelzéssel) + a szervezeti kapcsoló állapota. */
export async function listMyChannelAgents(): Promise<MyChannelAgentsView> {
  const ctx = await getAuthContext()
  const empty: MyChannelAgentsView = { linked: false, channelEnabled: false, identityId: null, agents: [] }
  if (!ctx || ctx.kind !== 'tenant' || !ctx.activeTenantId) return empty

  const identities = await repositories.channelIdentities.listByUser(ctx.user.id)
  const active = identities.find((i) => i.status === 'active' && i.tenantId === ctx.activeTenantId)
  if (!active) return empty

  const view = await services.channelAgentAccess.describeIdentityAgents(active.id)
  return { linked: true, channelEnabled: view.channelEnabled, identityId: active.id, agents: view.agents }
}

function projectMessageFor(reason: string): string {
  switch (reason) {
    case 'identity_not_found':
      return 'Ez a Telegram-kötés már nem létezik. Frissítsd az oldalt.'
    case 'not_owner':
      return 'Ez a Telegram-kötés nem a tiéd.'
    case 'invalid_project_key':
      return 'A projektkulcs csak betűt, számot és a _ . : - jeleket tartalmazhatja (szóköz nélkül).'
    case 'not_found':
      return 'Ehhez az agenthez nincs Telegram-engedélyed, ezért a projektet sem tudod beállítani.'
    case 'project_not_assignable':
      return 'Ez a projekt nem választható (nem létezik vagy archiválva van).'
    default:
      return 'A projekt beállítása nem sikerült.'
  }
}

/** A felhasználó beállítja a saját Telegram-agentjének projektkulcsát (D9/D33). */
export async function setMyChannelAgentProject(input: unknown) {
  try {
    await ensureActiveDatabaseMode()
    const ctx = await requireTenantRole('viewer')
    const parsed = projectSchema.parse(input)
    const res = await services.channelAgentAccess.setProjectKey({
      identityId: parsed.identityId,
      agentId: parsed.agentId,
      projectKey: parsed.projectKey,
      actorUserId: ctx.user.id,
      expectUserId: ctx.user.id,
    })
    if (!res.ok) return fail(res.message ?? projectMessageFor(res.reason))
    return ok({ projectKey: res.grant.projectKey })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült beállítani a projektet.')
  }
}
