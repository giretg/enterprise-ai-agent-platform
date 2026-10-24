import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import {
  getWikiAgentAccessAction,
  getWikiOverviewAction,
  getWikiPageAction,
  getWikiSettingsAction,
  getWikiSourceAction,
  listWikiInboxAction,
} from '@/app/actions/knowledge-wiki'
import { Badge, Card } from '@/components/ui/shell'
import { WikiInboxPanel } from '@/components/knowledge/wiki/wiki-inbox-panel'
import { WikiMarkdown } from '@/components/knowledge/wiki/wiki-markdown'
import { WikiAgentAccessEditor } from '@/components/knowledge/wiki/wiki-agent-access-editor'
import { WikiOwnerActions } from '@/components/knowledge/wiki/wiki-owner-actions'
import { WikiSettingsPanel } from '@/components/knowledge/wiki/wiki-settings-panel'
import { formatWhen, wikiHref } from '@/components/knowledge/wiki/wiki-format'
import { HelpHint } from '@/components/onboarding/onboarding-ui'

export const dynamic = 'force-dynamic'

const TABS = ['wiki', 'inbox', 'log', 'access', 'settings'] as const
type Tab = (typeof TABS)[number]

export default async function KnowledgeBaseWikiPage({
  params,
  searchParams,
}: {
  params: Promise<{ connectorId: string }>
  searchParams: Promise<{ tab?: string; page?: string; source?: string; p?: string }>
}) {
  const { connectorId } = await params
  const query = await searchParams
  const t = await getTranslations('ControlPlane.wiki')
  const locale = await getLocale()

  const overviewRes = await getWikiOverviewAction({ connectorId })
  if (!overviewRes.success) {
    if (overviewRes.error === 'forbidden') {
      return (
        <Card>
          <p className="text-sm text-ink-soft">{t('errors.forbidden')}</p>
        </Card>
      )
    }
    notFound()
  }
  const wiki = overviewRes.data
  const tabs = TABS.filter((tab) => tab !== 'settings' || wiki.canManage)
  const tab: Tab = (tabs as readonly string[]).includes(query.tab ?? '') ? (query.tab as Tab) : 'wiki'

  return (
    <div className="space-y-6">
      <Link href="/control-plane/knowledge" className="inline-flex items-center gap-1 text-sm font-medium text-ink-soft hover:text-ink">
        {t('back')}
      </Link>
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="font-display text-3xl font-semibold" data-testid="wiki-title">{wiki.name}</h1>
          <Badge tone={wiki.private ? 'warning' : 'neutral'}>{t(`kind.${wiki.kind}`)}</Badge>
          <Badge tone="neutral">{t(`templates.${wiki.template}.name`)}</Badge>
        </div>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          {wiki.private ? t('header.privateBody') : t('header.body')}
        </p>
        <WhoSees wiki={wiki} connectorId={connectorId} t={t} />
      </div>

      <nav className="flex flex-wrap gap-1 border-b border-line/70" aria-label={t('tabsAria')}>
        {tabs.map((id) => (
          <Link
            key={id}
            href={wikiHref(connectorId, { tab: id })}
            data-testid={`wiki-tab-${id}`}
            className={`-mb-px rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium ${
              tab === id ? 'border-coral text-coral-deep' : 'border-transparent text-ink-soft hover:text-ink'
            }`}
          >
            {t(`tabs.${id}`)}
            {id === 'inbox' && wiki.inbox.pending + wiki.inbox.inProgress > 0 ? (
              <span className="ml-1 rounded-full bg-coral/10 px-1.5 text-xs text-coral-deep">
                {wiki.inbox.pending + wiki.inbox.inProgress}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>

      {tab === 'wiki' ? (
        <WikiTab connectorId={connectorId} wiki={wiki} query={query} t={t} locale={locale} />
      ) : null}
      {tab === 'inbox' ? <InboxTab connectorId={connectorId} /> : null}
      {tab === 'log' ? (
        <Card title={t('log.title')}>
          <p className="mb-3 text-sm text-ink-soft">{t('log.intro')}</p>
          {wiki.log.length === 0 ? (
            <p className="text-sm text-ink-soft">{t('log.empty')}</p>
          ) : (
            <ol className="relative space-y-4 border-l border-line pl-4" data-testid="wiki-log">
              {wiki.log.map((entry) => (
                <li key={entry.id}>
                  <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border border-line bg-card" />
                  <p className="text-xs text-ink-faint">
                    {formatWhen(entry.createdAt, locale)} · {t(`log.ops.${entry.op}`)}
                    {entry.actor ? ` · ${entry.actor.name ?? '—'}${entry.actor.kind === 'agent' ? ` (${t('authorAgent')})` : ''}` : ''}
                  </p>
                  <p className="text-sm font-medium text-ink">{entry.title}</p>
                  {entry.note ? <p className="text-sm text-ink-soft">{entry.note}</p> : null}
                  {entry.pagePaths.length ? (
                    <p className="mt-1 flex flex-wrap gap-1 text-xs">
                      {entry.pagePaths.map((path) => (
                        <Link key={path} href={wikiHref(connectorId, { page: path })} className="rounded bg-ink/5 px-1.5 py-0.5 text-ink-soft hover:text-coral-deep">
                          {path}
                        </Link>
                      ))}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </Card>
      ) : null}
      {tab === 'access' ? <AccessTab connectorId={connectorId} /> : null}
      {tab === 'settings' && wiki.canManage ? <SettingsTab connectorId={connectorId} name={wiki.name} isPrivate={wiki.private} /> : null}
    </div>
  )
}

type Overview = Extract<Awaited<ReturnType<typeof getWikiOverviewAction>>, { success: true }>['data']
type T = Awaited<ReturnType<typeof getTranslations<'ControlPlane.wiki'>>>

async function WikiTab({
  connectorId,
  wiki,
  query,
  t,
  locale,
}: {
  connectorId: string
  wiki: Overview
  query: { page?: string; source?: string; p?: string }
  t: T
  locale: string
}) {
  const toc = (
    <Card className="lg:sticky lg:top-4">
      <div className="mb-2 flex items-center">
        <h2 className="font-display text-lg font-semibold">{t('toc.title')}</h2>
        <HelpHint>{t('toc.help')}</HelpHint>
      </div>
      {wiki.pageCount === 0 ? (
        <p className="text-sm text-ink-soft" data-testid="wiki-empty">{t('toc.empty')}</p>
      ) : (
        <div className="space-y-3" data-testid="wiki-toc">
          {wiki.categories.map((group) => (
            <div key={group.category}>
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
                {group.category === 'Uncategorized' ? t('toc.uncategorized') : group.category}
              </p>
              <ul className="mt-1 space-y-0.5">
                {group.pages.map((page) => (
                  <li key={page.path}>
                    <Link
                      href={wikiHref(connectorId, { page: page.path })}
                      className={`block truncate rounded px-1.5 py-0.5 text-sm hover:bg-coral/5 ${
                        query.page === page.path ? 'bg-coral/10 font-medium text-coral-deep' : 'text-ink'
                      }`}
                      title={page.summary}
                    >
                      {page.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  )

  let main: React.ReactNode
  if (query.source) {
    const res = await getWikiSourceAction({ connectorId, documentId: query.source })
    main = res.success ? (
      <SourceView connectorId={connectorId} source={res.data} page={query.p} t={t} locale={locale} />
    ) : (
      <Card><p className="text-sm text-ink-soft">{t('source.notFound')}</p></Card>
    )
  } else if (query.page) {
    const res = await getWikiPageAction({ connectorId, path: query.page })
    main = res.success ? (
      <Card>
        <article data-testid="wiki-page">
          <p className="text-xs text-ink-faint">{res.data.path}</p>
          <h2 className="mt-1 font-display text-2xl font-semibold">{res.data.title}</h2>
          {res.data.summary ? <p className="mt-1 text-ink-soft">{res.data.summary}</p> : null}
          <p className="mt-2 text-xs text-ink-faint">
            {res.data.author
              ? t('page.writtenBy', {
                  name: res.data.author.name ?? '—',
                  kind: res.data.author.kind === 'agent' ? t('authorAgent') : t('authorHuman'),
                })
              : null}
            {' · '}
            {t('page.updated', { when: formatWhen(res.data.updatedAt, locale), version: res.data.version })}
            {res.data.status === 'archived' ? ` · ${t('page.archived')}` : ''}
          </p>
          <div className="mt-4">
            <WikiMarkdown connectorId={connectorId} body={res.data.body} knownPaths={res.data.knownPaths} />
          </div>
          {res.data.sources.length ? (
            <div className="mt-6 border-t border-line/70 pt-3">
              <p className="mb-1 flex items-center text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
                {t('page.sources')}
                <HelpHint>{t('page.sourcesHelp')}</HelpHint>
              </p>
              <ul className="space-y-1 text-sm" data-testid="wiki-page-sources">
                {res.data.sources.map((ref, index) => (
                  <li key={`${ref.documentId}-${index}`}>
                    {ref.exists ? (
                      <Link
                        href={`${wikiHref(connectorId, { source: ref.documentId, p: ref.page ? String(ref.page) : undefined })}${ref.page ? `#p-${ref.page}` : ''}`}
                        className="text-coral-deep hover:underline"
                      >
                        {ref.filename ?? ref.documentId}
                        {ref.page ? `, ${t('page.pageN', { n: ref.page })}` : ''}
                        {ref.section ? ` · ${ref.section}` : ''}
                      </Link>
                    ) : (
                      <span className="text-ink-faint">{ref.filename ?? ref.documentId} ({t('page.sourceMissing')})</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {res.data.revisions.length > 1 ? (
            <details className="mt-4 border-t border-line/70 pt-3">
              <summary className="cursor-pointer text-sm text-ink-soft">{t('page.history', { count: res.data.revisions.length })}</summary>
              <ul className="mt-2 space-y-1 text-xs text-ink-soft">
                {res.data.revisions.map((rev) => (
                  <li key={rev.version}>
                    v{rev.version} · {formatWhen(rev.createdAt, locale)} · {rev.title}
                    {rev.current ? ` (${t('page.current')})` : ''}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-ink-faint">{t('page.restoreLater')}</p>
            </details>
          ) : null}
        </article>
      </Card>
    ) : (
      <Card><p className="text-sm text-ink-soft">{t('page.notFound')}</p></Card>
    )
  } else {
    main = (
      <Card>
        <h2 className="font-display text-lg font-semibold">{t('overview.title')}</h2>
        <p className="mt-2 text-sm text-ink-soft">
          {wiki.pageCount === 0 ? t('overview.empty') : t('overview.body', { pages: wiki.pageCount })}
        </p>
        <ul className="mt-3 space-y-1 text-sm text-ink-soft">
          <li>{t('overview.inbox', { pending: wiki.inbox.pending, inProgress: wiki.inbox.inProgress })}</li>
          <li>{t('overview.writers', { count: wiki.access.filter((row) => row.access === 'write').length })}</li>
        </ul>
      </Card>
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <div>{toc}</div>
      <div className="min-w-0">{main}</div>
    </div>
  )
}

function SourceView({
  connectorId,
  source,
  page,
  t,
  locale,
}: {
  connectorId: string
  source: { documentId: string; filename: string; text: string; createdAt: string }
  page?: string
  t: T
  locale: string
}) {
  // A PDF-kinyerés oldalanként `# Oldal N` fejlécet ír; erre ugrunk.
  const sections = source.text.split(/\n(?=# Oldal \d+\n)/)
  return (
    <Card>
      <p className="text-xs text-ink-faint">{t('source.eyebrow')}</p>
      <h2 className="mt-1 font-display text-xl font-semibold">{source.filename}</h2>
      <p className="mt-1 text-xs text-ink-faint">{t('source.uploaded', { when: formatWhen(source.createdAt, locale) })}</p>
      <p className="mt-2 text-xs text-ink-faint">{t('source.help')}</p>
      <div className="mt-4 space-y-4" data-testid="wiki-source">
        {sections.map((section, index) => {
          const match = /^# Oldal (\d+)\n/.exec(section)
          const n = match?.[1]
          return (
            <section
              key={index}
              id={n ? `p-${n}` : undefined}
              className={`whitespace-pre-wrap break-words rounded-lg p-2 text-sm text-ink ${n && n === page ? 'bg-amber-50 ring-1 ring-amber-300' : ''}`}
            >
              {n ? <p className="mb-1 text-xs font-medium text-ink-faint">{t('page.pageN', { n: Number(n) })}</p> : null}
              {match ? section.slice(match[0].length) : section}
            </section>
          )
        })}
      </div>
      <Link href={wikiHref(connectorId)} className="mt-4 inline-block text-sm text-coral-deep hover:underline">
        {t('source.back')}
      </Link>
    </Card>
  )
}

/** Egy pillantásra: emberek és AI-munkatársak, akik elérik ezt a tudásbázist. */
function WhoSees({ wiki, connectorId, t }: { wiki: Overview; connectorId: string; t: T }) {
  const agents = wiki.access.filter((row) => row.access !== 'none')
  return (
    <dl className="mt-3 grid max-w-2xl gap-1 rounded-lg border border-line/70 bg-paper/60 px-3 py-2 text-sm" data-testid="wiki-who-sees">
      <div className="flex flex-wrap gap-x-2">
        <dt className="font-medium text-ink">{t('whoSees.humans')}</dt>
        <dd className="text-ink-soft">{t(`whoSees.humansBy.${wiki.private ? 'private' : 'shared'}`)}</dd>
      </div>
      <div className="flex flex-wrap gap-x-2">
        <dt className="font-medium text-ink">{t('whoSees.agents')}</dt>
        <dd className="text-ink-soft">
          {agents.length === 0
            ? t('whoSees.noAgents')
            : agents.map((row) => `${row.agentName} (${t(`levels.${row.access}`).toLowerCase()})`).join(', ')}
          {' · '}
          <Link href={wikiHref(connectorId, { tab: 'access' })} className="text-coral-deep hover:underline">
            {t('whoSees.change')}
          </Link>
        </dd>
      </div>
    </dl>
  )
}

async function AccessTab({ connectorId }: { connectorId: string }) {
  const res = await getWikiAgentAccessAction({ connectorId })
  if (!res.success) {
    const t = await getTranslations('ControlPlane.wiki')
    const known = ['not_found', 'forbidden', 'invalid_args', 'too_large'] as const
    const key = known.includes(res.error as (typeof known)[number]) ? res.error : 'generic'
    return (
      <Card title={t('access.title')}>
        <p className="text-sm text-ink-soft">{t(`errors.${key}`)}</p>
      </Card>
    )
  }
  return <WikiAgentAccessEditor connectorId={connectorId} canEdit={res.data.canEdit} rows={res.data.rows} />
}

async function SettingsTab({ connectorId, name, isPrivate }: { connectorId: string; name: string; isPrivate: boolean }) {
  const res = await getWikiSettingsAction({ connectorId })
  if (!res.success) notFound()
  return (
    <div className="space-y-4">
      <WikiSettingsPanel connectorId={connectorId} settings={res.data} />
      <WikiOwnerActions connectorId={connectorId} name={name} isPrivate={isPrivate} />
    </div>
  )
}

async function InboxTab({ connectorId }: { connectorId: string }) {
  const res = await listWikiInboxAction({ connectorId })
  if (!res.success) notFound()
  return <WikiInboxPanel connectorId={connectorId} initial={res.data} />
}
