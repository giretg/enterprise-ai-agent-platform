import { redirect } from 'next/navigation'

export default async function DashboardLegacyRedirect() {
  redirect('/control-plane/agents')
}
