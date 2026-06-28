import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser } from '@/auth'
import { hasMinimumRole } from '@/auth/types'
import { getProcessDetail } from '@/app/actions/process'
import { ProcessDetailView, type ProcessDetailData } from '@/components/processes/process-detail-view'

export default async function ProcessDetailPage({
  params,
}: {
  params: Promise<{ processId: string }>
}) {
  const { processId } = await params
  const [user, detailRes] = await Promise.all([getCurrentUser(), getProcessDetail({ id: processId })])
  if (!detailRes.success) notFound()

  const canAct = user ? hasMinimumRole(user.role, 'operator') : false
  const data = detailRes.data as ProcessDetailData

  return (
    <div className="space-y-6">
      <Link href="/control-plane/processes" className="text-sm text-ink-soft hover:text-accent">
        ← Folyamatok
      </Link>
      <ProcessDetailView data={data} canAct={canAct} />
    </div>
  )
}
