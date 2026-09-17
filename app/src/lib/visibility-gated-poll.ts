/**
 * Rejtett fülön szüneteltetjük a pollt: a hívók (`router.refresh()`) Server
 * Actionök, minden hívás adatbázis-lekérdezést és teljes RSC-újrarendelést
 * indít az origin-en, akkor is, ha a ticket-lap háttérfülön van.
 * Visszaállítás: NEXT_PUBLIC_TICKET_POLL_PAUSE_ON_HIDDEN_TAB=false.
 */
export function shouldFireVisibilityGatedPoll(hidden: boolean, pauseOnHidden: boolean): boolean {
  return !pauseOnHidden || !hidden
}

export function ticketPollPauseOnHiddenTabEnabled(): boolean {
  return process.env.NEXT_PUBLIC_TICKET_POLL_PAUSE_ON_HIDDEN_TAB !== 'false'
}
