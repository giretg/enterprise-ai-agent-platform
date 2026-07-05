/**
 * Playbook roles[] ↔ step assignedRole szinkron (Feature-spec — Playbook §5.2).
 */
import type { PlaybookRole } from '@/lib/playbook-v2/spec'

export type PlaybookRoleType = PlaybookRole['type']

export const PLAYBOOK_ROLE_TYPE_OPTIONS: Array<{ value: PlaybookRoleType; label: string }> = [
  { value: 'agent_role', label: 'Agent (agent_role)' },
  { value: 'human_role', label: 'Ember (human_role)' },
]

export function getRoleType(
  roles: PlaybookRole[] | undefined,
  roleKey: string | undefined,
): PlaybookRoleType {
  if (!roleKey) return 'agent_role'
  return (roles ?? []).find((r) => r.key === roleKey)?.type ?? 'agent_role'
}

/** A roles tömbben frissíti (vagy létrehozza) a megadott kulcsú szerep típusát és capability-listáját. */
export function upsertRoleType(
  roles: PlaybookRole[] | undefined,
  roleKey: string,
  type: PlaybookRoleType,
  requiredCapabilities?: string[],
): PlaybookRole[] {
  const list = [...(roles ?? [])]
  const idx = list.findIndex((r) => r.key === roleKey)
  const caps = requiredCapabilities && requiredCapabilities.length > 0 ? requiredCapabilities : undefined
  if (idx >= 0) {
    const next = { ...list[idx], type }
    if (caps) next.requiredCapabilities = caps
    else delete next.requiredCapabilities
    list[idx] = next
  } else {
    list.push(caps ? { key: roleKey, type, requiredCapabilities: caps } : { key: roleKey, type })
  }
  return list
}

export function getRoleCapabilities(
  roles: PlaybookRole[] | undefined,
  roleKey: string | undefined,
): string[] {
  if (!roleKey) return []
  return (roles ?? []).find((r) => r.key === roleKey)?.requiredCapabilities ?? []
}
