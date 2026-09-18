import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/auth'
import { resolveDefaultAgentWorkspacePath } from '@/lib/default-agent-workspace'

/** Gyökér: tenant-home / első munkatárs / pending — soha ne önmagára. */
export default async function ControlPlaneRootPage() {
  const me = await getCurrentUser()
  if (me && (me.status !== 'active' || !me.role)) {
    redirect('/control-plane/pending')
  }
  redirect(await resolveDefaultAgentWorkspacePath())
}
