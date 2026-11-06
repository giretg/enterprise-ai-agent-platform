import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { platformChatHref } from '@/lib/platform-chat-href'

/** Szövegbuborék-ikon a munkatárs-kártyán és az adatlapon: megnyitja a platform-chatet ezzel az agenttel. */
export async function StartPlatformChatLink({ agentId, agentName }: { agentId: string; agentName: string }) {
  const t = await getTranslations('ControlPlane.agents')
  return (
    <Link
      href={platformChatHref(agentId)}
      aria-label={`${t('startChat')}: ${agentName}`}
      title={t('startChatHint')}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-coral text-white transition hover:bg-coral/90"
    >
      <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20.5l1.6-5.2A8.5 8.5 0 1 1 21 11.5" />
      </svg>
    </Link>
  )
}
