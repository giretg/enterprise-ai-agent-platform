import { notFound, redirect } from 'next/navigation'
import { getAuthContext } from '@/auth/context'
import { TenantAuthError, requireTenantRole } from '@/auth/tenant-context'
import {
  DEFAULT_AGENT_WORKSPACE_FALLBACK,
  homePathForAuthContext,
} from '@/lib/control-plane-entry'

export {
  CONTROL_PLANE_PENDING_PATH,
  CONTROL_PLANE_PLATFORM_HOME,
  DEFAULT_AGENT_WORKSPACE_FALLBACK,
  homePathForAuthContext,
} from '@/lib/control-plane-entry'

/**
 * Alapértelmezett belépési útvonal: van-e tenant-kontextus egyáltalán.
 * Aktív tenant-userre ez mindig a dashboard — az listázza a jóváhagyásokat
 * és a munkatársakat, nem kell itt agentet keresgélni.
 */
export async function resolveDefaultAgentWorkspacePath(): Promise<string> {
  const ctx = await getAuthContext()
  const fixed = homePathForAuthContext(ctx)
  if (fixed) return fixed
  return DEFAULT_AGENT_WORKSPACE_FALLBACK
}

/** Tenant-viewer kapu oldalakon: hiányzó kontextus → pending/platform, ne nyers hiba. */
export async function requireControlPlaneTenantViewer() {
  try {
    return await requireTenantRole('viewer')
  } catch (error) {
    if (error instanceof TenantAuthError) {
      if (error.code === 'NO_USER' || error.code === 'NO_TENANT') {
        redirect(await resolveDefaultAgentWorkspacePath())
      }
      notFound()
    }
    throw error
  }
}
