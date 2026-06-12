import { Link, useNavigate, useParams } from 'react-router-dom'
import { Badge } from '../../shared/components/Badge'
import { Card } from '../../shared/components/Card'
import { useDemo } from '../../shared/context/DemoContext'
import { demoProposalTemplate } from '../../shared/mock-data'

function formatHuf(amount: number): string {
  return `${amount.toLocaleString('hu-HU')} Ft`
}

export function ProposalDetailPage() {
  const { proposalId } = useParams<{ proposalId: string }>()
  const navigate = useNavigate()
  const { currentProposal, sendForApproval } = useDemo()

  const proposal =
    currentProposal?.id === proposalId
      ? currentProposal
      : proposalId
        ? { ...demoProposalTemplate, id: proposalId }
        : null

  if (!proposal) {
    return (
      <div className="text-center">
        <p className="text-slate-400">Javaslat nem található</p>
        <Link to="/sandbox" className="mt-4 inline-block text-teal-400">
          ← Munkatér
        </Link>
      </div>
    )
  }

  const handleSend = () => {
    const ticketId = sendForApproval(proposal)
    navigate(`/control-plane/tickets/${ticketId}`)
  }

  return (
    <div>
      <Link
        to="/sandbox"
        className="mb-4 inline-block text-sm text-slate-400 hover:text-slate-200"
      >
        ← Munkatér
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex flex-wrap gap-2">
            <Badge variant="success">Feldolgozás kész</Badge>
            <Badge variant="mono">
              Könyvelő Agent v{proposal.agentVersion}
            </Badge>
          </div>
          <h1 className="text-xl font-semibold text-slate-50">
            {proposal.supplier} — {proposal.invoiceNumber}
          </h1>
        </div>
        <button
          type="button"
          onClick={handleSend}
          className="rounded-md bg-teal-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-teal-600"
        >
          Küldés jóváhagyásra →
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Kinyert mezők">
          <dl className="space-y-3 text-sm">
            <Row label="Szállító" value={proposal.supplier} />
            <Row label="Számlaszám" value={proposal.invoiceNumber} />
            <Row label="Kiállítás dátuma" value={proposal.date} />
            <Row label="Nettó összeg" value={formatHuf(proposal.netAmount)} />
            <Row label="ÁFA (27%)" value={formatHuf(proposal.vatAmount)} />
            <Row label="Bruttó összeg" value={formatHuf(proposal.grossAmount)} />
          </dl>
        </Card>

        <Card title="Könyvelési javaslat">
          <dl className="space-y-3 text-sm">
            <Row
              label="Főkönyvi szám"
              value={`${proposal.suggestedAccount} — ${proposal.suggestedAccountName}`}
              highlight
            />
            <Row label="Költséghely" value={proposal.costCenter} />
          </dl>
          <div className="mt-4 border-t border-slate-700/60 pt-4">
            <p className="text-xs font-medium uppercase text-slate-500">
              Agent indoklás
            </p>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">
              {proposal.reasoning}
            </p>
          </div>
        </Card>

        <Card title="Eredeti dokumentum" className="lg:col-span-2">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded border border-slate-700 bg-white/5 p-6 text-center">
              <p className="font-mono text-sm text-slate-300">
                {proposal.sourceFileName}
              </p>
              <p className="mt-4 text-xs text-slate-500">
                Szimulált PDF előnézet
              </p>
            </div>
            <div className="rounded border border-teal-800/40 bg-teal-950/20 p-4">
              <p className="text-sm font-medium text-teal-200">
                Mi történik „Küldés jóváhagyásra” után?
              </p>
              <ol className="mt-2 list-inside list-decimal space-y-1 text-xs text-teal-300/80">
                <li>Ticket jön létre a Control Plane boardon</li>
                <li>Állapot: Awaiting Human</li>
                <li>Emberi jóváhagyás szükséges (human-in-the-loop)</li>
                <li>Minden lépés audit logba kerül</li>
              </ol>
            </div>
          </div>
        </Card>
      </div>
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
        className={`text-right font-medium ${highlight ? 'text-teal-300' : 'text-slate-200'}`}
      >
        {value}
      </dd>
    </div>
  )
}
