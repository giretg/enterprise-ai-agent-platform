import type { PlatformRole, UserRole } from '@prisma/client'
import { hasMinimumRole } from '@/lib/iam-policy'
import { hasMinimumPlatformRole } from '@/lib/tenant-policy'
import {
  emptyNavVisibilityPolicy,
  isNavKeyHiddenFor,
  type NavVisibilityPolicy,
} from '@/lib/nav-visibility'

export type ControlPlaneNavLeaf = { key: string; href: string; label: string; exact?: boolean }
export type ControlPlaneNavGroup = { key: string; label: string; children: ControlPlaneNavLeaf[] }
export type ControlPlaneNavEntry = ControlPlaneNavLeaf | ControlPlaneNavGroup

/**
 * Egy menüpont MINIMUM-követelménye. A két dimenzió független: `tenantRole` a
 * tenanton belüli rangsor, `platformRole` a platform-szintű szerep. Követelmény
 * nélküli menüpontot minden bejelentkezett felhasználó lát.
 */
export type ControlPlaneNavRequirement = {
  tenantRole?: UserRole
  platformRole?: PlatformRole
}

export type ControlPlaneNavCatalogLeaf = ControlPlaneNavLeaf & {
  requires?: ControlPlaneNavRequirement
}
export type ControlPlaneNavCatalogGroup = {
  key: string
  label: string
  children: ControlPlaneNavCatalogLeaf[]
}
export type ControlPlaneNavCatalogEntry = ControlPlaneNavCatalogLeaf | ControlPlaneNavCatalogGroup

export type ControlPlaneNavContext = {
  tenantRole: UserRole | null
  platformRoles: PlatformRole[]
  /** Szerepkörönkénti menü-elrejtés (`tenants.settings.navVisibility`). */
  navVisibility?: NavVisibilityPolicy
}

const isCatalogGroup = (
  entry: ControlPlaneNavCatalogEntry,
): entry is ControlPlaneNavCatalogGroup => 'children' in entry

const isGroup = (entry: ControlPlaneNavEntry): entry is ControlPlaneNavGroup => 'children' in entry

/**
 * A Control Plane fejléc-navigáció TELJES katalógusa — az igazság egyetlen forrása.
 *
 * A `key` a menü-láthatósági policy stabil azonosítója: a `href` és a `label`
 * változhat (útvonal-átnevezés, szövegezés), a kulcs NEM — különben egy átnevezés
 * csendben feloldaná a tenant beállított tiltásait.
 *
 * Operátor = normál felhasználó (ticket/chat/agent-futás). Az Adminisztráció alatt
 * csak azt kapja, ami a napi munkához kell (saját fiókkötés); a többi admin /
 * approver / platform szerepre megy.
 */
