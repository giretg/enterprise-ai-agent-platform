'use client'

import { CreateAgentWizard } from '@/components/agents/create-agent-wizard'
import type { ModelProviderOption } from '@/lib/model-providers'

/** Visszafelé kompatibilis belépő — az új agent űrlap a lépésenkénti varázsló. */
export function CreateAgentForm({
  providers,
}: {
  providers?: ModelProviderOption[]
}) {
  return <CreateAgentWizard providers={providers} profiles={[]} />
}
