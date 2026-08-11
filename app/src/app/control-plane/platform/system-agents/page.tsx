import { getSystemAgentsPageData } from '@/app/actions/system-agents'
import { getAuthContext } from '@/auth/context'
import { UpdateModelConfigForm } from '@/components/agents/update-model-config-form'
import { Card } from '@/components/ui/shell'
import { enabledModelProviders } from '@/lib/model-policy'
import { PLAYBOOK_AUTHOR_AGENT_NAME, PROVISIONING_ASSISTANT_AGENT_NAME } from '@/lib/platform-agent-registry'
import type { ModelType } from '@/lib/model-providers'

function purposeFor(name: string): string {
  if (name === PLAYBOOK_AUTHOR_AGENT_NAME) {
    return 'Természetes nyelvű folyamatleírásból validálható Playbook-draftot készít; nem publikál és nem aktivál.'
  }
  if (name === PROVISIONING_ASSISTANT_AGENT_NAME) {
    return 'Tenant-provisioninghez és skill-előkészítéshez készít ellenőrizhető javaslatot; nem hajt végre önálló aktiválást.'
  }
  return 'Tenant nélküli, platform-szintű agent. Modellválasztása minden tenant futására hatással lehet.'
}

export default async function SystemAgentsPage() {
  const [result, ctx] = await Promise.all([getSystemAgentsPageData(), getAuthContext()])
  const isPlatform = Boolean(
    ctx && (ctx.platformRoles.includes('superadmin') || ctx.platformRoles.includes('platform_operator') || ctx.platformRoles.includes('platform_auditor')),
  )
  const canEdit = Boolean(ctx?.platformRoles.includes('superadmin'))

  if (!result.success || !isPlatform) {
    return (
      <div className="space-y-6">
        <header>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Platform</p>
          <h1 className="mt-2 font-display text-3xl font-semibold">Rendszer agentek</h1>
        </header>
        <div className="rounded-lg border border-coral/35 bg-coral/10 p-4 text-sm text-coral-deep">
          Ehhez a felülethez platform-szintű jogosultság szükséges.
          {!result.success && <span className="mt-1 block text-xs opacity-70">{result.error}</span>}
        </div>
      </div>
    )
  }

  const providers = enabledModelProviders(result.data.modelPolicy)

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Platform</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Rendszer agentek</h1>
        <p className="mt-1 max-w-3xl text-ink-soft">
          Ezek a tenant nélküli agentek központi, háttérben futó feladatokat végeznek. A modellváltás
          minden tenantban az új indításokra érvényes; a korábbi futások a korábbi agent-verzióhoz
          kötve auditálhatók maradnak.
        </p>
      </header>

      {!canEdit && (
        <div className="rounded-lg border border-honey/35 bg-honey/10 p-4 text-sm text-ink-soft">
          Megtekintési jogosultságod van. Modellbeállítást csak superadmin módosíthat.
        </div>
      )}

      {result.data.agents.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-soft">Nincs seedelt rendszeragent.</p>
        </Card>
      ) : (
        result.data.agents.map((agent) => {
          const config = agent.modelConfig as Record<string, unknown>
          const modelType = config.modelType
          return (
            <section key={agent.id} className="space-y-4">
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-display text-xl font-semibold text-ink">{agent.name}</h2>
                    <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-soft">{purposeFor(agent.name)}</p>
                  </div>
                  <span className="rounded-full border border-line bg-night/40 px-3 py-1 text-xs text-ink-soft">
                    Agent v{agent.currentVersion}
                  </span>
                </div>
              </Card>
              {canEdit ? (
                <UpdateModelConfigForm
                  agentId={agent.id}
                  providers={providers}
                  scope="system"
                  mode="model-only"
                  current={{
                    provider: String(config.provider ?? 'chatgpt-oauth'),
                    model: String(config.model ?? ''),
                    modelType:
                      modelType === 'luna' || modelType === 'terra' || modelType === 'sol'
                        ? (modelType as ModelType)
                        : undefined,
                    temperature: typeof config.temperature === 'number' ? config.temperature : undefined,
                    maxTokens: typeof config.maxTokens === 'number' ? config.maxTokens : undefined,
                    fallbackModels: Array.isArray(config.fallbackModels)
                      ? (config.fallbackModels as Array<{ provider: string; model: string }>).filter(
                          (row) => row && typeof row.provider === 'string' && typeof row.model === 'string',
                        )
                      : [],
                  }}
                />
              ) : (
                <Card title="Gondolkodási motor beállítása">
                  <p className="text-sm text-ink-soft">
                    {String(config.provider ?? 'chatgpt-oauth')} / {String(config.model ?? 'nincs beállítva')}
                  </p>
                </Card>
              )}
            </section>
          )
        })
      )}
    </div>
  )
}
