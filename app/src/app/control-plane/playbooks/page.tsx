import { getCurrentUser } from '@/auth'
import { hasMinimumRole } from '@/auth/types'
import { listPlaybooksV2 } from '@/app/actions/playbook'
import { PlaybookRegistry, type PlaybookListView } from '@/components/playbooks/playbook-registry'

export default async function PlaybooksPage() {
  const [user, res] = await Promise.all([getCurrentUser(), listPlaybooksV2()])
  const canEdit = user ? hasMinimumRole(user.role, 'admin') : false
  const playbooks: PlaybookListView[] = res.success ? res.data : []

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">Playbook</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">Playbookok</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Verziózott, gépiesen olvasható folyamatleírások. A published verzió immutable és pin-elhető;
          a kötelező kapuk forrása. A draft validálható, jóváhagyásra küldhető, majd approver publikálja.
        </p>
      </div>
      {!res.success && (
        <p className="rounded-lg border border-coral/30 bg-coral/10 px-4 py-2 text-sm text-coral">
          Nem sikerült betölteni: {res.error}
        </p>
      )}
      <PlaybookRegistry playbooks={playbooks} canEdit={canEdit} />
    </div>
  )
}
