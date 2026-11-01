import { cookies } from 'next/headers'
import { ACTIVE_TENANT_COOKIE } from './context'

const ACTIVE_TENANT_COOKIE_MAX_AGE = 60 * 60 * 24 * 30 // 30 nap

/** Az aktív tenant kiválasztása a session-sütiben (tenant-váltás, új saját cég). */
export async function setActiveTenantCookie(tenantId: string) {
  const store = await cookies()
  store.set(ACTIVE_TENANT_COOKIE, tenantId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ACTIVE_TENANT_COOKIE_MAX_AGE,
  })
}
