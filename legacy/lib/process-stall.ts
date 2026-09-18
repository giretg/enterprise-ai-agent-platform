/**
 * Folyamat-elakadás közérthető nézetmodellje.
 *
 * A háttér: ha egy lépés gépi munkája lefut, de az kimenete `failed`/`blocked`
 * (pl. a broker grant/policy elutasított egy eszközhívást), a runtime a lépés
 * ticketjét `done`-ra engedi, a FOLYAMATOT `awaiting_human`-ba teszi, és NYIT
 * EGY MÁSIK ticketet („Emberi felülvizsgálat: …"). A felhasználó eddig csak az
 * első ticketet látta — azon a „Kész" felirattal —, a második ticket sehol nem
 * jelent meg, a következő lépés pedig ártatlan „Következik" címkét kapott.
 *
 * Ez a modul egy helyen mondja ki, hogy a folyamat elakadt, MIÉRT, és HOL a
 * teendő. Szándékosan pure: a szerver-akció és mindhárom felület (board-kártya,
 * feladat-részletek, folyamat-részletek) ugyanezt a szöveget használja.
 */

/** Folyamat-státuszok, amelyeknél a futás emberi beavatkozás nélkül nem megy tovább. */
const STALLED_PROCESS_STATUSES = new Set(['awaiting_human', 'blocked', 'failed'])

/** Terminális ticket-állapotok: innen a ticketen magán már nincs teendő. */
const CLOSED_TICKET_STATES = new Set(['done', 'rejected', 'approved'])

export function isProcessStalled(processStatus: string | null | undefined): boolean {
  return Boolean(processStatus && STALLED_PROCESS_STATUSES.has(processStatus))
}

/**
 * Gépi hibakód → hétköznapi mondat. A kódok forrása:
 * `computeStepOutcome` (`tool_denied`, `tool_loop_exhausted`, `output_contract_unmet`)
 * és a routing (`unhandled_failed`, `unhandled_blocked`).
 */
export const STEP_FAILURE_REASON_TEXT: Record<string, string> = {
  tool_denied:
    'Az AI munkatárs olyan eszközt akart használni, amihez nincs joga (hiányzó engedély vagy csatlakozás). A hívás elmaradt, ezért a lépést nem tekintjük sikeresnek — akkor sem, ha a válasz késznek látszik.',
  tool_loop_exhausted:
    'Az AI munkatárs elhasználta a lépésre szabott eszközhívás-keretet, mielőtt végzett volna a feladattal.',
  output_contract_unmet:
    'A lépés nem adta vissza a kötelezően kért kimeneti mezőket, így a következő lépés nem kapta meg a szükséges adatot.',
  unhandled_failed:
    'A lépés hibával zárult, és a folyamatban nincs erre az esetre külön hibaág — ezért emberi felülvizsgálatra vár.',
  unhandled_blocked:
    'A lépés nem tudott továbblépni, és a folyamatban nincs erre az esetre külön hibaág — ezért emberi felülvizsgálatra vár.',
}

/**
 * A megjelenítendő indoklás. Sorrend: az agent/runtime közérthető üzenete →
 * a gépi hibakód fordítása → a nyers kód (hogy sose maradjon üres a doboz).
 */
export function plainStallReason(input: {
  humanSummary?: string | null
  outcomeReason?: string | null
  routingReason?: string | null
}): string {
  const summary = input.humanSummary?.trim()
  if (summary) return summary
  const outcome = input.outcomeReason?.trim()
  if (outcome && STEP_FAILURE_REASON_TEXT[outcome]) return STEP_FAILURE_REASON_TEXT[outcome]
  const routing = input.routingReason?.trim()
  if (routing && STEP_FAILURE_REASON_TEXT[routing]) return STEP_FAILURE_REASON_TEXT[routing]
  return outcome || routing || 'A folyamat emberi döntésre vár; a pontos ok nem került rögzítésre.'
}

export type ProcessSiblingTicketKind = 'step' | 'gate' | 'review'

export type ProcessSiblingTicket = {
  ticketId: string
  title: string
  state: string
  stepId: string | null
  /** Kapu-ticketnél a Playbook `requiredGateId`-ja — a gráf-node hozzárendeléséhez. */
  gateId?: string | null
  kind: ProcessSiblingTicketKind
  createdAt?: Date | string
}

