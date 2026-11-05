import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import {
  getWikiAgentAccessAction,
  getWikiCategoriesAction,
  getWikiMetadataAction,
  getWikiOverviewAction,
  getWikiPageMetaAction,
  getWikiViewAction,
  getWikiPageAction,
  getWikiPageAtAction,
  getWikiRetentionAction,
  getWikiConfigProposalAction,
  getWikiConfigProposalsAction,
  getWikiSettingsAction,
  getWikiStateAtAction,
  getWikiSourceAction,
  listWikiInboxAction,
} from '@/app/actions/knowledge-wiki'
import { Badge, Card } from '@/components/ui/shell'
import { WikiInboxPanel } from '@/components/knowledge/wiki/wiki-inbox-panel'
import { WikiSourceList } from '@/components/knowledge/wiki/wiki-sources'
import { WikiMarkdown } from '@/components/knowledge/wiki/wiki-markdown'
import { WikiAgentAccessEditor } from '@/components/knowledge/wiki/wiki-agent-access-editor'
import { WikiOwnerActions } from '@/components/knowledge/wiki/wiki-owner-actions'
import { WikiSettingsPanel } from '@/components/knowledge/wiki/wiki-settings-panel'
import { WikiProposalsPanel } from '@/components/knowledge/wiki/wiki-proposals-panel'
import { WikiRetentionPanel } from '@/components/knowledge/wiki/wiki-retention-panel'
import { WikiErasurePanel } from '@/components/knowledge/wiki/wiki-erasure-panel'
import { WikiCategoriesPanel } from '@/components/knowledge/wiki/wiki-categories-panel'
import { WikiMetadataPanel } from '@/components/knowledge/wiki/wiki-metadata-panel'
import { WikiPageMeta } from '@/components/knowledge/wiki/wiki-page-meta'
import { WikiMenu } from '@/components/knowledge/wiki/wiki-menu'
import { WikiReaderBack } from '@/components/knowledge/wiki/wiki-reader-back'
import {
  ChangesTab,
  PageHistoryPanel,
  RevisionDiffView,
  RevisionView,
  TimeTravelBanner,
} from '@/components/knowledge/wiki/wiki-history-views'
import { formatWhen, wikiHref } from '@/components/knowledge/wiki/wiki-format'
import { HelpHint } from '@/components/onboarding/onboarding-ui'

export const dynamic = 'force-dynamic'

const TABS = ['wiki', 'reader', 'views', 'changes', 'inbox', 'log', 'access', 'proposals', 'settings'] as const
type Tab = (typeof TABS)[number]

/** Az olvasó nézetben minden belső link megtartja ezt, különben kattintásra kilépne belőle. */
const READER_QUERY = { tab: 'reader' }

