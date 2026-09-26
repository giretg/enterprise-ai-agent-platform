import { getTranslations } from 'next-intl/server'
import { ChatSequence } from '@/components/public-site/signal-motion'

// Hero mock (scripted, loops): Hermes-style chat — Gmail complaint → KB policy → refund approval.
const agents = [
  { name: 'Kati', role: 'chatRoleKati', color: 'bg-[#ff4f8b]', icon: 'M3 11v2a1 1 0 001 1h2l5 4V6L6 10H4a1 1 0 00-1 1zm13-3a5 5 0 010 8m2.5-10.5a8.5 8.5 0 010 13' },
  { name: 'József', role: 'chatRoleJozsef', color: 'bg-[#f59e0b]', icon: 'M9 11a3 3 0 100-6 3 3 0 000 6zm-6 9a6 6 0 0112 0M16 5a3 3 0 010 6m2 9a6 6 0 00-3-5.2' },
  { name: 'Ádám', role: 'chatRoleAdam', color: 'bg-[#7c5cff]', icon: 'M8 8l-4 4 4 4m8-8l4 4-4 4M14 5l-4 14' },
  { name: 'Réka', role: 'chatRoleReka', color: 'bg-[#14b8a6]', icon: 'M4 6h16v12H4zM4 7l8 6 8-6' },
] as const

