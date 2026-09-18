import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/auth'

export default async function ControlPlaneRootPage() {
  const me = await getCurrentUser()
  if (me && (me.status !== 'active' || !me.role)) {
    redirect('/control-plane/pending')
  }
  redirect('/control-plane/agents')
}
