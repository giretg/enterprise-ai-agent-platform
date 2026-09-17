import { notFound } from 'next/navigation'
import { getAuthContext } from '@/auth/context'
import { listAgents } from '@/app/actions/platform'
import { repositories } from '@/repositories/postgres'
import { findEmbedApp, readEmbedApps } from '@/lib/embed-apps'
import { MAX_LIST_LIMIT } from '@/lib/list-pagination'
import { EmbedSignInPrompt } from './[agentId]/embed-sign-in-prompt'
import { EmbedAgentPickerCards } from './embed-agent-picker-cards'

/**
 * Beágyazott agent-chat — agent-választó idegen alkalmazásból (feature-spec #481,
 * D9-kiegészítés). A külső appnak nem kell ismernie az agent-azonosítókat: a
 * `window.open`-nel nyitott `/embed/agents?app=<slug>&thread=<id>` a bejelentkezett
 * user saját láthatósági gráfja szerinti agent-listát mutatja, és a választás a
 * meglévő `/embed/agents/<agentId>` chat-route-ra visz ugyanabban az ablakban.
 */
export default async function EmbedAgentPickerPage({
  searchParams,
}: {
  searchParams: Promise<{ app?: string; thread?: string }>
}) {
  const { app: appSlug, thread } = await searchParams

  const ctx = await getAuthContext()
  if (!ctx) return <EmbedSignInPrompt />
  // Egy user = egy tenant: platform-only szerep itt nem értelmezhető — ugyanaz a
  // válasz, mint egy ismeretlen slugra.
  if (ctx.kind !== 'tenant' || !ctx.activeTenantId) notFound()

  if (!appSlug || !thread) notFound()

  const tenant = await repositories.tenants.findById(ctx.activeTenantId)
  // Üres/ismeretlen slug → 404, a lista maga a kapu.
  const embedApp = findEmbedApp(readEmbedApps(tenant?.settings), appSlug)
  if (!embedApp) notFound()

  // A meglévő webes láthatósági gráfon megy át (#52/#80, #142) — mindenki csak a
  // számára elérhető agenteket látja; a chat-route úgyis újra ellenőriz. Nincs
  // lapozás a pickerben, ezért a felső korláttal kérjük, hogy a `retired` szűrés
  // ne egyen le helyet az élő agentek elől.
  const agentsRes = await listAgents({ limit: MAX_LIST_LIMIT })
  const agents = (agentsRes.success ? agentsRes.data : []).filter((a) => a.status !== 'retired')

  const chatHref = (agentId: string) =>
    `/embed/agents/${encodeURIComponent(agentId)}?app=${encodeURIComponent(appSlug)}&thread=${encodeURIComponent(thread)}`

  return (
    <div className="flex h-dvh flex-col bg-canvas px-6 py-8">
      <div className="mx-auto w-full max-w-md">
        <p className="text-sm text-ink-faint">{embedApp.name}</p>
        <h1 className="mt-1 text-xl font-semibold text-ink">Kivel szeretnél beszélgetni?</h1>
        {agents.length === 0 ? (
          <p className="mt-4 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink-faint">
            Nincs elérhető agent a fiókodhoz — kérj hozzáférést a platform-admintól.
          </p>
        ) : (
          <EmbedAgentPickerCards agents={agents} chatHref={chatHref} />
        )}
      </div>
    </div>
  )
}
