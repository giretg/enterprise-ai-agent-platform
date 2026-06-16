/**
 * Mérési riport generátor (§9.1/7, Epik 8).
 * Egy valódi futás adataiból rövid, írott Markdown riportot készít:
 * válaszminőség (citáció-arány), átfutás (latency + ügy-átfutás),
 * visszadobási arány és költség/ticket — a §11 governance dimenziók mentén.
 *
 * Futtatás:
 *   npm run report:measurement                # teljes időszak, reports/measurement-report.md
 *   npm run report:measurement -- --range=7d  # elmúlt 7 nap
 *   npm run report:measurement -- --range=today --out=/tmp/report.md
 */
import { mkdir, writeFile } from 'fs/promises'
import { dirname, resolve } from 'path'
import { config } from 'dotenv'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

import { repositories } from '../src/repositories/postgres'
import { services } from '../src/domain'
import {
  buildMeasurementReport,
  renderMeasurementMarkdown,
  type MeasurementRange,
} from '../src/domain/governance/measurement-report'

function parseArgs(argv: string[]): { range: MeasurementRange; out: string } {
  let range: MeasurementRange = 'all'
  let out = resolve(process.cwd(), 'reports/measurement-report.md')
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=')
    if (key === 'range' && ['today', '7d', '30d', 'all'].includes(value)) {
      range = value as MeasurementRange
    } else if (key === 'out' && value) {
      out = resolve(process.cwd(), value)
    }
  }
  return { range, out }
}

async function main() {
  const { range, out } = parseArgs(process.argv.slice(2))

  const report = await buildMeasurementReport(
    {
      tickets: repositories.tickets,
      modelCalls: repositories.modelCalls,
      toolBroker: repositories.toolBroker,
      audit: repositories.audit,
      auditChain: services.auditChain,
    },
    range,
  )

  const markdown = renderMeasurementMarkdown(report)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, `${markdown}\n`, 'utf8')

  console.log(markdown)
  console.log(`\n→ Riport mentve: ${out}`)
}

main()
  .catch((err) => {
    console.error('Mérési riport hiba:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    const { prisma } = await import('../src/lib/db')
    await prisma.$disconnect()
  })
