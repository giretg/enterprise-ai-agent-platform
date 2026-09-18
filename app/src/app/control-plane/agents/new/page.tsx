import { requireTenantRole } from '@/auth/tenant-context'
import { CreateAgentForm } from '@/components/agents/create-agent-form'

export default async function NewAgentPage() {
  await requireTenantRole('admin')
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Új agent</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Munkatárs létrehozása</h1>
      </div>
      <CreateAgentForm />
    </div>
  )
}
