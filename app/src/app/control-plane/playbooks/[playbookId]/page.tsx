import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getAuthContext } from '@/auth/context'
import { hasMinimumRole } from '@/auth/types'
import { getPlaybookV2 } from '@/app/actions/playbook'
import {
  PlaybookDetail,
  type VersionView,
  type PlaybookHead,
} from '@/components/playbooks/playbook-detail'

export default async function PlaybookDetailPage({
  params,
}: {
  params: Promise<{ playbookId: string }>
}) {
  const { playbookId } = await params
  const [ctx, res] = await Promise.all([getAuthContext(), getPlaybookV2({ id: playbookId })])
  if (!res.success) notFound()

  const canEdit = hasMinimumRole(ctx?.activeTenantRole, 'admin')
  const canApprove = hasMinimumRole(ctx?.activeTenantRole, 'approver')

  const playbook: PlaybookHead = {
    id: res.data.playbook.id,
    key: res.data.playbook.key,
    name: res.data.playbook.name,
    description: res.data.playbook.description ?? null,
    processType: res.data.playbook.processType,
    status: res.data.playbook.status,
  }
  const versions: VersionView[] = res.data.versions.map((v) => ({
    id: v.id,
    version: v.version,
    status: v.status,
    changeSummary: v.changeSummary,
    contentHash: v.contentHash,
    spec: v.spec,
    layout: v.layout,
    validationResult: v.validationResult,
    publishedAt: v.publishedAt,
    createdAt: v.createdAt,
  }))

  return (
    <div className="space-y-6">
      <Link href="/control-plane/playbooks" className="text-sm text-ink-soft hover:text-accent">
        ← Playbookok
      </Link>
      <PlaybookDetail
        playbook={playbook}
        versions={versions}
        canEdit={canEdit}
        canApprove={canApprove}
      />
    </div>
  )
}
