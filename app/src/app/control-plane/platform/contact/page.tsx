import { getTranslations } from 'next-intl/server'
import { listContactInquiries } from '@/app/actions/contact-inquiries'
import { getAuthContext } from '@/auth/context'
import { ContactInboxPanel } from '@/components/contact/contact-inbox-panel'

export default async function PlatformContactPage() {
  const [res, ctx] = await Promise.all([listContactInquiries(), getAuthContext()])
  const t = await getTranslations('PlatformContact')

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <h1 className="mt-2 font-display text-3xl font-semibold">{t('title')}</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">{t('body')}</p>
      </header>
      {res.success ? (
        <ContactInboxPanel
          inquiries={res.data}
          canManage={Boolean(ctx?.platformRoles.includes('superadmin'))}
        />
      ) : (
        <div className="rounded-xl border border-coral/25 bg-coral/5 p-4 text-sm text-coral-deep">{t('loadError')}</div>
      )}
    </div>
  )
}
