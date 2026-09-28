import { getTranslations } from 'next-intl/server'
import { RedeemInvitationForm } from '@/components/iam/redeem-invitation-form'

export default async function RedeemInvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  const t = await getTranslations('ControlPlane.redeem')
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">{t('title')}</h1>
        <p className="mt-1 text-ink-soft">{t('body')}</p>
      </div>

      <RedeemInvitationForm initialToken={token ?? ''} />
    </div>
  )
}
