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
