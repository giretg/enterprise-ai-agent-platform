import { redirect } from 'next/navigation'
import { resolveDefaultAgentWorkspacePath } from '@/lib/default-agent-workspace'

/** Gyökér: tenant nélkül → onboarding / pending / platform; különben az Áttekintés (használatba-vételi lépésekkel). */
export default async function ControlPlaneRootPage() {
  redirect(await resolveDefaultAgentWorkspacePath())
}
