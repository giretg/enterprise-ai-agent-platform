import { requireTenantApiUser } from '@/lib/api-tenant-auth'
import { repositories } from '@/repositories/postgres'
import { agentTurnRunner } from '@/domain/agent/agent-turn-runner'
import { isAgentTurnAccessible } from '@/lib/agent-turn-access'
import { invalidatePollScope } from '@/lib/poll-coalesce'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Stop a perzisztált fordulóra (spec §6.2 / D6, issue #65).
 *
 * A megszakítás a FORDULÓ azonosítójára hivatkozik, nem a beszélgetésére: a
 * kérés a rekordra írja a kérést (ki és mikor), és a futó loop ezt olvassa a
 * leállási döntéshozón át — akkor is, ha a Stop másik instance-re érkezett.
 * A helyi runner-jelzés csak gyorsítás, nem az igazság forrása.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ turnId: string }> },
) {
  const auth = await requireTenantApiUser('operator')
  if (!auth.ok) return auth.response
  const { user } = auth

  const { turnId } = await context.params
  if (!turnId) {
    return new Response('turnId is required', { status: 400 })
  }

  const turn = await repositories.agentTurns.findById(turnId)
  if (!turn) {
    return new Response('Turn not found', { status: 404 })
  }

  if (!isAgentTurnAccessible(turn, user)) {
    return new Response('Forbidden', { status: 403 })
  }

  const cancelled = await repositories.agentTurns.requestCancel(turn.id, user.user.id)

  // A vész-leállítás legyen AZONNAL látható a sávban/„Futások" panelen: a mutáció
  // UTÁN eldobjuk e user rövid életű poll-cache-ét, hogy a rákövetkező `refresh()`
  // már a friss DB-állapotot lássa (különben legfeljebb POLL_COALESCE_TTL_MS-ig
  // a leállítás előtti pillanatképet mutatná).
  invalidatePollScope(user.activeTenantId, user.user.id)

  if (!cancelled) {
    // A forduló már terminális. Ez NEM hiba: a Stop és a saját lezárás
    // versenye normális, és a felhasználó szempontjából a kívánt állapot már
    // beállt. Ilyenkor a részeredmény már a beszélgetésben van.
    return Response.json(
      { status: 'already_finished', turnStatus: turn.status },
      { status: 200 },
    )
  }

  // Tier-1 gyorsút: ha a futás helyben van, azonnal jelzünk neki. Ha nincs, a
  // futó instance a DB-flagből veszi észre a következő checkpointon.
  agentTurnRunner.requestCancel(turn.id)
  return new Response(null, { status: 202 })
}
