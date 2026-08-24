import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getAuthContext } from '@/auth/context'
import { hasMinimumRole } from '@/auth/types'
import { getProcessDetail } from '@/app/actions/process'
import { ProcessDetailView, type ProcessDetailData } from '@/components/processes/process-detail-view'
import { resolveRunAnalysisEntry } from '@/lib/run-analysis-entry'

export default async function ProcessDetailPage({
  params,
}: {
  params: Promise<{ processId: string }>
}) {
  const { processId } = await params
  const [ctx, detailRes] = await Promise.all([getAuthContext(), getProcessDetail({ id: processId })])
  if (!detailRes.success) notFound()

  const canAct = hasMinimumRole(ctx?.activeTenantRole, 'operator')
  const runAnalysisEntry =
    ctx?.activeTenantId && ctx.activeTenantRole
      ? await resolveRunAnalysisEntry({
          tenantId: ctx.activeTenantId,
          role: ctx.activeTenantRole,
          userId: ctx.user.id,
        })
      : { canRunAnalysis: false, runAnalystAgentId: null }
  const data = detailRes.data as ProcessDetailData

  return (
    <div className="space-y-6">
      <Link href="/control-plane/processes" className="text-sm text-ink-soft hover:text-accent">
        ← Folyamatok
      </Link>
      <ProcessDetailView
        data={data}
        canAct={canAct}
        canRunAnalysis={runAnalysisEntry.canRunAnalysis}
        runAnalystAgentId={runAnalysisEntry.runAnalystAgentId}
      />
    </div>
  )
}
