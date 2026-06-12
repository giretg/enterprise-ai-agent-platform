import Link from 'next/link'
import { CreateAgentForm } from '@/components/agents/create-agent-form'

export default function NewAgentPage() {
  return (
    <div className="space-y-6">
      <div>
        <Link href="/control-plane/agents" className="text-sm text-ink-faint hover:text-ink">
          ← Agent Registry
        </Link>
        <h1 className="mt-2 font-display text-3xl font-semibold">Új agent</h1>
        <p className="mt-1 text-ink-soft">Admin wizard — memória, verzió és scoped API-kulcs automatikusan</p>
      </div>

      <div className="max-w-2xl">
        <CreateAgentForm />
      </div>
    </div>
  )
}
