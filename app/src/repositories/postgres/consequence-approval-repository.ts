import { Prisma, type ConsequenceApproval, type ConsequenceApprovalStatus } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { ConsequenceApprovalRepository } from '@/repositories/interfaces'

/**
 * Egy szál/ticket egyszerre látható jóváhagyásainak felső korlátja.
 *
 * A korábbi 50 NEM elméleti plafon volt: egy valós tulajdoni-lap szinkron 93
 * kártyát termelt (`f7ef867f`), tehát a lista némán csonkolt — a „Jóváhagyom
 * mind" a levágott tételeket ki is hagyta volna, és a felhasználó úgy zárta
 * volna le a feladatot, hogy közben műveletek maradtak végrehajtatlanul.
 */
const CONSEQUENCE_APPROVAL_LIST_LIMIT = 500

export class PostgresConsequenceApprovalRepository implements ConsequenceApprovalRepository {
  async create(
    data: Omit<ConsequenceApproval, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ConsequenceApproval> {
    return prisma.consequenceApproval.create({
      data: {
        ...data,
        args: data.args as Prisma.InputJsonValue,
        resultMeta: (data.resultMeta ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    })
  }

  async findById(id: string): Promise<ConsequenceApproval | null> {
    return prisma.consequenceApproval.findUnique({ where: { id } })
  }

  async listOpenByConversation(
    conversationId: string,
    createdAfter: Date,
  ): Promise<ConsequenceApproval[]> {
    // A `[conversationId, status]` index fedi (az `in` is index-barát). Az
    // `approved` sorokra azért van szükség, mert az elbukott tool-hívás is
    // approved státuszon marad — a hívó szűri.
    return prisma.consequenceApproval.findMany({
      where: {
        conversationId,
        status: { in: ['pending', 'approved'] },
        createdAt: { gt: createdAfter },
      },
      orderBy: { createdAt: 'asc' },
      take: CONSEQUENCE_APPROVAL_LIST_LIMIT,
    })
  }

  async listOpenByTicket(
    ticketId: string,
    createdAfter: Date,
  ): Promise<ConsequenceApproval[]> {
    return prisma.consequenceApproval.findMany({
      where: {
        ticketId,
        status: { in: ['pending', 'approved'] },
        createdAt: { gt: createdAfter },
      },
      orderBy: { createdAt: 'asc' },
      take: CONSEQUENCE_APPROVAL_LIST_LIMIT,
    })
  }

  async findOpenDuplicate(input: {
    conversationId?: string | null
    ticketId?: string | null
    toolName: string
    args: unknown
    now: Date
  }): Promise<ConsequenceApproval | null> {
    // A szál-azonosító KÖTELEZŐ: enélkül a szűrés kifutna a beszélgetésből /
    // ticketből, és egy másik felhasználó azonos alakú műveletére egyezne.
    if (!input.conversationId && !input.ticketId) return null
    // A Prisma `equals` a JSON-t jsonb-ként hasonlítja: kulcssorrendtől független,
    // tehát ugyanaz a hívás azonos alakban mindig egyezik.
    return prisma.consequenceApproval.findFirst({
      where: {
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.ticketId ? { ticketId: input.ticketId } : {}),
        toolName: input.toolName,
        status: 'pending',
        expiresAt: { gt: input.now },
        args: { equals: input.args as Prisma.InputJsonValue },
      },
      orderBy: { createdAt: 'asc' },
    })
  }

  async casUpdateStatus(
    id: string,
    expectedStatus: ConsequenceApprovalStatus,
    patch: {
      status: ConsequenceApprovalStatus
      approvedBy?: string | null
      approvedAt?: Date | null
      rejectedBy?: string | null
      rejectedAt?: Date | null
      resultMeta?: unknown
      blockedToolCallId?: string | null
    },
  ): Promise<ConsequenceApproval | null> {
    const result = await prisma.consequenceApproval.updateMany({
      where: { id, status: expectedStatus },
      data: {
        status: patch.status,
        ...(patch.approvedBy !== undefined ? { approvedBy: patch.approvedBy } : {}),
        ...(patch.approvedAt !== undefined ? { approvedAt: patch.approvedAt } : {}),
        ...(patch.rejectedBy !== undefined ? { rejectedBy: patch.rejectedBy } : {}),
        ...(patch.rejectedAt !== undefined ? { rejectedAt: patch.rejectedAt } : {}),
        ...(patch.blockedToolCallId !== undefined
          ? { blockedToolCallId: patch.blockedToolCallId }
          : {}),
        ...(patch.resultMeta !== undefined
          ? { resultMeta: patch.resultMeta as Prisma.InputJsonValue }
          : {}),
      },
    })
    if (result.count === 0) return null
    return prisma.consequenceApproval.findUnique({ where: { id } })
  }

  async casClaimRetry(id: string): Promise<ConsequenceApproval | null> {
    // Egyszer-használatos claim az „Újrapróbálom" úthoz. A sor MÁR `approved`, a
    // korábbi invoke pedig bukott (`result_meta.denied === true`). Az UPDATE egyetlen
    // atomi lépésben ellenőrzi ezt a feltételt ÉS ráteszi a `retrying: true` jelzőt
    // (a `denied` kulcsot MEGTARTVA, `||` merge), így két párhuzamos retry-kattintás
    // közül csak egy győzhet — a vesztes 0 sort érint és `null`-t kap, tehát nem
    // futtatja MÉGEGYSZER a mellékhatásos toolt (dupla e-mail / dupla POST).
    //
    // A `NOT jsonb_exists(..., 'retrying')` kizárja a MÁR lefoglalt (folyamatban lévő)
    // sort — ez a fail-safe kizárólagosság. Fontos: a `denied` szándékosan `true`
    // marad a jelző alatt is, hogy a sor SOHA ne essen az `approve()` siker-ágába
    // (különben egy folyamatban lévő retry „lefutott"-ként jelenne meg).
    //
    // Raw SQL a `@>` containment és a `jsonb_exists` miatt: ezek az adatbázisban
    // megbízhatóak és GIN-index-barátok (a Prisma JSON-path szűrő hiányzó mezőnél
    // NULL-t ad, l. ticket-repository.ts). A `jsonb_exists` függvényforma szándékos:
    // a `?` operátor a driverben paraméter-helyőrzővel ütközhet. A `@updatedAt`-et a
    // raw UPDATE nem kezeli, ezért expliciten állítjuk.
    const count = await prisma.$executeRaw`
      UPDATE consequence_approvals
      SET result_meta = result_meta || '{"retrying": true}'::jsonb, updated_at = now()
      WHERE id = ${id}::uuid
        AND status = 'approved'
        AND result_meta @> '{"denied": true}'::jsonb
        AND NOT jsonb_exists(result_meta, 'retrying')
    `
    if (count === 0) return null
    return prisma.consequenceApproval.findUnique({ where: { id } })
  }
}