export const CONTROL_PLANE_NAV_CATALOG: readonly ControlPlaneNavCatalogEntry[] = [
  { key: 'board', href: '/control-plane/board', label: 'Board' },
  {
    key: 'staff',
    label: 'Munkatársak',
    children: [
      // A névsor a bal sávban él; a tanítás az agent fejlécre került.
      {
        key: 'staff.behavior-profiles',
        href: '/control-plane/behavior-profiles',
        label: 'Viselkedés-profilok',
      },
      { key: 'staff.skills', href: '/control-plane/skills', label: 'Skill-katalógus' },
      { key: 'staff.apps', href: '/control-plane/apps', label: 'Mini-appok' },
      {
        key: 'staff.sandbox-versions',
        href: '/control-plane/sandbox-versions',
        label: 'Sandbox verziók',
      },
    ],
  },
  {
    key: 'automation',
    label: 'Automatizálás',
    children: [
      { key: 'automation.playbooks', href: '/control-plane/playbooks', label: 'Playbookok' },
      {
        key: 'automation.step-templates',
        href: '/control-plane/step-templates',
        label: 'Lépés-sablonok',
      },
      { key: 'automation.processes', href: '/control-plane/processes', label: 'Folyamatok' },
      { key: 'automation.monitors', href: '/control-plane/monitors', label: 'Monitorok' },
    ],
  },
  {
    key: 'admin',
    label: 'Adminisztráció',
    children: [
      // Saját OAuth / connector grant — viewer is láthatja a saját fiókjait.
      { key: 'admin.account', href: '/control-plane/account', label: 'Fiókom', requires: { tenantRole: 'viewer' } },
      { key: 'admin.connectors', href: '/control-plane/connectors', label: 'Fiókok', requires: { tenantRole: 'viewer' } },
      {
        key: 'admin.provisioning',
        href: '/control-plane/provisioning',
        label: 'Provisioning',
        requires: { tenantRole: 'admin' },
      },
      { key: 'admin.iam', href: '/control-plane/iam', label: 'IAM', requires: { tenantRole: 'admin' } },
      // #142 — korábban staff.access; a sáv az alaphelyzet, a gráf-szerkesztő admin alatt marad.
      {
        key: 'admin.agent-access',
        href: '/control-plane/agent-access',
        label: 'Kapcsolatok',
        requires: { tenantRole: 'admin' },
      },
      {
        key: 'admin.menu-access',
        href: '/control-plane/menu-access',
        label: 'Menü-hozzáférés',
        requires: { tenantRole: 'admin' },
      },
      {
        key: 'admin.platform-tenants',
        href: '/control-plane/platform/tenants',
        label: 'Platform · Tenantok',
        requires: { platformRole: 'platform_auditor' },
      },
      {
        key: 'admin.platform-iam',
        href: '/control-plane/platform/iam',
        label: 'Platform · IAM',
        requires: { platformRole: 'platform_auditor' },
      },
      {
        key: 'admin.platform-settings',
        href: '/control-plane/platform/settings',
        label: 'Platform · Beállítások',
        requires: { platformRole: 'platform_auditor' },
      },
      {
        key: 'admin.governance',
        href: '/control-plane/governance',
        label: 'Governance',
        requires: { tenantRole: 'admin' },
      },
      { key: 'admin.system', href: '/control-plane/system', label: 'Rendszer', requires: { tenantRole: 'admin' } },
      {
        key: 'admin.audit',
        href: '/control-plane/audit',
        label: 'Audit',
        requires: { tenantRole: 'approver' },
      },
    ],
  },
]

function meetsRequirement(
  ctx: ControlPlaneNavContext,
  requires: ControlPlaneNavRequirement | undefined,
): boolean {
  if (!requires) return true
  if (requires.tenantRole && !hasMinimumRole(ctx.tenantRole, requires.tenantRole)) return false
  if (requires.platformRole && !hasMinimumPlatformRole(ctx.platformRoles, requires.platformRole)) {
    return false
  }
  return true
}

function toLeaf(entry: ControlPlaneNavCatalogLeaf): ControlPlaneNavLeaf {
  const leaf: ControlPlaneNavLeaf = { key: entry.key, href: entry.href, label: entry.label }
  if (entry.exact) leaf.exact = true
  return leaf
}

/**
 * Control Plane főnavigáció: előbb a szerep-követelmény (jogosultsági kapu), utána a
 * tenant menü-láthatósági policy (kurálás). A sorrend szándékos — a policy csak
 * SZŰKÍTHET, sosem tud olyan menüpontot megjeleníteni, amihez nincs szerep.
 *
 * Az üresre szűkült csoport eltűnik: nem hagyunk a fejlécben olyan legördülőt,
 * ami semmit nem nyit ki.
 */
export function buildControlPlaneNav(ctx: ControlPlaneNavContext): ControlPlaneNavEntry[] {
  const policy = ctx.navVisibility ?? emptyNavVisibilityPolicy()
  const visible = (key: string) => !isNavKeyHiddenFor(policy, ctx.tenantRole, key)

  const nav: ControlPlaneNavEntry[] = []
  for (const entry of CONTROL_PLANE_NAV_CATALOG) {
    if (!visible(entry.key)) continue
    if (!isCatalogGroup(entry)) {
      if (meetsRequirement(ctx, entry.requires)) nav.push(toLeaf(entry))
      continue
    }
    const children = entry.children
      .filter((child) => meetsRequirement(ctx, child.requires) && visible(child.key))
      .map(toLeaf)
    if (children.length > 0) nav.push({ key: entry.key, label: entry.label, children })
  }
  return nav
}

export function flattenNavHrefs(nav: ControlPlaneNavEntry[]): string[] {
  return nav.flatMap((entry) =>
    isGroup(entry) ? entry.children.map((child) => child.href) : [entry.href],
  )
}

/** Minden katalógus-kulcs (csoportok + levelek) — a policy-validáció ehhez méri az inputot. */
export function allNavKeys(): string[] {
  return CONTROL_PLANE_NAV_CATALOG.flatMap((entry) =>
    isCatalogGroup(entry) ? [entry.key, ...entry.children.map((child) => child.key)] : [entry.key],
  )
}
