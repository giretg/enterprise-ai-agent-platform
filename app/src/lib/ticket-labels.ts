export const TICKET_STATE_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  awaiting_human: 'Emberi jóváhagyás',
  needs_info: 'Pontosításra vár',
  approved: 'Jóváhagyva',
  in_progress: 'Feldolgozás',
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
