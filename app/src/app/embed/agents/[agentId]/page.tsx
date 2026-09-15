import { notFound } from 'next/navigation'
import { Prisma } from '@prisma/client'
import { getAuthContext } from '@/auth/context'
import { getAgent } from '@/app/actions/platform'
import { prisma } from '@/lib/db'
import { repositories } from '@/repositories/postgres'
import { findEmbedApp, readEmbedApps } from '@/lib/embed-apps'
import { EmbedChatWindow } from './embed-chat-window'
import { EmbedSignInPrompt } from './embed-sign-in-prompt'

/**
 * Beágyazott agent-chat — csupasz chat-route idegen alkalmazásból (feature-spec
 * #481, D1-D3, D9). Nincs fejléc-sáv/shell: az app egy `window.open`-nel nyitja,
 * a Clerk-session első-fél sütiként érvényesül.
 */
export default async function EmbedAgentChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ agentId: string }>
  searchParams: Promise<{ app?: string; thread?: string }>
}) {
  const { agentId } = await params
  const { app: appSlug, thread } = await searchParams

  const ctx = await getAuthContext()
  if (!ctx) return <EmbedSignInPrompt />
  // Egy user = egy tenant (D0): platform-only szerep (nincs aktív tenant) itt nem
  // értelmezhető — ugyanaz a válasz, mint egy ismeretlen slugra.
  if (ctx.kind !== 'tenant' || !ctx.activeTenantId) notFound()

  if (!appSlug || !thread) notFound()

  const tenant = await prisma.tenant.findUnique({
    where: { id: ctx.activeTenantId },
    select: { settings: true },
  })
  // D7: üres/ismeretlen slug → 404, a lista maga a kapu.
  const embedApp = findEmbedApp(readEmbedApps(tenant?.settings), appSlug)
  if (!embedApp) notFound()

  // D9: a meglévő webes láthatósági gráfon megy át — idegen tenant agentje 404,
  // hogy ne szivárogjon a létezése.
  const agentRes = await getAgent({ id: agentId })
  if (!agentRes.success) notFound()
  const agent = agentRes.data.agent

  const channelExternalId = `${appSlug}:${thread}`
  let conversation = await prisma.conversation.findFirst({
    where: { channel: 'embedded_app', channelExternalId, createdById: ctx.user.id },
  })
  if (conversation && conversation.agentId !== agentId) notFound()
  if (!conversation) {
    try {
      conversation = await repositories.conversations.create({
        tenantId: ctx.activeTenantId,
        agentId,
        createdById: ctx.user.id,
        channel: 'embedded_app',
        channelExternalId,
        title: `${embedApp.name} · ${thread}`.slice(0, 200),
      })
    } catch (e) {
      // Két egyidejű megnyitás versenyezhet a részleges egyedi indexen (D3) — a
      // vesztes újraolvassa, amit a nyertes közben létrehozott.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        conversation = await prisma.conversation.findFirst({
          where: { channel: 'embedded_app', channelExternalId, createdById: ctx.user.id },
        })
      }
      if (!conversation) throw e
      if (conversation.agentId !== agentId) notFound()
    }
  }

  return (
    <EmbedChatWindow
      agent={{
        id: agent.id,
        name: agent.name,
        status: agent.status,
        avatarUrl: agent.avatarUrl,
        personaNickname: agent.personaNickname,
        personaGreeting: agent.personaGreeting,
        personaTrait: agent.personaTrait,
      }}
      conversationId={conversation.id}
      appSlug={appSlug}
      appOrigin={embedApp.origin}
    />
  )
}
