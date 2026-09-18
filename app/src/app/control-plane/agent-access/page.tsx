import { requireTenantRole } from '@/auth/tenant-context'

export default async function AgentAccessPage() {
  await requireTenantRole('admin')
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Kapcsolatok</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Ki kivel dolgozhat</h1>
        <p className="mt-1 max-w-3xl text-ink-soft">
          A view/operate grant a ResourceGrant modellre költözik (Phase B). A chat-gráf
          szerkesztő kikerült.
        </p>
      </div>
    </div>
  )
}
