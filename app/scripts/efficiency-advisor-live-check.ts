/**
 * EFF-13 — éles-adat visszaellenőrzés. Csak státuszt, mérőszámot és agent-nevet ír.
 * Nem CI: a `DATABASE_URL` mögötti tenansok agentjeit olvassa.
 * Futtatás (az `app/` könyvtárból): npx tsx scripts/efficiency-advisor-live-check.ts
 */
import { loadEfficiencyAdvisorCard } from '../src/domain/agent/efficiency-advisor-query'
import { describeEfficiencyStatus } from '../src/domain/agent/efficiency-advisor'
import { prisma } from '../src/lib/db'

const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

async function main() {
  const agents = await prisma.agent.findMany({
    select: { id: true, name: true, tenantId: true },
    orderBy: { name: 'asc' },
  })

  const rows = []
  for (const agent of agents) {
    if (!agent.tenantId) continue
    const modelCalls = await prisma.modelCall.count({
      where: { agentId: agent.id, createdAt: { gte: since } },
    })
    const view = await loadEfficiencyAdvisorCard({ agentId: agent.id, tenantId: agent.tenantId })
    const { card } = view
    rows.push({
      agent: agent.name,
      modelCalls,
      status: card.status,
      statusText: describeEfficiencyStatus(card.status),
      analyzableRuns: card.analyzableRuns,
      coarseOnly: card.coarseOnly,
      patterns: card.patterns.map((pattern) => pattern.kind),
      totalTokens: card.breakdown.total,
      bandWithinCost: card.patterns.every(
        (pattern) => !pattern.savingsTokens || pattern.savingsTokens.high <= card.breakdown.total,
      ),
    })
  }

  console.log(
    JSON.stringify(
      {
        windowDays: 30,
        ok: rows.filter((row) => row.status === 'ok').map((row) => row.agent),
        findings: rows
          .filter((row) => row.status === 'findings')
          .map((row) => ({ agent: row.agent, patterns: row.patterns, runs: row.analyzableRuns })),
        insufficient: rows
          .filter((row) => row.status === 'insufficient_data')
          .map((row) => ({ agent: row.agent, calls: row.modelCalls, runs: row.analyzableRuns })),
        agents: rows,
      },
      null,
      2,
    ),
  )
  await prisma.$disconnect()
}

void main()