/** A folyamat nyitott, emberre váró ticketje — ide kell kattintani a továbblépéshez. */
export function findOpenHumanTicket(
  siblings: ProcessSiblingTicket[],
): ProcessSiblingTicket | null {
  const open = siblings.filter((t) => !CLOSED_TICKET_STATES.has(t.state))
  return (
    open.find((t) => t.kind === 'gate') ??
    open.find((t) => t.kind === 'review') ??
    open.find((t) => t.state === 'awaiting_human' || t.state === 'needs_info') ??
    null
  )
}

function asTime(value: Date | string | undefined): number {
  if (!value) return 0
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? 0 : ms
}

/**
 * A board-kártya / folyamat-megnyitás célja: a teendő ticket, nem a gyökér-lépés.
 * Sorrend: nyitott kapu/felülvizsgálat → nyitott emberi ticket → a legutóbb
 * született még nyitott ticket → kész futásnál a legutolsó ticket.
 */
export function pickProcessOpenTicket(
  tickets: ProcessSiblingTicket[],
  fallbackId: string,
): ProcessSiblingTicket | null {
  if (tickets.length === 0) return null
  const human = findOpenHumanTicket(tickets)
  if (human) return human
  const open = tickets.filter((t) => !CLOSED_TICKET_STATES.has(t.state))
  const pool = open.length > 0 ? open : tickets
  return (
    [...pool].sort((a, b) => asTime(b.createdAt) - asTime(a.createdAt))[0] ??
    tickets.find((t) => t.ticketId === fallbackId) ??
    null
  )
}

export function classifyProcessSiblingKind(input: {
  ticketId: string
  title?: string | null
  playbookStepId?: string | null
  requiredGateId?: string | null
  stepTicketIds: Set<string>
}): ProcessSiblingTicketKind {
  if (input.requiredGateId) return 'gate'
  if (input.stepTicketIds.has(input.ticketId)) return 'step'
  // Runtime fallback: extra ticket a lépéshez (emberi felülvizsgálat), nem a gyökér-kártya.
  if (input.playbookStepId || input.title?.startsWith('Emberi felülvizsgálat')) return 'review'
  return 'step'
}

export type ProcessStallNotice = {
  tone: 'warning' | 'danger'
  /** Rövid, kimondott állítás: a folyamat NEM ment tovább. */
  headline: string
  /** Miért — hétköznapi mondat. */
  reason: string
  /** Mi nem történt meg emiatt (a következő lépés). */
  consequence: string | null
  /** Hova kell kattintani. Ha a néző már a felülvizsgálati ticketen áll, nincs link. */
  action: { label: string; href: string; ticketId: string } | null
}

/**
 * A feladat-részletek tetején megjelenő figyelmeztetés. `null`, ha a folyamat
 * rendben halad — ilyenkor semmit nem teszünk a felületre.
 */
export function buildProcessStallNotice(input: {
  processStatus: string | null | undefined
  /** A most nézett ticket azonosítója (hogy ne linkeljünk önmagára). */
  currentTicketId: string
  /** A most nézett ticket lépése — a banner ettől dönti el, „ezen a lépésen” vagy a sorszám. */
  currentStepId?: string | null
  /** A folyamat többi ticketje (a mostani nélkül is jó). */
  siblings: ProcessSiblingTicket[]
  blocked?: {
    stepId?: string | null
    humanSummary?: string | null
    outcomeReason?: string | null
    routingReason?: string | null
  } | null
  /** A lépés, ahol a futás ténylegesen elakadt (`process.blocked.completed_step_id`). */
  blockedStep?: { position: number; stepId: string; stepName: string } | null
  /** Az első lépés, ami emiatt nem indult el. */
  pendingNextStep?: { position: number; stepName: string } | null
}): ProcessStallNotice | null {
  if (!isProcessStalled(input.processStatus)) return null

  const openTicket = findOpenHumanTicket(
    input.siblings.filter((t) => t.ticketId !== input.currentTicketId),
  )
  const isFailed = input.processStatus === 'failed'
  const reason = plainStallReason(input.blocked ?? {})
  const blockedStep = input.blockedStep
  const onBlockedStep = Boolean(
    blockedStep && input.currentStepId && blockedStep.stepId === input.currentStepId,
  )

  const consequence = input.pendingNextStep
    ? `Emiatt a ${input.pendingNextStep.position}. lépés („${input.pendingNextStep.stepName}") el sem indult.`
    : null

  const headline = isFailed
    ? onBlockedStep || !blockedStep
      ? 'A folyamat hibával leállt ezen a lépésen.'
      : `A folyamat hibával leállt a ${blockedStep.position}. lépésen („${blockedStep.stepName}”).`
    : onBlockedStep || !blockedStep
      ? 'A folyamat elakadt ezen a lépésen, és emberi döntésre vár.'
      : `A folyamat a ${blockedStep.position}. lépésen („${blockedStep.stepName}”) elakadt, és emberi döntésre vár.`

  return {
    tone: isFailed ? 'danger' : 'warning',
    headline,
    reason,
    consequence,
    action: openTicket
      ? {
          label:
            openTicket.kind === 'gate'
              ? 'Jóváhagyás megnyitása'
              : 'Felülvizsgálati feladat megnyitása',
          href: `/control-plane/tickets/${openTicket.ticketId}`,
          ticketId: openTicket.ticketId,
        }
      : null,
  }
}

