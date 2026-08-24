import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/auth'
import { resolveDefaultAgentWorkspacePath } from '@/lib/default-agent-workspace'

/** Gyökér: utoljára használt agent chat, vagy board ha nincs munkatárs. */
export default async function ControlPlaneRootPage() {
  const me = await getCurrentUser()
  if (me && (me.status !== 'active' || !me.role)) {
    redirect('/control-plane/pending')
  }
  redirect(await resolveDefaultAgentWorkspacePath())
}
