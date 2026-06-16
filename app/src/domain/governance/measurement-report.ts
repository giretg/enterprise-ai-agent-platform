import type {
  AuditRepository,
  ModelCallRepository,
  TicketRepository,
  ToolBrokerRepository,
} from '@/repositories/interfaces'
import type { AuditChainService, VerifyResult } from '@/domain/audit/audit-chain-service'

export type MeasurementRange = 'today' | '7d' | '30d' | 'all'

export type MeasurementReport = {
  range: MeasurementRange
  generatedAt: Date
  since: Date | null
  /** §9.1/7 — válaszminőség */
  quality: {
    answered: number
    cited: number
    citationRate: number
    confidence: { high: number; medium: number; low: number; unknown: number }
  }
  /** §9.1/7 — átfutás */
  throughput: {
    avgLatencyMs: number
    answeredTickets: number
    avgCycleSeconds: number | null
    medianCycleSeconds: number | null
  }
  /** §9.1/7 — visszadobás / kontroll */
  control: {
    transitions: number
    approved: number
    rejected: number
    rejectionRate: number
    humanShare: number
  }
  /** §9.1/7 — költség / ticket */
  cost: {
    gatewayCalls: number
    tokens: number
    totalCost: number
    ticketedTickets: number
    avgCostPerTicket: number | null
  }
  gatewayStatus: { ok: number; error: number; rateLimited: number }
  tools: { calls: number; denied: number; errors: number }
  chain: VerifyResult
  perTicket: Array<{
    ticketId: string
    title: string
    calls: number
    toolCalls: number
    tokens: number
    cost: number
    avgLatencyMs: number
  }>
}

export type MeasurementReportDeps = {
  tickets: TicketRepository
  modelCalls: ModelCallRepository
  toolBroker: ToolBrokerRepository
  audit: AuditRepository
  auditChain: Pick<AuditChainService, 'verifyChain'>
}

