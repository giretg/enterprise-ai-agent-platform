/**
 * A csatorna-forduló agent-futásidő adaptere (Telegram feature-spec #70/#74, D8/D11).
 *
 * A #74 döntése, hogy a Telegram NEM új futásidő, hanem a MEGLÉVŐ webes chat-futásidőt hívja
 * ugyanarra a beszélgetésre. Ez az adapter köti a csatorna-szolgáltatás `ChannelAgentRuntime`
 * portját a valós `AgentChatRuntime.sendMessageStream`-hez:
 *
 *  - a stream `token` darabjaiból áll össze a VÉGSŐ válasz — a `thinking` eseményeket
 *    KIHAGYJUK, ezért a belső gondolkodási nyom szerkezetileg nem kerülhet ki (spec §26);
 *  - a user- és agent-üzenet perzisztálása, a tool-hurok, a memória és a snapshot mind a
 *    webes futásidőben történik ugyanabba a `conversationId`-ba → a Telegram-beszélgetés a
 *    webes felületen is megjelenik (AC);
 *  - a hibákat a csatorna-réteg által várt, hétköznapi kategóriákra képezzük (időtúllépés /
 *    modellhiba / napi keret elfogyott), hogy a felhasználó érthető magyar üzenetet kapjon.
 *
 * Megjegyzés: a determinisztikus, DB-mentes VARRAT-tesztek NEM ezt az adaptert használják,
 * hanem egy befecskendezett dublőrt (a teszt a csatornát méri, nem a modellt).
 */
import type { AgentChatRuntime } from '@/domain/agent/agent-chat-runtime'
import type { AgentChatStreamEvent } from '@/domain/agent/agent-turn-runner'
import type {
  ChannelAgentRuntime,
  ChannelAgentRuntimeResult,
} from './channel-turn-service'

/**
 * A perzisztált agent-üzenet szövegének visszaolvasása (a nyers, nem-redaktált válaszhoz). Ha
 * nincs megadva, az adapter a stream `token` darabjaira esik vissza. (Follow-up: a nem-redaktált
 * szöveg visszaolvasásával a csatorna érzékenységi kapuja [D10] a valós tartalmon dönthet, nem a
 * webes stream-redaktor kimenetén.)
 */
export type ChannelReplyReader = (messageId: string) => Promise<string | null>

export class AgentChatChannelRuntime implements ChannelAgentRuntime {
  constructor(
    private readonly runtime: Pick<AgentChatRuntime, 'sendMessageStream'>,
    private readonly readReply?: ChannelReplyReader,
  ) {}

  async runTurn(input: {
    agentId: string
    tenantId: string | null
    userId: string
    conversationId: string
    projectKey: string
    text: string
  }): Promise<ChannelAgentRuntimeResult> {
    let accumulated = ''
    let messageId: string | null = null
    let streamError: string | null = null

    try {
      // A grant `projectKey`-je a memória-/audit-hatóköre. A 24 órás gördülő
      // beszélgetés létrehozáskor kap kulcsot, de a felhasználó a weben
      // közben átállíthatja a grantet — ha itt nem adjuk tovább, a futásidő
      // a régi conversation.projectKey-t használja (rossz projekt-memória),
      // miközben a Telegram-címke már az új projektet mutatja.
      const stream = this.runtime.sendMessageStream({
        agentId: input.agentId,
        content: input.text,
        createdById: input.userId,
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        projectKey: input.projectKey,
      })
      for await (const event of stream as AsyncGenerator<AgentChatStreamEvent>) {
        switch (event.type) {
          case 'token':
            accumulated += event.chunk
            break
          case 'done':
            messageId = event.messageId
            break
          case 'error':
            streamError = event.message
            break
          // `thinking` és `activity`: SZÁNDÉKOSAN kihagyva — a gondolkodási nyom nem megy ki.
          default:
            break
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? error.message : String(error)
    }

    if (streamError) return { ok: false, reason: classifyRuntimeError(streamError) }

    // A hiteles (nem-redaktált) választ a perzisztált üzenetből olvassuk vissza, hogy a
    // csatorna érzékenységi kapuja (D10) a valós szövegen dönthessen; ha nem elérhető, a
    // stream tokenjeire esünk vissza.
    const persisted = messageId && this.readReply ? await this.readReply(messageId) : null
    const text = (persisted ?? accumulated).trim()
    if (!text) return { ok: false, reason: 'model_error' }
    return { ok: true, text }
  }
}

/** A futásidő hibáját a csatorna-réteg hétköznapi kategóriáira képezi (§23/§24). */
function classifyRuntimeError(
  message: string,
): 'timeout' | 'model_error' | 'budget_exhausted' | 'unknown' {
  const m = message.toLowerCase()
  if (m.includes('budget') || m.includes('keret') || m.includes('quota')) return 'budget_exhausted'
  if (m.includes('timeout') || m.includes('időtúllépés') || m.includes('aborted')) return 'timeout'
  return 'model_error'
}
