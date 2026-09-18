export const TICKET_STATE_LABELS: Record<string, string> = {
  backlog: 'Betervezve',
  ready: 'Végrehajtásra vár',
  awaiting_human: 'Emberi jóváhagyás',
  needs_info: 'Pontosításra vár',
  approved: 'Jóváhagyva',
  in_progress: 'Végrehajtás alatt',
  done: 'Kész',
  rejected: 'Visszadobva',
}

export const TICKET_STATE_TONE: Record<
  string,
  'neutral' | 'success' | 'warning' | 'danger'
> = {
  backlog: 'neutral',
  ready: 'warning',
  awaiting_human: 'warning',
  needs_info: 'warning',
  approved: 'success',
  in_progress: 'neutral',
  done: 'success',
  rejected: 'danger',
}

/**
 * Hétköznapi magyarázat minden állapothoz — a badge önmagában nem mondja meg,
 * hogy most kin a sor. Ez a mondat kerül a feladat fejlécébe.
 */
export const TICKET_STATE_HINTS: Record<string, string> = {
  backlog: 'Még nincs elindítva — a sorban várakozik.',
  ready: 'Indításra kész: az AI munkatárs bármikor nekiláthat.',
  in_progress: 'Az AI munkatárs éppen dolgozik rajta.',
  awaiting_human: 'Rajtad a sor: nézd át és hagyd jóvá vagy dobd vissza.',
  needs_info: 'Pontosítást kér — válaszolj a feladat-szálban.',
  approved: 'Jóváhagyva — a rendszer zárja a feladatot.',
  done: 'Elkészült, nincs több teendő.',
  rejected: 'Visszadobtad — javítás után újraindítható.',
}

/** Badge-tónus → pötty/keret osztályok (fejléc, idővonal). */
export const TICKET_TONE_DOT_CLASS: Record<
  'neutral' | 'success' | 'warning' | 'danger',
  string
> = {
  neutral: 'bg-ink-faint',
  success: 'bg-sage',
  warning: 'bg-honey',
  danger: 'bg-coral',
}

/**
 * Állapot-szín paletta a boardhoz. Minden állapot ugyanazt a színt viseli az
 * oszlopfejlécen, a kártya bal élén és az összesítő csempén — így a szín
 * önmagában is elárulja, hol tart a feladat.
 */
export type TicketStateAccent = {
  /** Tömör csík: oszlop teteje, kártya bal éle. */
  bar: string
  /** Kis pötty a fejlécben és a csempéken. */
  dot: string
  /** Halvány háttér az oszlop törzsének. */
  wash: string
  /** Darabszám-pirula a fejlécben. */
  count: string
}

const NEUTRAL_ACCENT: TicketStateAccent = {
  bar: 'bg-ink-faint/50',
  dot: 'bg-ink-faint',
  wash: 'bg-ink/[0.02]',
  count: 'bg-ink/10 text-ink-soft',
}

export const TICKET_STATE_ACCENT: Record<string, TicketStateAccent> = {
  backlog: NEUTRAL_ACCENT,
  ready: {
    bar: 'bg-honey',
    dot: 'bg-honey',
    wash: 'bg-honey/[0.05]',
    count: 'bg-honey/15 text-honey',
  },
  in_progress: {
    bar: 'bg-sky',
    dot: 'bg-sky',
    wash: 'bg-sky/[0.05]',
    count: 'bg-sky/15 text-sky',
  },
  awaiting_human: {
    bar: 'bg-coral',
    dot: 'bg-coral',
    wash: 'bg-coral/[0.05]',
    count: 'bg-coral/15 text-coral',
  },
  needs_info: {
    bar: 'bg-grape',
    dot: 'bg-grape',
    wash: 'bg-grape/[0.05]',
    count: 'bg-grape/15 text-grape',
  },
  approved: {
    bar: 'bg-sage',
    dot: 'bg-sage',
    wash: 'bg-sage/[0.05]',
    count: 'bg-sage/15 text-sage',
  },
  done: {
    bar: 'bg-sage/60',
    dot: 'bg-sage/60',
    wash: 'bg-sage/[0.03]',
    count: 'bg-sage/10 text-sage',
  },
  rejected: {
    bar: 'bg-coral-deep',
    dot: 'bg-coral-deep',
    wash: 'bg-coral/[0.03]',
    count: 'bg-coral/10 text-coral-deep',
  },
}

export function ticketStateAccent(state: string): TicketStateAccent {
  return TICKET_STATE_ACCENT[state] ?? NEUTRAL_ACCENT
}

export const PROPOSAL_FIELD_LABELS: Record<string, string> = {
  supplier: 'Szállító',
  invoiceNumber: 'Számlaszám',
  date: 'Dátum',
  netAmount: 'Nettó összeg',
  vatAmount: 'ÁFA',
  grossAmount: 'Bruttó összeg',
  suggestedAccount: 'Javasolt főkönyvi szám',
  suggestedAccountName: 'Főkönyvi számla neve',
  costCenter: 'Költséghely',
  reasoning: 'Indoklás',
}

export function formatProposalValue(key: string, value: unknown): string {
  if (value == null) return '—'
  if (typeof value === 'number') {
    if (key.toLowerCase().includes('amount')) {
      return `${value.toLocaleString('hu-HU')} Ft`
    }
    return String(value)
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'object' && item && 'description' in item) {
          const row = item as { description?: string; amount?: number }
          return `${row.description ?? '?'} (${(row.amount ?? 0).toLocaleString('hu-HU')} Ft)`
        }
        return JSON.stringify(item)
      })
      .join('; ')
  }
  return String(value)
}