function rangeToSince(range: MeasurementRange, now: Date): Date | null {
  if (range === 'all') return null
  if (range === 'today') {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    return d
  }
  const days = range === '7d' ? 7 : 30
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Builds the §9.1/7 measurement report from a real run's data: answer quality
 * (citation rate + confidence), throughput (latency + cycle time), rejection
 * rate and cost/ticket — all narrowed to the chosen time range. Reuses the
 * §11 governance aggregations and adds the ticket-payload quality dimension.
 */
export async function buildMeasurementReport(
  deps: MeasurementReportDeps,
  range: MeasurementRange = 'all',
  now: Date = new Date(),
): Promise<MeasurementReport> {
  const since = rangeToSince(range, now)
  const sinceArg = since ?? undefined

  const [model, tools, transitions, chain, breakdown, toolByTicket, allTickets] = await Promise.all([
    deps.modelCalls.getGovernanceSummary(sinceArg),
    deps.toolBroker.getToolSummary(sinceArg),
    deps.tickets.getTransitionStats(sinceArg),
    deps.auditChain.verifyChain(),
    deps.modelCalls.getPerTicketBreakdown(sinceArg, 1000),
    deps.toolBroker.getToolCallCountsByTicket(sinceArg),
    deps.tickets.findMany(),
  ])

  // Answer quality + cycle time from answered tickets in range.
  const confidence = { high: 0, medium: 0, low: 0, unknown: 0 }
  const cycleSeconds: number[] = []
  let answered = 0
  let cited = 0
  for (const ticket of allTickets) {
    if (since && ticket.createdAt < since) continue
    const payload = asRecord(ticket.payload)
    const answer = typeof payload.answer === 'string' ? payload.answer.trim() : ''
    if (!answer) continue
    answered += 1
    const sources = payload.sources
    if (Array.isArray(sources) && sources.length > 0) cited += 1
    const conf = typeof payload.confidence === 'string' ? payload.confidence : 'unknown'
    if (conf === 'high' || conf === 'medium' || conf === 'low') confidence[conf] += 1
    else confidence.unknown += 1
    const cycle = (ticket.updatedAt.getTime() - ticket.createdAt.getTime()) / 1000
    if (cycle >= 0) cycleSeconds.push(cycle)
  }

  const decisions = transitions.toApproved + transitions.toRejected
  const titleById = new Map(allTickets.map((t) => [t.id, t.title]))
  const ticketedTickets = breakdown.length
  const avgCostPerTicket = ticketedTickets > 0 ? model.cost / ticketedTickets : null
  const avgCycleSeconds =
    cycleSeconds.length > 0
      ? cycleSeconds.reduce((a, b) => a + b, 0) / cycleSeconds.length
      : null

  return {
    range,
    generatedAt: now,
    since,
    quality: {
      answered,
      cited,
      citationRate: answered > 0 ? cited / answered : 0,
      confidence,
    },
    throughput: {
      avgLatencyMs: model.avgLatencyMs,
      answeredTickets: answered,
      avgCycleSeconds,
      medianCycleSeconds: median(cycleSeconds),
    },
    control: {
      transitions: transitions.total,
      approved: transitions.toApproved,
      rejected: transitions.toRejected,
      rejectionRate: decisions > 0 ? transitions.toRejected / decisions : 0,
      humanShare: transitions.total > 0 ? transitions.byActor.human / transitions.total : 0,
    },
    cost: {
      gatewayCalls: model.calls,
      tokens: model.tokens,
      totalCost: model.cost,
      ticketedTickets,
      avgCostPerTicket,
    },
    gatewayStatus: { ok: model.okCalls, error: model.errorCalls, rateLimited: model.rateLimitedCalls },
    tools: { calls: tools.calls, denied: tools.denied, errors: tools.errors },
    chain,
    perTicket: breakdown.slice(0, 25).map((b) => ({
      ticketId: b.ticketId,
      title: titleById.get(b.ticketId) ?? '(ismeretlen ügy)',
      calls: b.calls,
      toolCalls: toolByTicket[b.ticketId] ?? 0,
      tokens: b.tokens,
      cost: b.cost,
      avgLatencyMs: b.avgLatencyMs,
    })),
  }
}

const RANGE_LABEL: Record<MeasurementRange, string> = {
  today: 'ma',
  '7d': 'elmúlt 7 nap',
  '30d': 'elmúlt 30 nap',
  all: 'teljes időszak',
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function eur(value: number): string {
  return `€${value.toFixed(4)}`
}

function seconds(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)} s`
}

/** Renders the §9.1/7 measurement report as a short written Markdown document. */
export function renderMeasurementMarkdown(report: MeasurementReport): string {
  const { quality, throughput, control, cost, gatewayStatus, tools, chain } = report
  const lines: string[] = []

  lines.push('# Mérési riport — AI Agent Platform MVP')
  lines.push('')
  lines.push(`*Elfogadási kritérium §9.1/7 — automatikusan generált egy valódi futás adataiból.*`)
  lines.push('')
  lines.push(`- **Időszak:** ${RANGE_LABEL[report.range]}`)
  lines.push(
    `- **Generálva:** ${report.generatedAt.toISOString()}${
      report.since ? ` (adatküszöb: ${report.since.toISOString()})` : ''
    }`,
  )
  lines.push(
    `- **Audit-lánc integritás:** ${
      chain.ok
        ? `✅ ép (verifyChain, ${chain.checked} bejegyzés)`
        : `❌ törött @ seq ${chain.firstBreakSeq}`
    }`,
  )
  lines.push('')

  lines.push('## Összefoglaló (KPI)')
  lines.push('')
  lines.push('| Dimenzió | Metrika | Érték |')
  lines.push('|---|---|---|')
  lines.push(`| Válaszminőség | Citált válaszok aránya | **${pct(quality.citationRate)}** (${quality.cited}/${quality.answered}) |`)
  lines.push(`| Átfutás | Átlagos Gateway-latency | **${throughput.avgLatencyMs} ms** |`)
  lines.push(`| Átfutás | Átlagos ügy-átfutás | **${seconds(throughput.avgCycleSeconds)}** (medián ${seconds(throughput.medianCycleSeconds)}) |`)
  lines.push(`| Visszadobás | Emberi visszadobási arány | **${pct(control.rejectionRate)}** (${control.rejected}/${control.approved + control.rejected}) |`)
  lines.push(`| Kontroll | Emberi lépés-arány | **${pct(control.humanShare)}** |`)
  lines.push(`| Költség | Becsült költség / ticket | **${cost.avgCostPerTicket === null ? '—' : eur(cost.avgCostPerTicket)}** |`)
  lines.push('')

  lines.push('## Válaszminőség (§11 Minőség)')
  lines.push('')
  lines.push(`- Megválaszolt ügyek: **${quality.answered}**`)
  lines.push(`- Citált (≥1 forrással): **${quality.cited}** → citáció-arány **${pct(quality.citationRate)}**`)
  lines.push(
    `- Confidence-eloszlás: high=${quality.confidence.high}, medium=${quality.confidence.medium}, low=${quality.confidence.low}, ismeretlen=${quality.confidence.unknown}`,
  )
  lines.push('')

  lines.push('## Hatékonyság / átfutás (§11 Hatékonyság)')
  lines.push('')
  lines.push(`- Átlagos Gateway-latency: **${throughput.avgLatencyMs} ms** (${cost.gatewayCalls} hívás)`)
  lines.push(`- Gateway-státusz: ok=${gatewayStatus.ok}, hiba=${gatewayStatus.error}, rate-limited=${gatewayStatus.rateLimited}`)
  lines.push(`- Ügy-átfutás (create→last update): átlag **${seconds(throughput.avgCycleSeconds)}**, medián **${seconds(throughput.medianCycleSeconds)}**`)
  lines.push('')

  lines.push('## Kontroll (§11 Kontroll)')
  lines.push('')
  lines.push(`- Átmenetek összesen: **${control.transitions}** (jóváhagyva ${control.approved}, elutasítva ${control.rejected})`)
  lines.push(`- Emberi visszadobási arány: **${pct(control.rejectionRate)}**`)
  lines.push(`- Emberi lépés-arány: **${pct(control.humanShare)}**`)
  lines.push(`- Tool Broker: ${tools.calls} hívás, ${tools.denied} tiltva, ${tools.errors} hiba`)
  lines.push('')

  lines.push('## Költség (§11 Költség)')
  lines.push('')
  lines.push(`- Becsült token: **${cost.tokens}**, becsült költség: **${eur(cost.totalCost)}**`)
  lines.push(`- Ticketezett ügyek: **${cost.ticketedTickets}**, átlag költség/ticket: **${cost.avgCostPerTicket === null ? '—' : eur(cost.avgCostPerTicket)}**`)
  lines.push('')

  if (report.perTicket.length > 0) {
    lines.push('## Ticketenkénti lebontás (top 25)')
    lines.push('')
    lines.push('| Ügy | Gateway-hívás | Tool-hívás | Token | Átlag latency | Költség |')
    lines.push('|---|---:|---:|---:|---:|---:|')
    for (const t of report.perTicket) {
      const title = t.title.length > 40 ? `${t.title.slice(0, 39)}…` : t.title
      lines.push(
        `| ${title} | ${t.calls} | ${t.toolCalls} | ${t.tokens} | ${t.avgLatencyMs} ms | ${eur(t.cost)} |`,
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}
