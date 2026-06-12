import { Link, useNavigate, useParams } from 'react-router-dom'
import { Badge } from '../../shared/components/Badge'
import { Card } from '../../shared/components/Card'
import { useDemo } from '../../shared/context/DemoContext'

function formatHuf(amount: number): string {
  return `${amount.toLocaleString('hu-HU')} Ft`
}

export function TicketDetailPage() {
  const { ticketId } = useParams<{ ticketId: string }>()
  const navigate = useNavigate()
  const { getTicket, approveTicket, rejectTicket } = useDemo()

  const ticket = ticketId ? getTicket(ticketId) : undefined

  if (!ticket) {
    return (
      <div className="text-center">
        <p className="text-slate-400">Ticket nem található: {ticketId}</p>
        <Link
          to="/control-plane/board"
          className="mt-4 inline-block text-sky-400 hover:text-sky-300"
        >
          ← Vissza a boardra
        </Link>
      </div>
    )
  }

  const proposal = ticket.proposal
  const canApprove =
    ticket.status === 'awaiting_human' && ticket.proposal !== undefined

  return (
    <div>
      <Link
        to="/control-plane/board"
        className="mb-4 inline-block text-sm text-slate-400 hover:text-slate-200"
      >
        ← Board
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex flex-wrap gap-2">
            <Badge variant="mono">{ticket.id}</Badge>
            <Badge variant="info">{ticket.status.replace('_', ' ')}</Badge>
            {ticket.agentVersion && (
              <Badge variant="mono">agent v{ticket.agentVersion}</Badge>
            )}
            {ticket.model && (
              <Badge variant="mono">{ticket.model}</Badge>
            )}
          </div>
          <h1 className="text-xl font-semibold text-slate-50">{ticket.title}</h1>
          <p className="mt-1 text-sm text-slate-400">
            Felelős: {ticket.assignee} ({ticket.assigneeType})
          </p>
        </div>

        {canApprove && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                rejectTicket(ticket.id)
                navigate('/control-plane/board')
              }}
              className="rounded-md border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:border-red-700 hover:text-red-300"
            >
              Visszadob
            </button>
            <button
              type="button"
              onClick={() => {
                approveTicket(ticket.id)
                navigate('/control-plane/board')
              }}
              className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600"
            >
              ✓ Jóváhagy
            </button>
          </div>
        )}
      </div>

      {canApprove && (
        <div className="mb-6 rounded-lg border border-amber-800/50 bg-amber-950/20 p-4">
          <div className="flex items-center gap-2">
            <Badge variant="warning">Human-in-the-loop kapu</Badge>
            <span className="text-sm text-amber-200">
              Az agent javaslatot készített — emberi jóváhagyás szükséges az
              éles könyvelés előtt
            </span>
          </div>
        </div>
      )}

      {proposal ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Könyvelési javaslat">
            <dl className="space-y-3 text-sm">
              <Row label="Szállító" value={proposal.supplier} />
              <Row label="Számlaszám" value={proposal.invoiceNumber} />
              <Row label="Dátum" value={proposal.date} />
              <Row label="Nettó" value={formatHuf(proposal.netAmount)} />
              <Row label="ÁFA" value={formatHuf(proposal.vatAmount)} />
              <Row label="Bruttó" value={formatHuf(proposal.grossAmount)} />
              <Row
                label="Javasolt főkönyvi szám"
                value={`${proposal.suggestedAccount} — ${proposal.suggestedAccountName}`}
                highlight
              />
              <Row label="Költséghely" value={proposal.costCenter} />
            </dl>
          </Card>

          <div className="space-y-6">
            <Card title="Forrásdokumentum">
              <div className="rounded border border-slate-700 bg-slate-900/60 p-6 text-center">
                <div className="mx-auto mb-3 flex h-16 w-12 items-center justify-center rounded bg-red-900/40 text-red-400">
                  PDF
                </div>
                <p className="font-mono text-sm text-slate-300">
                  {proposal.sourceFileName}
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  Szimulált előnézet — valódi dokumentum nincs csatolva
                </p>
              </div>
            </Card>

            <Card title="Agent indoklás">
              <p className="text-sm leading-relaxed text-slate-300">
                {proposal.reasoning}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Badge variant="success">Audited</Badge>
                <Badge variant="mono">
                  Könyvelő Agent v{proposal.agentVersion}
                </Badge>
                <Badge variant="mono">{proposal.model}</Badge>
              </div>
            </Card>
          </div>
        </div>
      ) : (
        <Card title="Ticket napló">
          <p className="text-sm text-slate-400">
            Ez a ticket nem tartalmaz könyvelési javaslatot. Állapot:{' '}
            <strong className="text-slate-200">{ticket.status}</strong>
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Létrehozva: {new Date(ticket.createdAt).toLocaleString('hu-HU')}
          </p>
        </Card>
      )}

      {ticket.status === 'done' && (
        <div className="mt-6 rounded-lg border border-emerald-800/50 bg-emerald-950/20 p-4">
          <Badge variant="success">Done — naplózva</Badge>
          <p className="mt-2 text-sm text-emerald-200">
            A jóváhagyás append-only audit logba került. Minden lépés
            visszakereshető: ki, mi, mikor, melyik agent-verzió, milyen modell.
          </p>
        </div>
      )}
    </div>
  )
}

function Row({
  label,
  value,
  highlight,
}: {
  label: string
  value: string
  highlight?: boolean
}) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-700/40 pb-2">
      <dt className="text-slate-500">{label}</dt>
      <dd
        className={`text-right font-medium ${highlight ? 'text-emerald-300' : 'text-slate-200'}`}
      >
        {value}
      </dd>
    </div>
  )
}
