/**
 * Platform-chat a Model Gatewayen (#1004 WP-3, WP-10).
 *
 * A worker szerveroldali kliens: nincs Guard, nincs heartbeat, nincs helyi eszköze. Ezért saját
 * install-fajtát kap (`ClientInstall.kind = platform_chat`, rögzített `installId`), a sessiont
 * (= beszélgetés) a gateway-token kiadása regisztrálja, a gép-padló és a helyi tengelyek nem
 * vonatkoznak rá. A kapu itt dönt a tenant-/agent-kapcsolóról és a napi modell-keretről (D14);
 * minden más install a meglévő Managed/Open kapun megy.
 */
import type { AuditSink } from '@/lib/audit/types'
import { writeAudit } from '@/lib/audit/types'
import { platformChatBudgetDay } from '@/lib/platform-chat-settings'
import type { GatewayPipelineHooks, ModelCallAuditSink, ModelCallEvent } from '@/domain/model-gateway/proxy'

export const PLATFORM_CHAT_INSTALL_ID = 'platform-chat'
export const PLATFORM_CHAT_INSTALL_KIND = 'platform_chat'
/** A worker ebből a fejlécből tudja, hogy a szintetikus válasz keret-blokk (nem modell-válasz). */
export const BLOCK_REASON_HEADER = 'x-excellence-block-reason'
export const BUDGET_BLOCK_REASON = 'platform_chat_budget'
export const BUDGET_EXHAUSTED_MESSAGE =
  'A cég mai keretét erre a beszélgetésre már felhasználtuk. Holnap reggel újra elérhető.'
const DISABLED_MESSAGE = 'Ez a munkatárs most nem érhető el a platform-chatben. Kérd meg az adminisztrátort, hogy engedélyezze.'
const SESSION_MESSAGE = 'A beszélgetés munkamenete lejárt. Küldd el újra az üzenetet.'
/** A gateway-token kiadása frissíti; a worker minden modellhívás előtt új tokent kér. */
const SESSION_FRESHNESS_SECONDS = 15 * 60
/**
 * Becslés, ha a provider nem ad vissza költséget (pl. nem OpenRouter): USD / millió token.
 * ponytail: egységes, szándékosan drága tarifa; modell-ár térkép, ha a becslés pontatlansága zavar.
 */
const DEFAULT_FALLBACK_USD_PER_MTOK = 15

/** Fenntartott installId-k: Hermes kliens nem kérhet ilyen nevű gateway-tokent. */
export function isReservedInstallId(installId: string): boolean {
  return installId.toLowerCase().startsWith(PLATFORM_CHAT_INSTALL_ID)
}

export type PlatformChatAccess = {
  tenantEnabled: boolean
  dailyBudgetUsd: number | null
  agentEnabled: boolean
}

export interface PlatformChatGatewayStore {
  registerSession(input: { tenantId: string; userId: string; agentId: string; sessionId: string; now: Date }): Promise<void>
  findSession(input: { tenantId: string; userId: string; agentId: string; sessionId: string }): Promise<{ lastSeenAt: Date } | null>
  spendOn(input: { tenantId: string; day: string }): Promise<number>
  addSpend(input: { tenantId: string; day: string; costUsd: number }): Promise<void>
}

export type PlatformChatGatewayDeps = {
  store: PlatformChatGatewayStore
  loadAccess: (input: { tenantId: string; agentId: string }) => Promise<PlatformChatAccess>
  audit?: AuditSink
  now?: () => Date
  fallbackUsdPerMTok?: number
}

export function costOfUsage(
  usage: ModelCallEvent['usage'],
  fallbackUsdPerMTok = DEFAULT_FALLBACK_USD_PER_MTOK,
): number {
  if (!usage) return 0
  if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) return usage.costUsd
  const tokens = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)
  return (tokens / 1_000_000) * fallbackUsdPerMTok
}

export type PlatformChatBudgetStatus = { day: string; spentUsd: number; budgetUsd: number | null }

export async function platformChatBudgetStatus(
  deps: Pick<PlatformChatGatewayDeps, 'store' | 'now'>,
  input: { tenantId: string; budgetUsd: number | null },
): Promise<PlatformChatBudgetStatus> {
  const day = platformChatBudgetDay((deps.now ?? (() => new Date()))())
  return { day, spentUsd: await deps.store.spendOn({ tenantId: input.tenantId, day }), budgetUsd: input.budgetUsd }
}

/**
 * A platform-chat install kapuja; minden más install a `fallback` (Managed/Open) kapun megy.
 * Legfeljebb egy hívásnyi keret-túllépés lehetséges (a költség a hívás után derül ki) — a spec ezt elfogadja.
 */
export function createPlatformChatGate(
  deps: PlatformChatGatewayDeps,
  fallback: NonNullable<GatewayPipelineHooks['gate']>,
): NonNullable<GatewayPipelineHooks['gate']> {
  return async (ctx) => {
    if (ctx.installId !== PLATFORM_CHAT_INSTALL_ID) return fallback(ctx)
    const access = await deps.loadAccess({ tenantId: ctx.tenantId, agentId: ctx.agentId })
    if (!access.tenantEnabled || !access.agentEnabled || access.dailyBudgetUsd === null) {
      return { block: DISABLED_MESSAGE, reason: 'platform_chat_disabled' }
    }
    const now = (deps.now ?? (() => new Date()))()
    const session = ctx.sessionId
      ? await deps.store.findSession({ tenantId: ctx.tenantId, userId: ctx.userId, agentId: ctx.agentId, sessionId: ctx.sessionId })
      : null
    if (!session || now.getTime() - session.lastSeenAt.getTime() > SESSION_FRESHNESS_SECONDS * 1000) {
      return { block: SESSION_MESSAGE, reason: 'platform_chat_session' }
    }
    const spent = await deps.store.spendOn({ tenantId: ctx.tenantId, day: platformChatBudgetDay(now) })
    if (spent >= access.dailyBudgetUsd) {
      await writeAudit(deps.audit, {
        actorType: 'human',
        actorId: ctx.userId,
        action: 'platform_chat.budget_exhausted',
        targetType: 'tenant',
        targetId: ctx.tenantId,
        policyDecision: 'denied',
        metadata: { spentUsd: spent, budgetUsd: access.dailyBudgetUsd, agentId: ctx.agentId },
        tenantId: ctx.tenantId,
      })
      return { block: BUDGET_EXHAUSTED_MESSAGE, reason: BUDGET_BLOCK_REASON }
    }
    return null
  }
}

/** Az audit-sink köré: a platform-chat hívások költségét a napi számlálóra írja (a Hermes-forgalmat nem). */
export function withPlatformChatSpend(
  sink: ModelCallAuditSink,
  deps: Pick<PlatformChatGatewayDeps, 'store' | 'now' | 'fallbackUsdPerMTok'>,
): ModelCallAuditSink {
  return {
    async record(event) {
      const spend = async () => {
        if (event.installId !== PLATFORM_CHAT_INSTALL_ID) return
        if (event.outcome !== 'ok' && event.outcome !== 'aborted') return
        const costUsd = costOfUsage(event.usage, deps.fallbackUsdPerMTok)
        if (costUsd <= 0) return
        const day = platformChatBudgetDay((deps.now ?? (() => new Date()))())
        await deps.store.addSpend({ tenantId: event.tenantId, day, costUsd })
      }
      // Az audit hibája nem nyelheti el a költés-könyvelést (és fordítva).
      const [audited, spent] = await Promise.allSettled([sink.record(event), spend()])
      if (audited.status === 'rejected') throw audited.reason
      if (spent.status === 'rejected') throw spent.reason
    },
  }
}
