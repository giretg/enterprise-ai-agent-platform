import { getTranslations } from 'next-intl/server'

// Static hero mock: a Hermes-style chat with company AI co-workers, where an
// outbound action is approved inline in the client (no link to the platform).
const agents = [
  { name: 'Kati', role: 'chatRoleKati', color: 'bg-[#ff4f8b]', icon: 'M3 11v2a1 1 0 001 1h2l5 4V6L6 10H4a1 1 0 00-1 1zm13-3a5 5 0 010 8m2.5-10.5a8.5 8.5 0 010 13' },
  { name: 'József', role: 'chatRoleJozsef', color: 'bg-[#f59e0b]', icon: 'M9 11a3 3 0 100-6 3 3 0 000 6zm-6 9a6 6 0 0112 0M16 5a3 3 0 010 6m2 9a6 6 0 00-3-5.2' },
  { name: 'Ádám', role: 'chatRoleAdam', color: 'bg-[#7c5cff]', icon: 'M8 8l-4 4 4 4m8-8l4 4-4 4M14 5l-4 14' },
  { name: 'Réka', role: 'chatRoleReka', color: 'bg-[#14b8a6]', icon: 'M4 6h16v12H4zM4 7l8 6 8-6' },
] as const

const stats = [
  ['chatStatVisitors', '12 480', '+18%'],
  ['chatStatConversion', '3,4%', '+0,6'],
  ['chatStatCpa', '4 120 Ft', '−12%'],
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
  const kati = agents[0]

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
            <li key={a.name} className={`flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 ${i === 0 ? 'bg-card-2' : ''}`}>
              <Avatar agent={a} />
              <span className="min-w-0">
                <span className="block font-semibold">{a.name}</span>
                <span className="block truncate text-[11px] text-ink-faint">{t(a.role)}</span>
              </span>
            </li>
          ))}
        </ul>

        {/* Conversation with Kati */}
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <Avatar agent={kati} size="h-6 w-6" />
            <span className="font-semibold">{kati.name}</span>
            <span className="text-ink-faint">· {t(kati.role)}</span>
            <span className="ml-auto h-2 w-2 rounded-full bg-sage" aria-hidden />
          </div>

          <div className="space-y-3 px-4 py-4">
            <p className="ml-auto w-fit max-w-[85%] rounded-lg bg-card-2 px-3 py-2">{t('chatUser')}</p>

            <div>
              <p>{t('chatAgentIntro')}</p>
              <table className="mt-2 w-full border border-line text-[12px]">
                <tbody>
                  {stats.map(([key, value, delta]) => (
                    <tr key={key} className="border-b border-line last:border-0">
                      <td className="px-2.5 py-1.5 text-ink-soft">{t(key)}</td>
                      <td className="px-2.5 py-1.5 text-right font-semibold">{value}</td>
                      <td className="px-2.5 py-1.5 text-right font-mono text-sage">{delta}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2">{t('chatAgentAsk')}</p>
            </div>

            {/* Inline approval form, rendered by the client itself */}
            <div className="rounded-md border border-l-4 border-honey bg-honey/5 p-3">
              <p className="text-[12px] font-semibold text-honey">▲ {t('chatApprovalTitle')}</p>
              <dl className="mt-2 grid grid-cols-[72px_1fr] gap-x-3 gap-y-0.5 text-[12px]">
                <dt className="font-mono text-[11px] uppercase text-ink-faint">{t('approvalTool')}</dt>
                <dd>{t('chatApprovalAction')}</dd>
                <dt className="font-mono text-[11px] uppercase text-ink-faint">{t('chatApprovalTo')}</dt>
                <dd className="truncate">{t('chatApprovalToValue')}</dd>
                <dt className="font-mono text-[11px] uppercase text-ink-faint">{t('chatApprovalSubject')}</dt>
                <dd className="truncate">{t('chatApprovalSubjectValue')}</dd>
              </dl>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="rounded border border-sage bg-sage px-3 py-1.5 text-[12px] font-semibold text-white">{t('approvalApprove')}</span>
                <span className="rounded border border-ink bg-card px-3 py-1.5 text-[12px] font-semibold">{t('approvalReject')}</span>
                <span className="ml-auto font-mono text-[11px] text-ink-faint">{t('chatApprovalAudit')}</span>
              </div>
            </div>
          </div>

          <div className="mx-3 mb-3 mt-auto flex items-center gap-2 rounded-md border border-line px-3 py-2 text-ink-faint">
            <span>+</span>
            <span className="truncate">{t('chatComposer')}</span>
            <span className="ml-auto shrink-0 font-mono text-[11px]">Excellence AI</span>
          </div>
        </div>
      </div>
    </div>
  )
}
