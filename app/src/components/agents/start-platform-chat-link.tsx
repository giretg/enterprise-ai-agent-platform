import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { platformChatHref } from '@/lib/platform-chat-href'

/** Korall gomb a munkatárs-kártyán és az adatlapon: megnyitja a platform-chatet ezzel az agenttel. */
export async function StartPlatformChatLink({
  agentId,
  size = 'sm',
}: {
  agentId: string
  size?: 'sm' | 'md'
}) {
  const t = await getTranslations('ControlPlane.agents')
  const sizeClass = size === 'md' ? 'px-4 py-1.5 text-sm' : 'px-3.5 py-1.5 text-xs'
  return (
    <Link
      href={platformChatHref(agentId)}
      title={t('startChatHint')}
      className={`inline-flex items-center rounded-full bg-coral font-semibold text-white hover:bg-coral/90 ${sizeClass}`}
    >
      {t('startChat')}
    </Link>
  )
}