function Avatar({ agent, size = 'h-8 w-8' }: { agent: (typeof agents)[number]; size?: string }) {
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-lg text-white ${agent.color} ${size}`}>
      <svg viewBox="0 0 24 24" className="h-[55%] w-[55%]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={agent.icon} />
      </svg>
    </span>
  )
}

export async function AgentChatDemo() {
  const t = await getTranslations('Home')
  const reka = agents[3]
  const typing = (
    <span className="inline-flex gap-1 rounded-lg bg-card-2 px-3 py-2.5" aria-hidden>
      <span className="chat-typing-dot" />
      <span className="chat-typing-dot chat-typing-dot--2" />
      <span className="chat-typing-dot chat-typing-dot--3" />
    </span>
  )
  // Inline approval form, rendered by the client itself (no link to the platform).
  const approval = (state: 'pending' | 'pressed' | 'approved') => (
    <div className={`rounded-md border border-l-4 p-3 ${state === 'approved' ? 'border-sage bg-sage/5' : 'border-honey bg-honey/5'}`}>
      <p className={`text-[12px] font-semibold ${state === 'approved' ? 'text-sage' : 'text-honey'}`}>
        {state === 'approved' ? `✓ ${t('chatApprovedTitle')}` : `▲ ${t('chatApprovalTitle')}`}
      </p>
      <dl className="mt-2 grid grid-cols-[72px_1fr] gap-x-3 gap-y-0.5 text-[12px]">
        <dt className="font-mono text-[11px] uppercase text-ink-faint">{t('approvalTool')}</dt>
        <dd>{t('chatApprovalAction')}</dd>
        <dt className="font-mono text-[11px] uppercase text-ink-faint">{t('chatApprovalTo')}</dt>
        <dd className="truncate">{t('chatApprovalToValue')}</dd>
        <dt className="font-mono text-[11px] uppercase text-ink-faint">{t('chatApprovalSubject')}</dt>
        <dd className="truncate">{t('chatApprovalSubjectValue')}</dd>
      </dl>
      {state === 'approved' ? (
        <p className="mt-3 font-mono text-[11px] text-sage">{t('chatApprovedMeta')}</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span
            className={`rounded border border-sage bg-sage px-3 py-1.5 text-[12px] font-semibold text-white transition ${state === 'pressed' ? 'scale-95 ring-4 ring-sage/30' : ''}`}
          >
            {t('approvalApprove')}
          </span>
          <span className="rounded border border-ink bg-card px-3 py-1.5 text-[12px] font-semibold">{t('approvalReject')}</span>
          <span className="ml-auto font-mono text-[11px] text-ink-faint">{t('chatApprovalAudit')}</span>
        </div>
      )}
    </div>
  )

  return (
    <div className="overflow-hidden rounded-md border border-ink bg-card text-[13px] leading-relaxed shadow-[10px_10px_0_var(--color-coral)]">
      <div className="flex items-center gap-1.5 border-b border-line bg-card-2 px-3.5 py-2.5 text-ink-faint">
        <b className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
        <b className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
        <b className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-2 font-mono text-xs">{t('chatWindowTitle')}</span>
      </div>

      <div className="grid sm:grid-cols-[150px_1fr]">
        {/* Co-workers */}
        <ul className="flex gap-1 overflow-x-auto [scrollbar-width:none] border-b border-line p-2 sm:block sm:border-b-0 sm:border-r">
          {agents.map((a, i) => (
            <li key={a.name} className={`flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 ${i === 3 ? 'bg-card-2' : ''}`}>
              <Avatar agent={a} />
              <span className="min-w-0">
                <span className="block font-semibold">{a.name}</span>
                <span className="block truncate text-[11px] text-ink-faint">{t(a.role)}</span>
              </span>
            </li>
          ))}
        </ul>

        {/* Conversation with Réka (CRM) */}
        <div className="flex min-h-0 min-w-0 flex-col sm:h-[410px]">
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
            <Avatar agent={reka} size="h-6 w-6" />
            <span className="font-semibold">{reka.name}</span>
            <span className="text-ink-faint">· {t(reka.role)}</span>
            <span className="ml-auto h-2 w-2 rounded-full bg-sage" aria-hidden />
          </div>

          <div data-chat-scroll className="h-[320px] min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:h-auto">
            <div className="space-y-3">
            <ChatSequence
              delays={[700, 1100, 1500, 1200, 1400, 500, 900, 1100, 1200]}
              frames={[
                { from: 0, node: <p className="ml-auto w-fit max-w-[85%] rounded-lg bg-card-2 px-3 py-2">{t('chatUser')}</p> },
                { from: 1, to: 2, node: typing },
                {
                  from: 2,
                  node: (
                    <>
                      <p>{t('chatAgentGmail')}</p>
                      <dl className="mt-2 rounded-md border border-line bg-card-2 p-2.5 text-[12px]">
                        <dt className="font-mono text-[11px] uppercase text-ink-faint">{t('chatComplaintFrom')}</dt>
                        <dd className="mb-1 truncate">{t('chatComplaintFromValue')}</dd>
                        <dt className="font-mono text-[11px] uppercase text-ink-faint">{t('chatComplaintSubject')}</dt>
                        <dd className="mb-1 truncate">{t('chatComplaintSubjectValue')}</dd>
                        <dd className="mt-1 border-t border-line pt-1.5 text-ink-soft italic">{t('chatComplaintExcerpt')}</dd>
                      </dl>
                    </>
                  ),
                },
                { from: 3, to: 4, node: typing },
                {
                  from: 4,
                  node: (
                    <>
                      <p>{t('chatAgentKb')}</p>
                      <p className="mt-2">{t('chatAgentAsk')}</p>
                    </>
                  ),
                },
                { from: 5, to: 6, node: approval('pending') },
                { from: 6, to: 7, node: approval('pressed') },
                { from: 7, node: approval('approved') },
                { from: 8, to: 9, node: typing },
                { from: 9, node: <p>✓ {t('chatAgentDone')}</p> },
              ]}
            />
            </div>
          </div>

          <div className="mx-3 mb-3 mt-0 flex shrink-0 items-center gap-2 rounded-md border border-line px-3 py-2 text-ink-faint">
            <span>+</span>
            <span className="truncate">{t('chatComposer')}</span>
            <span className="ml-auto shrink-0 font-mono text-[11px]">Excellence AI</span>
          </div>
        </div>
      </div>
    </div>
  )
}
