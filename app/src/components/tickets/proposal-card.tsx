import { Card } from '@/components/ui/shell'
import {
  formatProposalValue,
  PROPOSAL_FIELD_LABELS,
} from '@/lib/ticket-labels'

const DISPLAY_ORDER = [
  'supplier',
  'invoiceNumber',
  'date',
  'netAmount',
  'vatAmount',
  'grossAmount',
  'lineItems',
  'suggestedAccount',
  'suggestedAccountName',
  'costCenter',
  'reasoning',
] as const

export function ProposalCard({
  proposal,
  title = 'Könyvelési javaslat',
  className = '',
}: {
  proposal: Record<string, unknown>
  title?: string
  className?: string
}) {
  const keys = DISPLAY_ORDER.filter((k) => k in proposal)
  const extraKeys = Object.keys(proposal).filter(
    (k) => !DISPLAY_ORDER.includes(k as (typeof DISPLAY_ORDER)[number]),
  )

  return (
    <Card title={title} className={className}>
      <dl className="grid gap-4 sm:grid-cols-2">
        {[...keys, ...extraKeys].map((key) => (
          <div
            key={key}
            className={key === 'reasoning' ? 'sm:col-span-2' : ''}
          >
            <dt className="text-xs uppercase tracking-wide text-ink-faint">
              {PROPOSAL_FIELD_LABELS[key] ?? key}
            </dt>
            <dd
              className={`mt-1 font-medium ${
                key === 'reasoning' ? 'text-sm leading-relaxed text-ink-soft' : ''
              }`}
            >
              {formatProposalValue(key, proposal[key])}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}