export default async function KnowledgeBaseWikiPage({
  params,
  searchParams,
}: {
  params: Promise<{ connectorId: string }>
  searchParams: Promise<WikiQuery>
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
  const tabs = TABS.filter((tab) => (tab !== 'settings' || wiki.canManage) && (tab !== 'proposals' || wiki.canManage) && (tab !== 'views' || wiki.managedFields))
  const tab: Tab = (tabs as readonly string[]).includes(query.tab ?? '') ? (query.tab as Tab) : 'wiki'
  // A nyitott lap (és forrás) a nézetváltáskor is megmarad.
  const openItem = { page: query.page, source: query.source, p: query.p }

  if (tab === 'reader') {
    return (
      <div className="space-y-3" data-testid="wiki-reader">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="font-display text-2xl font-semibold" data-testid="wiki-title">{wiki.name}</h1>
          <Link href={wikiHref(connectorId, openItem)} data-testid="wiki-reader-exit" className="text-sm text-ink-soft hover:text-ink">
            {t('reader.exit')}
          </Link>
        </div>
        <WikiTab connectorId={connectorId} wiki={wiki} query={query} t={t} locale={locale} reader />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Link href="/control-plane/knowledge" className="inline-flex items-center gap-1 text-sm font-medium text-ink-soft hover:text-ink">
        {t('back')}
      </Link>
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-coral">{t('eyebrow')}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="font-display text-3xl font-semibold" data-testid="wiki-title">{wiki.name}</h1>
          <Badge tone={wiki.private || wiki.kind === 'members' ? 'warning' : 'neutral'}>{t(`kind.${wiki.kind}`)}</Badge>
          <Badge tone="neutral">{t(`templates.${wiki.template}.name`)}</Badge>
        </div>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          {wiki.private ? t('header.privateBody') : wiki.kind === 'members' ? t('header.membersBody') : t('header.body')}
        </p>
        <WhoSees wiki={wiki} connectorId={connectorId} t={t} />
      </div>

      <nav className="flex flex-wrap gap-1 border-b border-line/70" aria-label={t('tabsAria')}>
        {tabs.map((id) => (
          <Link
            key={id}
            href={wikiHref(connectorId, id === 'reader' && tab === 'wiki' && !query.asOf ? { tab: id, ...openItem } : { tab: id })}
            data-testid={`wiki-tab-${id}`}
            className={`-mb-px rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium ${
              tab === id ? 'border-coral text-coral-deep' : 'border-transparent text-ink-soft hover:text-ink'
            }`}
          >
            {t(`tabs.${id}`)}
            {id === 'inbox' && wiki.inbox.pending + wiki.inbox.reprocess + wiki.inbox.inProgress > 0 ? (
              <span className="ml-1 rounded-full bg-coral/10 px-1.5 text-xs text-coral-deep">
                {wiki.inbox.pending + wiki.inbox.reprocess + wiki.inbox.inProgress}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>

      {tab === 'wiki' ? (
        <WikiTab connectorId={connectorId} wiki={wiki} query={query} t={t} locale={locale} />
      ) : null}
      {tab === 'views' ? <ViewsTab connectorId={connectorId} query={query} t={t} locale={locale} /> : null}
      {tab === 'changes' ? <ChangesTab connectorId={connectorId} query={query} locale={locale} /> : null}
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
      {tab === 'proposals' && wiki.canManage ? <ProposalsTab connectorId={connectorId} proposalId={query.proposal} /> : null}
      {tab === 'settings' && wiki.canManage ? <SettingsTab connectorId={connectorId} name={wiki.name} isPrivate={wiki.private} /> : null}
    </div>
  )
}

type WikiQuery = {
  tab?: string
  /** #1075: a Javaslatok fülön megnyitott javaslat. */
  proposal?: string
  page?: string
  source?: string
  p?: string
  /** #978: korábbi verzió, két verzió összevetése, időutazás, „Változások” szűrők. */
  rev?: string
  from?: string
  to?: string
  asOf?: string
  author?: string
  before?: string
  /** #1061 F3 „Nézetek”: melyik nézet, és a gazda / mező szerinti szűrés. */
  view?: string
  owner?: string
  field?: string
  value?: string
}

type Overview = Extract<Awaited<ReturnType<typeof getWikiOverviewAction>>, { success: true }>['data']
type T = Awaited<ReturnType<typeof getTranslations<'ControlPlane.wiki'>>>

async function WikiTab({
  connectorId,
  wiki,
  query,
  t,
  locale,
  reader = false,
}: {
  connectorId: string
  wiki: Overview
  query: WikiQuery
  t: T
  locale: string
  /** Olvasó nézet: csak az olvasáshoz kell tartalom, a kezelőfelületek a normál nézetben maradnak. */
  reader?: boolean
}) {
  if (query.asOf && !reader) {
    return <TimeTravelTab connectorId={connectorId} query={query} asOf={query.asOf} t={t} locale={locale} />
  }
  const linkQuery = reader ? READER_QUERY : undefined
  const backControl = reader ? (
    <div className="float-right mb-2 ml-3">
      <WikiReaderBack href={wikiHref(connectorId, { ...READER_QUERY, page: query.page, source: query.source, p: query.p })} />
    </div>
  ) : null
  const toc = (
    // Az olvasó nézetben a hosszú tartalomjegyzék önállóan görgethető, a szöveg mellett végig elérhető.
    <Card className={`lg:sticky lg:top-4 ${reader ? 'lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto' : ''}`}>
      <div className="mb-2 flex items-center">
        <h2 className="font-display text-lg font-semibold">{t('toc.title')}</h2>
        <HelpHint>{t('toc.help')}</HelpHint>
      </div>
      {wiki.pageCount === 0 && !wiki.managedCategories ? (
        <p className="text-sm text-ink-soft" data-testid="wiki-empty">{t('toc.empty')}</p>
      ) : (
        <>
          {wiki.pageCount === 0 ? <p className="mb-2 text-sm text-ink-soft" data-testid="wiki-empty">{t('toc.empty')}</p> : null}
          <WikiMenu connectorId={connectorId} groups={wiki.menu} currentPath={query.page} linkedWikis={wiki.linkedWikis} linkQuery={linkQuery} />
        </>
      )}
    </Card>
  )

  let main: React.ReactNode
  if (query.source) {
    const res = await getWikiSourceAction({ connectorId, documentId: query.source })
    main = res.success ? (
      <SourceView connectorId={connectorId} source={res.data} page={query.p} t={t} locale={locale} backControl={backControl} />
    ) : (
      <Card>{backControl}<p className="text-sm text-ink-soft">{t('source.notFound')}</p></Card>
    )
  } else if (!reader && query.page && query.rev) {
    main = <RevisionView connectorId={connectorId} path={query.page} version={query.rev} locale={locale} />
  } else if (!reader && query.page && query.from && query.to) {
    main = <RevisionDiffView connectorId={connectorId} path={query.page} from={query.from} to={query.to} locale={locale} />
  } else if (query.page) {
    const [res, metaRes] = await Promise.all([
      getWikiPageAction({ connectorId, path: query.page }),
      getWikiPageMetaAction({ connectorId, path: query.page }),
    ])
    const pageMeta = metaRes.success ? metaRes.data : null
    main = res.success ? (
      <Card>
        {backControl}
        <article data-testid="wiki-page">
          {reader ? null : <p className="text-xs text-ink-faint">{res.data.path}</p>}
          <h2 className="mt-1 font-display text-2xl font-semibold">{res.data.title}</h2>
          {res.data.summary ? <p className="mt-1 text-ink-soft">{res.data.summary}</p> : null}
          <p className="mt-2 text-xs text-ink-faint">
            {res.data.categoryName ? `${t('page.category', { name: res.data.categoryName })} · ` : null}
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
          {pageMeta && !reader ? <WikiPageMeta connectorId={connectorId} path={res.data.path} data={pageMeta} locale={locale} /> : null}
          <div className="mt-4">
            <WikiMarkdown
              connectorId={connectorId}
              body={res.data.body}
              pagePath={res.data.path}
              knownPaths={res.data.knownPaths}
              linkTitles={res.data.linkTitles}
              linkQuery={linkQuery}
              crossLinkQuery={linkQuery}
              crossLinks={res.data.crossLinks}
            />
          </div>
          {res.data.sources.length ? (
            <div className="mt-6 border-t border-line/70 pt-3">
              <p className="mb-1 flex items-center text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
                {t('page.sources')}
                <HelpHint>{t('page.sourcesHelp')}</HelpHint>
              </p>
              <WikiSourceList connectorId={connectorId} sources={res.data.sources} linkQuery={linkQuery} />
            </div>
          ) : null}
          {res.data.backlinks ? <BacklinksPanel connectorId={connectorId} backlinks={res.data.backlinks} t={t} linkQuery={linkQuery} /> : null}
          {res.data.crossBacklinks.length ? <CrossBacklinksPanel rows={res.data.crossBacklinks} t={t} linkQuery={linkQuery} /> : null}
          {reader ? null : <PageHistoryPanel connectorId={connectorId} path={res.data.path} locale={locale} />}
        </article>
      </Card>
    ) : (
      <Card>{backControl}<p className="text-sm text-ink-soft">{t('page.notFound')}</p></Card>
    )
  } else {
    main = (
      <Card>
        {backControl}
        <h2 className="font-display text-lg font-semibold">{t('overview.title')}</h2>
        <p className="mt-2 text-sm text-ink-soft">
          {wiki.pageCount === 0 ? t('overview.empty') : t('overview.body', { pages: wiki.pageCount })}
        </p>
        {reader ? null : (
          <ul className="mt-3 space-y-1 text-sm text-ink-soft">
            <li>{t('overview.inbox', { pending: wiki.inbox.pending + wiki.inbox.reprocess, inProgress: wiki.inbox.inProgress })}</li>
            <li>{t('overview.writers', { count: wiki.access.filter((row) => row.access === 'write').length })}</li>
          </ul>
        )}
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

/** #978 §5.3: a wiki egy korábbi állapota — csak olvasható nézet, sávval. */
async function TimeTravelTab({
  connectorId,
  query,
  asOf,
  t,
  locale,
}: {
  connectorId: string
  query: WikiQuery
  asOf: string
  t: T
  locale: string
}) {
  const stateRes = await getWikiStateAtAction({ connectorId, asOf })
  if (!stateRes.success) {
    return (
      <Card>
        <p className="text-sm text-ink-soft">{t('errors.invalid_args')}</p>
      </Card>
    )
  }
  const state = stateRes.data
  const pageRes = query.page ? await getWikiPageAtAction({ connectorId, path: query.page, asOf }) : null
  return (
    <div className="space-y-4">
      <TimeTravelBanner connectorId={connectorId} seq={state.seq} at={state.at} thinned={state.thinned} locale={locale} />
      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <Card className="lg:sticky lg:top-4">
          <h2 className="mb-2 font-display text-lg font-semibold">{t('toc.title')}</h2>
          {state.pageCount === 0 ? (
            <p className="text-sm text-ink-soft">{t('toc.empty')}</p>
          ) : (
            <div className="space-y-3" data-testid="wiki-toc-as-of">
              {state.categories.map((group) => (
                <div key={group.category}>
                  <p className="text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
                    {group.category === 'Uncategorized' ? t('toc.uncategorized') : group.category}
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {group.pages.map((page) => (
                      <li key={page.path}>
                        <Link
                          href={wikiHref(connectorId, { asOf, page: page.path })}
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
        <div className="min-w-0">
          {pageRes ? (
            pageRes.success ? (
              <Card>
                <article data-testid="wiki-page-as-of">
                  <p className="text-xs text-ink-faint">
                    {pageRes.data.path} · v{pageRes.data.version} · {formatWhen(pageRes.data.createdAt, locale)}
                  </p>
                  <h2 className="mt-1 font-display text-2xl font-semibold">{pageRes.data.title}</h2>
                  {pageRes.data.summary ? <p className="mt-1 text-ink-soft">{pageRes.data.summary}</p> : null}
                  <div className="mt-4">
                    <WikiMarkdown
                      connectorId={connectorId}
                      body={pageRes.data.body}
                      pagePath={pageRes.data.path}
                      knownPaths={pageRes.data.knownPaths}
                      linkTitles={pageRes.data.linkTitles}
                      linkQuery={{ asOf }}
                    />
                  </div>
                </article>
              </Card>
            ) : (
              <Card>
                <p className="text-sm text-ink-soft">{t('page.notFound')}</p>
              </Card>
            )
          ) : (
            <Card>
              <h2 className="font-display text-lg font-semibold">{t('overview.title')}</h2>
              <p className="mt-2 text-sm text-ink-soft">
                {state.pageCount === 0 ? t('overview.empty') : t('overview.body', { pages: state.pageCount })}
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

function SourceView({
  connectorId,
  source,
  page,
  t,
  locale,
  backControl,
}: {
  connectorId: string
  source: { documentId: string; filename: string; text: string; createdAt: string }
  page?: string
  t: T
  locale: string
  /** Olvasó nézetben ez a gomb váltja ki a lap alji „vissza a wikihez” linket. */
  backControl?: React.ReactNode
}) {
  // A PDF-kinyerés oldalanként `# Oldal N` fejlécet ír; erre ugrunk.
  const sections = source.text.split(/\n(?=# Oldal \d+\n)/)
  return (
    <Card>
      {backControl}
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
      {backControl ? null : (
        <Link href={wikiHref(connectorId)} className="mt-4 inline-block text-sm text-coral-deep hover:underline">
          {t('source.back')}
        </Link>
      )}
    </Card>
  )
}

type PageData = Extract<Awaited<ReturnType<typeof getWikiPageAction>>, { success: true }>['data']

/** #1061 F1: „Erre az oldalra hivatkozik (N)” — kategória szerint csoportosítva. */
/** #1061 F2: más wikik oldalai, amelyek ide mutatnak (csak a néző által látott wikikből). */
function CrossBacklinksPanel({ rows, t, linkQuery }: { rows: PageData['crossBacklinks']; t: T; linkQuery?: Record<string, string> }) {
  return (
    <div className="mt-4 border-t border-line/70 pt-3" data-testid="wiki-cross-backlinks">
      <p className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
        {t('backlinks.otherWikis', { count: rows.length })}
      </p>
      <ul className="flex flex-wrap gap-1 text-sm">
        {rows.map((row) => (
          <li key={`${row.connectorId}:${row.path}`}>
            <Link
              href={wikiHref(row.connectorId, { ...linkQuery, page: row.path })}
              className="rounded bg-ink/5 px-1.5 py-0.5 text-ink hover:text-coral-deep"
              title={row.path}
            >
              {row.wikiName} · {row.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

function BacklinksPanel({
  connectorId,
  backlinks,
  t,
  linkQuery,
}: {
  connectorId: string
  backlinks: NonNullable<PageData['backlinks']>
  t: T
  linkQuery?: Record<string, string>
}) {
  return (
    <div className="mt-6 border-t border-line/70 pt-3" data-testid="wiki-backlinks">
      <p className="mb-1 flex items-center text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
        {t('backlinks.title', { count: backlinks.count })}
        <HelpHint>{t('backlinks.help')}</HelpHint>
      </p>
      {backlinks.count === 0 ? (
        <p className="text-sm text-ink-faint">{t('backlinks.empty')}</p>
      ) : (
        <div className="space-y-2">
          {backlinks.groups.map((group) => (
            <div key={group.category ?? ''}>
              <p className="text-xs text-ink-soft">{group.category ?? t('toc.uncategorized')}</p>
              <ul className="mt-0.5 flex flex-wrap gap-1 text-sm">
                {group.pages.map((page) => (
                  <li key={page.path}>
                    <Link
                      href={wikiHref(connectorId, { ...linkQuery, page: page.path })}
                      className="rounded bg-ink/5 px-1.5 py-0.5 text-ink hover:text-coral-deep"
                      title={page.path}
                    >
                      {page.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {backlinks.count > backlinks.shown ? (
            <p className="text-xs text-ink-faint">{t('backlinks.more', { count: backlinks.count - backlinks.shown })}</p>
          ) : null}
        </div>
      )}
    </div>
  )
}

/** Egy pillantásra: emberek és AI-munkatársak, akik elérik ezt a tudásbázist. */
function WhoSees({ wiki, connectorId, t }: { wiki: Overview; connectorId: string; t: T }) {
  const agents = wiki.access.filter((row) => row.access !== 'none')
  return (
    <dl className="mt-3 grid max-w-2xl gap-1 rounded-lg border border-line/70 bg-paper/60 px-3 py-2 text-sm" data-testid="wiki-who-sees">
      <div className="flex flex-wrap gap-x-2">
        <dt className="font-medium text-ink">{t('whoSees.humans')}</dt>
        <dd className="text-ink-soft">
          {t(`whoSees.humansBy.${wiki.private ? 'private' : wiki.kind === 'members' ? 'members' : 'shared'}`)}
        </dd>
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
    return (
      <Card title={t('access.title')}>
        <p className="text-sm text-ink-soft">{t(wikiErrorMessage(res.error))}</p>
      </Card>
    )
  }
  return <WikiAgentAccessEditor connectorId={connectorId} canEdit={res.data.canEdit} rows={res.data.rows} />
}

function wikiErrorMessage(
  code: string,
): 'errors.not_found' | 'errors.forbidden' | 'errors.invalid_args' | 'errors.too_large' | 'errors.generic' {
  if (code === 'not_found' || code === 'forbidden' || code === 'invalid_args' || code === 'too_large') {
    return `errors.${code}`
  }
  return 'errors.generic'
}

/** #1075: agent által javasolt beállítás — a kiválasztott javaslatot mindig az élő állapotból számoljuk. */
async function ProposalsTab({ connectorId, proposalId }: { connectorId: string; proposalId?: string }) {
  const [overview, review] = await Promise.all([
    getWikiConfigProposalsAction({ connectorId }),
    proposalId ? getWikiConfigProposalAction({ connectorId, proposalId }) : null,
  ])
  if (!overview.success) notFound()
  return <WikiProposalsPanel connectorId={connectorId} overview={overview.data} review={review?.success ? review.data : null} />
}

async function SettingsTab({ connectorId, name, isPrivate }: { connectorId: string; name: string; isPrivate: boolean }) {
  const [res, retention, categories, metadata] = await Promise.all([
    getWikiSettingsAction({ connectorId }),
    getWikiRetentionAction({ connectorId }),
    getWikiCategoriesAction({ connectorId }),
    getWikiMetadataAction({ connectorId }),
  ])
  if (!res.success) notFound()
  return (
    <div className="space-y-4">
      <WikiSettingsPanel connectorId={connectorId} settings={res.data} />
      {categories.success ? <WikiCategoriesPanel connectorId={connectorId} data={categories.data} /> : null}
      {metadata.success ? <WikiMetadataPanel connectorId={connectorId} data={metadata.data} /> : null}
      {retention.success ? <WikiRetentionPanel connectorId={connectorId} retention={retention.data} /> : null}
      <WikiOwnerActions connectorId={connectorId} name={name} isPrivate={isPrivate} />
      <WikiErasurePanel connectorId={connectorId} name={name} isPrivate={isPrivate} />
    </div>
  )
}

async function InboxTab({ connectorId }: { connectorId: string }) {
  const res = await listWikiInboxAction({ connectorId })
  if (!res.success) notFound()
  return <WikiInboxPanel connectorId={connectorId} initial={res.data} />
}

const VIEWS = ['drafts', 'overdue', 'mine', 'owner', 'orphans', 'field'] as const
type ViewId = (typeof VIEWS)[number]

/**
 * #1061 F3: generált nézetek — tervezetek, lejárt átnézés (a régóta lejártak elöl),
 * saját oldalaim, gazdánként, árva oldalak, egyedi mező szerint. Ugyanaz a mag, mint az
 * agent `kb_list_index` szűrője (AC11).
 */
async function ViewsTab({ connectorId, query, t, locale }: { connectorId: string; query: WikiQuery; t: T; locale: string }) {
  const view: ViewId = (VIEWS as readonly string[]).includes(query.view ?? '') ? (query.view as ViewId) : 'overdue'
  const res = await getWikiViewAction({
    connectorId,
    view,
    ...(view === 'owner' && query.owner ? { owner: query.owner } : {}),
    ...(view === 'field' && query.field && query.value ? { field: query.field, value: query.value } : {}),
  })
  if (!res.success) {
    return (
      <Card>
        <p className="text-sm text-ink-soft">{t(wikiErrorMessage(res.error))}</p>
      </Card>
    )
  }
  const data = res.data
  if (!data.managed) {
    return (
      <Card>
        <p className="text-sm text-ink-soft">{t('views.off')}</p>
      </Card>
    )
  }
  const pages = 'pages' in data ? data.pages : []
  const selectedField = data.fields.find((field) => field.key === query.field) ?? data.fields[0]
  // Gazdánként: a lista a gazda szerint csoportosítva (gazda nélküliek a végén).
  const groups =
    view === 'owner' && !query.owner
      ? [...new Map(pages.map((page) => [page.owner?.userId ?? '', page.owner?.name ?? null])).entries()]
          .sort(([a, an], [b, bn]) => (a === '' ? 1 : b === '' ? -1 : (an ?? '').localeCompare(bn ?? '')))
          .map(([ownerId, ownerName]) => ({ ownerId, ownerName, pages: pages.filter((page) => (page.owner?.userId ?? '') === ownerId) }))
      : [{ ownerId: null as string | null, ownerName: null as string | null, pages }]

  return (
    <div className="space-y-4" data-testid="wiki-views">
      <Card>
        <p className="text-sm text-ink-soft">{t('views.intro')}</p>
        <nav className="mt-3 flex flex-wrap gap-1" aria-label={t('views.title')}>
          {VIEWS.map((id) => (
            <Link
              key={id}
              href={wikiHref(connectorId, { tab: 'views', view: id })}
              data-testid={`wiki-view-${id}`}
              className={`rounded-full px-3 py-1 text-sm ${view === id ? 'bg-coral/10 font-medium text-coral-deep' : 'bg-ink/5 text-ink-soft hover:text-ink'}`}
            >
              {t(`views.tabs.${id}`)}
            </Link>
          ))}
        </nav>
        <p className="mt-3 text-xs text-ink-faint">{t(`views.help.${view}`)}</p>
        {view === 'field' ? (
          data.fields.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">{t('views.noFields')}</p>
          ) : (
            <form className="mt-2 flex flex-wrap items-end gap-2" method="get">
              <input type="hidden" name="tab" value="views" />
              <input type="hidden" name="view" value="field" />
              <label className="text-sm">
                <span className="mb-1 block text-ink">{t('views.field')}</span>
                <select name="field" defaultValue={selectedField?.key} className="rounded-lg border border-line/70 px-2 py-1 text-sm">
                  {data.fields.map((field) => (
                    <option key={field.key} value={field.key}>
                      {field.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-ink">{t('views.value')}</span>
                <input
                  name="value"
                  defaultValue={query.value ?? ''}
                  list="wiki-field-values"
                  required
                  className="rounded-lg border border-line/70 px-2 py-1 text-sm"
                />
                <datalist id="wiki-field-values">
                  {data.fields.flatMap((field) => field.options).map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              </label>
              <button type="submit" className="rounded-lg bg-ink px-3 py-1.5 text-sm text-white">
                {t('views.apply')}
              </button>
            </form>
          )
        ) : null}
      </Card>

      <Card>
        {view === 'field' && !(query.field && query.value) ? (
          <p className="text-sm text-ink-soft">{t('views.pickField')}</p>
        ) : pages.length === 0 ? (
          <p className="text-sm text-ink-soft" data-testid="wiki-view-empty">{t(`views.empty.${view}`)}</p>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-ink-faint">{t('views.count', { count: 'count' in data ? data.count : pages.length })}</p>
            {groups.map((group) => (
              <div key={group.ownerId ?? 'all'}>
                {group.ownerId !== null ? (
                  <p className="mb-1 text-xs font-medium uppercase tracking-[0.14em] text-ink-faint">
                    {group.ownerId ? group.ownerName ?? '—' : t('views.noOwner')} · {group.pages.length}
                  </p>
                ) : null}
                <ul className="divide-y divide-line/60" data-testid="wiki-view-pages">
                  {group.pages.map((page) => (
                    <li key={page.path} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5 text-sm">
                      <Link href={wikiHref(connectorId, { page: page.path })} className="font-medium text-ink hover:text-coral-deep">
                        {page.title}
                      </Link>
                      {page.category ? <span className="text-xs text-ink-faint">{page.category}</span> : null}
                      {page.docStatus ? <span className="rounded-full bg-ink/5 px-2 text-xs text-ink-soft">{t(`pageMeta.statuses.${page.docStatus}`)}</span> : null}
                      {page.owner && view !== 'owner' ? <span className="text-xs text-ink-soft">{page.owner.name ?? '—'}</span> : null}
                      {'overdueDays' in page && page.overdueDays ? (
                        <span className="text-xs font-medium text-coral-deep">{t('views.overdueBy', { days: page.overdueDays })}</span>
                      ) : page.reviewDue ? (
                        <span className="text-xs text-ink-faint">{t('views.due', { date: formatWhen(page.reviewDue, locale).split(',')[0] })}</span>
                      ) : null}
                      {page.lastReviewed ? (
                        <span className="text-xs text-ink-faint">{t('views.lastReviewed', { date: formatWhen(page.lastReviewed.at, locale).split(',')[0] })}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
