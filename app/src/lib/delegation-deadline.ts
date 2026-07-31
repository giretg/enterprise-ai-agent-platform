/**
 * Szinkron delegáció (`agent_ask`) határideje — tiszta, DB-mentes segéd.
 *
 * A delegált agent futása a HÍVÓ fordulójának faliórájából fogy. Mért eset
 * (2026-07-31): négy kérdés 136 másodpercet vitt el egy 180 másodperces
 * keretből, és két forduló emiatt futott ki az időből — a felhasználó válasz
 * helyett megszakadt fordulót kapott, és „folytasd"-ot kellett írnia.
 *
 * Szándékosan külön modul: a `tool-broker-delegation` behúzza a Prisma-klienst,
 * így az ottani függvények nem tesztelhetők élő DB nélkül.
 */

/** A határidő lejártát jelző őrszem — nem hiba, ezért nem kivétel. */
export const DELEGATION_DEADLINE = Symbol('delegation_deadline')

/**
 * Megvárja a delegációt, de legfeljebb `deadlineAt`-ig (epoch ms). Határidő
 * nélkül a hívás a szokásos módon végigvár — azt, hogy egyáltalán érdemes-e
 * elindítani, a hívó dönti el (l. a tool-loop delegáció-előkapuját).
 *
 * A megszakítás CSAK a várást engedi el: a delegált futás tovább megy és beírja
 * a válaszát a ticketbe. Ez szándékos — a munka nem vész el, csak nem ebben a
 * fordulóban jelenik meg. Az elengedett ág hibáját a HÍVÓNAK kell lenyelnie,
 * különben kezeletlen promise-elutasítás lesz belőle.
 */
export async function raceDelegationDeadline<T>(
  running: Promise<T>,
  deadlineAt: number | undefined,
  now: () => number = Date.now,
): Promise<T | typeof DELEGATION_DEADLINE> {
  if (typeof deadlineAt !== 'number' || !Number.isFinite(deadlineAt)) return running
  const remainingMs = deadlineAt - now()
  if (remainingMs <= 0) return DELEGATION_DEADLINE
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      running,
      new Promise<typeof DELEGATION_DEADLINE>((resolve) => {
        timer = setTimeout(() => resolve(DELEGATION_DEADLINE), remainingMs)
        // A lejáró időzítő ne tartsa életben a processzt.
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
