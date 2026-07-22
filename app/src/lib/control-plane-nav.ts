import type { PlatformRole, UserRole } from '@prisma/client'
import { hasMinimumRole } from '@/lib/iam-policy'
import { hasMinimumPlatformRole } from '@/lib/tenant-policy'

export type ControlPlaneNavLeaf = { href: string; label: string; exact?: boolean }
export type ControlPlaneNavGroup = { label: string; children: ControlPlaneNavLeaf[] }
export type ControlPlaneNavEntry = ControlPlaneNavLeaf | ControlPlaneNavGroup

export type ControlPlaneNavContext = {
  tenantRole: UserRole | null
  platformRoles: PlatformRole[]
}

const isGroup = (entry: ControlPlaneNavEntry): entry is ControlPlaneNavGroup => 'children' in entry

/**
 * Control Plane főnavigáció role-szűréssel.
 *
 * Operátor = normál felhasználó (ticket/chat/agent-futás). Az Adminisztráció
 * alatt csak azt kapja, ami a napi munkához kell (saját fiókkötés); a többi
 * admin / approver / platform szerepre megy.
 */
export function buildControlPlaneNav(ctx: ControlPlaneNavContext): ControlPlaneNavEntry[] {
  const canTenantAdmin = hasMinimumRole(ctx.tenantRole, 'admin')
  const canApprover = hasMinimumRole(ctx.tenantRole, 'approver')
  const canViewer = hasMinimumRole(ctx.tenantRole, 'viewer')
  const hasPlatformAccess = hasMinimumPlatformRole(ctx.platformRoles, 'platform_auditor')

  const adminChildren: ControlPlaneNavLeaf[] = []

  // Saját OAuth / connector grant — operator+ (viewer is láthatja a saját fiókjait).
  if (canViewer) {
    adminChildren.push({ href: '/control-plane/account', label: 'Fiókom' })
    adminChildren.push({ href: '/control-plane/connectors', label: 'Fiókok' })
  }
  if (canTenantAdmin) {
    adminChildren.push({ href: '/control-plane/provisioning', label: 'Provisioning' })
    adminChildren.push({ href: '/control-plane/iam', label: 'IAM' })
  }
  if (hasPlatformAccess) {
    adminChildren.push({ href: '/control-plane/platform/tenants', label: 'Platform · Tenantok' })
    adminChildren.push({ href: '/control-plane/platform/iam', label: 'Platform · IAM' })
    adminChildren.push({ href: '/control-plane/platform/settings', label: 'Platform · Beállítások' })
  }
  if (canTenantAdmin) {
    adminChildren.push({ href: '/control-plane/governance', label: 'Governance' })
    adminChildren.push({ href: '/control-plane/system', label: 'Rendszer' })
  }
  if (canApprover) {
    adminChildren.push({ href: '/control-plane/audit', label: 'Audit' })
  }

  const nav: ControlPlaneNavEntry[] = [
    { href: '/control-plane', label: 'Dashboard', exact: true },
    { href: '/control-plane/board', label: 'Board' },
    {
      label: 'Munkatársak',
      children: [
        { href: '/control-plane/agents', label: 'Munkatársak' },
        { href: '/control-plane/behavior-profiles', label: 'Viselkedés-profilok' },
        { href: '/control-plane/skills', label: 'Skill-katalógus' },
        { href: '/control-plane/apps', label: 'Mini-appok' },
        { href: '/control-plane/sandbox-versions', label: 'Sandbox verziók' },
      ],
    },
    {
      label: 'Automatizálás',
      children: [
        { href: '/control-plane/playbooks', label: 'Playbookok' },
        { href: '/control-plane/step-templates', label: 'Lépés-sablonok' },
        { href: '/control-plane/processes', label: 'Folyamatok' },
      ],
    },
    {
      label: 'Üzemeltetés',
      children: [
        { href: '/control-plane/scheduled-tasks', label: 'Ütemezés' },
        { href: '/control-plane/monitors', label: 'Monitorok' },
        { href: '/control-plane/training', label: 'Tanítás' },
      ],
    },
  ]

  if (adminChildren.length > 0) {
    nav.push({ label: 'Adminisztráció', children: adminChildren })
  }

  return nav
}

export function flattenNavHrefs(nav: ControlPlaneNavEntry[]): string[] {
  return nav.flatMap((entry) =>
    isGroup(entry) ? entry.children.map((child) => child.href) : [entry.href],
  )
}
