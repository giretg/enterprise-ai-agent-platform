import { NextResponse } from 'next/server'
import { requireRole } from '@/auth'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import {
  buildMeasurementReport,
  renderMeasurementMarkdown,
  type MeasurementRange,
} from '@/domain/governance/measurement-report'

function parseRange(value: string | null): MeasurementRange {
  return value === 'today' || value === '7d' || value === '30d' || value === 'all' ? value : 'all'
}

/**
 * Mérési riport (§9.1/7) letöltése Markdown fájlként a governance oldalról.
 * A live dashboard ugyanazokra az aggregációkra épül; ez az írott, exportálható
 * változat egy valódi futás adataiból.
 */
export async function GET(request: Request) {
  try {
    await requireRole('viewer')
    const range = parseRange(new URL(request.url).searchParams.get('range'))

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
    return new NextResponse(`${markdown}\n`, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="meresi-riport-${range}.md"`,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : 'Report failed' },
      { status: 403 },
    )
  }
}
