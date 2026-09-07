/**
 * Skill-fajta: tenant | published | system.
 *
 * A `catalogScope` a tenant-határ (global olvasható minden tenantnak, tenant
 * csak a sajátnak). A fajta azt mondja meg, *milyen* katalógus-elem a skill,
 * és melyik agent-osztályhoz rendelhető. Nem RBAC-létra: a hozzárendelés
 * továbbra is admin-aktus, a slash pedig a már hozzárendelt skilleket mutatja.
 */

export const SKILL_KINDS = ['tenant', 'published', 'system'] as const
export type SkillKind = (typeof SKILL_KINDS)[number]

export const SKILL_SYSTEM_ROLES = ['run_analyst', 'web_egress'] as const
export type SkillSystemRole = (typeof SKILL_SYSTEM_ROLES)[number]

export const SKILL_KIND_COPY: Record<
  SkillKind,
  { label: string; explanation: string }
> = {
  tenant: {
    label: 'Tenant',
    explanation:
      'Csak ebben a tenantban létezik. A tenant admin a saját (nem rendszer-) agentjeihez rendelheti. A slashben azoknál az agenteknél jelenik meg, amelyekhez hozzá van rendelve.',
  },
  published: {
    label: 'Kiadott',
    explanation:
      'Platform-admin által kiadott csomag: minden tenant olvashatja, de nem szerkesztheti. A tenant admin a saját (nem rendszer-) agentjeihez rendelheti.',
  },
  system: {
    label: 'Rendszer',
    explanation:
      'Platform belső skill. Csak a kiválasztott rendszer-agenten jelenik meg, és csak oda rendelhető. Más agentre a tenant admin nem teheti.',
  },
}

export const SKILL_SYSTEM_ROLE_LABEL: Record<SkillSystemRole, string> = {
  run_analyst: 'Futás-elemző',
  web_egress: 'Web-Egress',
}

export const SKILL_KIND_BADGE_TONE: Record<SkillKind, 'neutral' | 'success' | 'warning'> = {
  tenant: 'neutral',
  published: 'success',
  system: 'warning',
}

export function isSkillKind(value: unknown): value is SkillKind {
  return typeof value === 'string' && (SKILL_KINDS as readonly string[]).includes(value)
}

/**
 * UI badge-ekhez: érvényes kind, vagy catalogScope alapján legjobb tipp.
 * ponytail: HMR / régi RSC-payload ablak — ha a szerver már küld kind-et, ez csak guard.
 */
export function resolveSkillKind(
  kind: unknown,
  catalogScope: 'global' | 'tenant' = 'tenant',
): SkillKind {
  if (isSkillKind(kind)) return kind
  return catalogScope === 'global' ? 'published' : 'tenant'
}

export function isSkillSystemRole(value: unknown): value is SkillSystemRole {
  return typeof value === 'string' && (SKILL_SYSTEM_ROLES as readonly string[]).includes(value)
}

/** Tenant-fajta → tenant-hatókör; kiadott és rendszer → platform-globális. */
export function catalogScopeForKind(kind: SkillKind): 'global' | 'tenant' {
  return kind === 'tenant' ? 'tenant' : 'global'
}

export function skillKindInputError(
  kind: SkillKind,
  requiredSystemRole: string | null | undefined,
): string | null {
  if (kind === 'system') {
    if (!isSkillSystemRole(requiredSystemRole)) {
      return 'Rendszer-skillhez ki kell választani, melyik rendszer-agenthez tartozik.'
    }
    return null
  }
  if (requiredSystemRole) {
    return 'Csak rendszer-skillhez adható meg rendszer-agent.'
  }
  return null
}

export function skillKindCreateAuthError(
  kind: SkillKind,
  isPlatformAdmin: boolean,
): string | null {
  if (kind !== 'tenant' && !isPlatformAdmin) {
    return 'Kiadott vagy rendszer-skillt csak platform-admin hozhat létre.'
  }
  return null
}

export function skillKindChangeError(
  current: { kind: SkillKind; catalogScope: 'global' | 'tenant' },
  nextKind: SkillKind,
  isPlatformAdmin: boolean,
): string | null {
  if (current.catalogScope === 'tenant') {
    if (nextKind !== 'tenant') {
      return 'Tenant-skill fajtája nem változtatható kiadottra vagy rendszerre — az a tenant-határt törné.'
    }
    return null
  }
  if (!isPlatformAdmin) {
    return 'A kiadott vagy rendszer fajtát csak platform-admin állíthatja.'
  }
  if (nextKind === 'tenant') {
    return 'Globális skill nem minősíthető tenant-skillé.'
  }
  return null
}

export function normalizeRequiredSystemRole(
  kind: SkillKind,
  requiredSystemRole: string | null | undefined,
): SkillSystemRole | null {
  if (kind !== 'system') return null
  return isSkillSystemRole(requiredSystemRole) ? requiredSystemRole : null
}

/**
 * Fail-closed hozzárendelési szabály:
 *   - rendszer-skill → csak a megadott systemRole-ú agent
 *   - kiadott / tenant → csak sima (systemRole nélküli) agent
 */
export function isSkillAssignableToAgent(
  skill: { kind: SkillKind; requiredSystemRole: string | null },
  agent: { systemRole: string | null },
): boolean {
  if (skill.kind === 'system') {
    if (!skill.requiredSystemRole) return agent.systemRole !== null
    return agent.systemRole === skill.requiredSystemRole
  }
  return agent.systemRole === null
}

export function skillAssignDeniedMessage(
  skill: { kind: SkillKind; requiredSystemRole: string | null },
  agent: { systemRole: string | null },
): string {
  if (skill.kind === 'system') {
    const target = isSkillSystemRole(skill.requiredSystemRole)
      ? SKILL_SYSTEM_ROLE_LABEL[skill.requiredSystemRole]
      : 'a hozzá tartozó rendszer-agent'
    return `Ez a rendszer-skill csak a(z) ${target} agenthez rendelhető.`
  }
  if (agent.systemRole !== null) {
    return 'Kiadott és tenant skill csak sima (nem rendszer-) agenthez rendelhető.'
  }
  return 'Ez a skill ehhez az agenthez nem rendelhető.'
}