/**
 * Lépés-címke elakadt folyamatban. A `pending` lépés ilyenkor NEM „Következik" —
 * az azt sugallná, hogy magától elindul; valójában emberi döntésig áll.
 */
export function stalledStepStatusLabel(
  status: string,
  processStalled: boolean,
  fallbackLabel: string,
): string {
  if (!processStalled) return fallbackLabel
  if (status === 'pending' || status === 'ready') return 'Nem indult el'
  return fallbackLabel
}

/** A folyamat-ticketek rövid, emberi címkéje a testvér-listához. */
export function siblingTicketKindLabel(kind: ProcessSiblingTicketKind): string {
  switch (kind) {
    case 'gate':
      return 'Jóváhagyási kapu'
    case 'review':
      return 'Emberi felülvizsgálat'
    default:
      return 'Folyamat-lépés'
  }
}

/**
 * A lépés-kártyákon / folyamat-gráfon már látszó ticketeket nem ismételjük a
 * „további feladatok” listában. A felülvizsgálat runtime-ticket, nincs gráf-node-ja.
 */
export function extraProcessTickets(
  siblings: ProcessSiblingTicket[],
  currentTicketId: string,
  graphNodeIds?: Iterable<string>,
): ProcessSiblingTicket[] {
  const nodes = graphNodeIds ? new Set(graphNodeIds) : null
  return siblings.filter((sibling) => {
    if (sibling.ticketId === currentTicketId) return false
    if (sibling.kind === 'review') return true
    if (!nodes) return sibling.kind !== 'step'
    if (sibling.kind === 'gate' && sibling.gateId && nodes.has(sibling.gateId)) return false
    if (sibling.kind === 'step' && sibling.stepId && nodes.has(sibling.stepId)) return false
    return true
  })
}

/** A folyamat-gráf nodejához tartozó ticket — kattintásra ezt nyitjuk. */
export function ticketIdForProcessNode(input: {
  nodeId: string
  nodeKind: 'step' | 'gate'
  steps: Array<{ stepId: string; ticketId: string | null }>
  siblings: ProcessSiblingTicket[]
}): string | null {
  if (input.nodeKind === 'step') {
    return input.steps.find((step) => step.stepId === input.nodeId)?.ticketId ?? null
  }
  return (
    input.siblings.find((sibling) => sibling.kind === 'gate' && sibling.gateId === input.nodeId)
      ?.ticketId ?? null
  )
}

/** Folyamat-gráf node-színe: a nyers lépés-státusz, elakadásnál „vár”. */
export type ProcessNodeTraceStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'awaiting'

export function processStepTraceStatus(
  status: string,
  options?: { stalledHere?: boolean; processFailed?: boolean },
): ProcessNodeTraceStatus {
  if (options?.stalledHere) {
    if (options.processFailed || status === 'failed') return 'failed'
    return 'awaiting'
  }
  switch (status) {
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'awaiting_gate':
      return 'awaiting'
    case 'skipped':
      return 'skipped'
    case 'ready':
    case 'in_progress':
      return 'running'
    default:
      return 'pending'
  }
}
