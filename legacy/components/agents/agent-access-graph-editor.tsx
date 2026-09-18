'use client'

/**
 * Kapcsolati ábra — az agent-hozzáférési gráf admin szerkesztője (issue #142).
 *
 * ÜZLETI JELENTÉS: ki kivel dolgozhat. Két független jog pipával: „Láthatja" és
 * „Megszólíthatja". Kiindulás: minden munkatárs mindkettőt megkapja; az admin
 * pipával vesz el. Nincs „alapból" középső állapot a felületen.
 */
import { useCallback, useMemo, useState, useTransition } from 'react'
import {
  loadAgentAccessGraph,
  setAgentAccessGrant,
  previewAgentAccessRestriction,
  setAgentAccessRestriction,
} from '@/app/actions/agent-access'
import { Badge, Card } from '@/components/ui/shell'
import {
  reachabilityConeFor,
  type GraphAgentView,
  type GraphGrantView,
  type GraphSubject,
  type GraphUserView,
} from '@/lib/agent-access-graph-view'
import { REACHABILITY_DEPTH_WARNING_THRESHOLD } from '@/lib/agent-access-graph'

type DryRun = {
  agentId: string
  agentName: string
  current: { inboundRestricted: boolean; outboundRestricted: boolean }
  next: { inboundRestricted: boolean; outboundRestricted: boolean }
  losingConnections: Array<{
    direction: 'inbound' | 'outbound'
    subjectKind: 'user' | 'agent'
    subjectId: string
    subjectLabel: string
    targetAgentId: string
    targetLabel: string
    verb: 'view' | 'address'
  }>
  keepExplicitGrantIds: string[]
  coneAfter: { agentIds: string[]; maxDepth: number; hasCycle: boolean }
  affectedActivePaths: Array<{ kind: 'conversation' | 'ticket'; id: string; label: string }>
}

const VERB_LABEL = {
  view: { short: 'L', name: 'Láthatja', hint: 'Megtudhatja, hogy ez az agent létezik, és megtalálja a listákban.' },
  address: {
    short: 'M',
    name: 'Megszólíthatja',
    hint: 'Chatet indíthat, feladatot adhat vagy átadhat neki munkát.',
  },
} as const

export type AgentAccessGraphSnapshot = {
  agents: GraphAgentView[]
  users: GraphUserView[]
  grants: GraphGrantView[]
  fullyDefaultOpen: boolean
}

export function AgentAccessGraphEditor({
  tenantId,
  initialGraph,
}: {
  tenantId: string
  initialGraph: AgentAccessGraphSnapshot
}) {
  const [agents, setAgents] = useState<GraphAgentView[]>(initialGraph.agents)
  const [users, setUsers] = useState<GraphUserView[]>(initialGraph.users)
  const [grants, setGrants] = useState<GraphGrantView[]>(initialGraph.grants)
  const [fullyDefaultOpen, setFullyDefaultOpen] = useState(initialGraph.fullyDefaultOpen)
  const [selected, setSelected] = useState<GraphSubject | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'view' | 'address'>('all')
  const [dryRun, setDryRun] = useState<DryRun | null>(null)
  const [pending, startTransition] = useTransition()

  // A gráfot a szerver tölti be az első rendereléshez; írás után innen frissítjük,
  // hogy a felület azonnal a MENTETT policy-t mutassa (ne az optimista állapotot).
  const refresh = useCallback(async () => {
    const res = await loadAgentAccessGraph()
    if (!res.success) {
      setError(res.error)
      return
    }
    setAgents(res.data.agents)
    setUsers(res.data.users)
    setGrants(res.data.grants)
    setFullyDefaultOpen(res.data.fullyDefaultOpen)
    setError(null)
  }, [])

  const selectedLabel = useMemo(() => {
    if (!selected) return null
    if (selected.kind === 'user') return users.find((u) => u.id === selected.id)?.name ?? 'Munkatárs'
    const agent = agents.find((a) => a.id === selected.id)
    return agent ? agent.nickname : 'AI munkatárs'
  }, [selected, users, agents])

  const cone = useMemo(() => {
    if (!selected) return null
    return reachabilityConeFor({
      tenantId,
      agents,
      grants,
      subject: selected,
      subjectIsTenantAdmin: true,
    })
  }, [selected, tenantId, agents, grants])

  /** Egy ige ki/be kapcsolása. Ha mindkettő lekerül, a kapcsolat sora törlődik. */
  const toggleVerb = (subject: GraphSubject, targetAgentId: string, verb: 'view' | 'address') => {
    const existing = grants.find(
      (g) =>
        g.targetAgentId === targetAgentId &&
        (subject.kind === 'user' ? g.subjectUserId === subject.id : g.subjectAgentId === subject.id),
    )
    // Két állapot: van pipa (grant ige) vagy nincs. Nincs „alapból” középső út.
    const grantedNow = existing
      ? verb === 'view'
        ? existing.canView
        : existing.canAddress
      : false
    const nextView = verb === 'view' ? !grantedNow : existing?.canView ?? false
    const nextAddress =
      verb === 'address' ? !grantedNow : existing?.canAddress ?? false

    // Optimista UI: a pipa azonnal vált.
    const previousGrants = grants
    if (!nextView && !nextAddress) {
      setGrants((rows) =>
        rows.filter(
          (g) =>
            !(
              g.targetAgentId === targetAgentId &&
              (subject.kind === 'user'
                ? g.subjectUserId === subject.id
                : g.subjectAgentId === subject.id)
            ),
        ),
      )
    } else if (existing) {
      setGrants((rows) =>
        rows.map((g) =>
          g.id === existing.id ? { ...g, canView: nextView, canAddress: nextAddress } : g,
        ),
      )
    } else {
      setGrants((rows) => [
        ...rows,
        {
          id: `optimistic-${subject.kind}-${subject.id}-${targetAgentId}`,
          subjectType: subject.kind,
          subjectUserId: subject.kind === 'user' ? subject.id : null,
          subjectAgentId: subject.kind === 'agent' ? subject.id : null,
          targetAgentId,
          canView: nextView,
          canAddress: nextAddress,
        },
      ])
    }

    startTransition(async () => {
      setError(null)
      setNotice(null)
      const res = await setAgentAccessGrant({
        subjectKind: subject.kind,
        subjectId: subject.id,
        targetAgentId,
        canView: nextView,
        canAddress: nextAddress,
      })
      if (!res.success) {
        setGrants(previousGrants)
        setError(res.error)
        return
      }
      setNotice(
        !nextView && !nextAddress
          ? 'A jogot levettük — ez a kolléga már nem éri el így az agentet.'
          : 'A jog mentve. Azonnal érvényes minden felületen.',
      )
      await refresh()
    })
  }

  const requestDryRun = (agent: GraphAgentView, patch: Partial<DryRun['next']>) => {
    startTransition(async () => {
      setError(null)
      const res = await previewAgentAccessRestriction({ agentId: agent.id, ...patch })
      if (!res.success) {
        setError(res.error)
        return
      }
      setDryRun(res.data as DryRun)
    })
  }

  const applyRestriction = (run: DryRun) => {
    startTransition(async () => {
      setError(null)
      const res = await setAgentAccessRestriction({
        agentId: run.agentId,
        inboundRestricted: run.next.inboundRestricted,
        outboundRestricted: run.next.outboundRestricted,
        confirmedPreview: true,
      })
      if (!res.success) {
        setError(res.error)
        return
      }
      setDryRun(null)
      setNotice('A korlátozás beállítva.')
      await refresh()
    })
  }

  return (
    <div className="space-y-5">
      {error && (
        <div role="alert" className="rounded-lg border border-coral/40 bg-coral/10 px-4 py-3 text-sm">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-lg border border-sage/40 bg-sage/10 px-4 py-3 text-sm">
          {notice}
        </div>
      )}

      <Card>
        <h2 className="font-display text-lg font-semibold">Mit állítasz be itt?</h2>
        <p className="mt-2 text-sm text-ink-soft">
          Két külön dolgot engedélyezel: hogy valaki <strong>láthatja-e</strong>, hogy egy agent
          létezik, és hogy <strong>megszólíthatja-e</strong>. A kettő független — egy agent lehet
          úgy elrejtve a listákból, hogy közben egy megnevezett kolléga mégis írhat neki.
        </p>
        <p className="mt-3 text-sm text-ink-faint">
          Kiindulásként minden munkatárs láthatja és megszólíthatja a szervezet agentjeit. A pipa
          levétele azonnal elveszi a jogot ettől a kollégától.
        </p>
        {agents.some((a) => !a.inboundRestricted) && (
          <p className="mt-3 rounded-lg border border-honey/40 bg-honey/10 px-3 py-2 text-sm">
            Figyelem: még van olyan agent, ahol nincs belépési korlátozás beállítva. Futtasd a
            jogosultság-szinkront, vagy kapcsold be a korlátozást — addig a pipa önmagában nem
            mindig elég az elvételhez.
          </p>
        )}
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-ink-faint">Mit mutassunk:</span>
        {(['all', 'view', 'address'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={`rounded-lg border px-3 py-1.5 text-sm ${
              filter === f ? 'border-accent bg-accent/15' : 'border-line'
            }`}
          >
            {f === 'all' ? 'Mindkét jog' : VERB_LABEL[f].name}
          </button>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-5">
          <Card title="Munkatársak">
            <p className="mb-3 text-xs text-ink-faint">
              Válassz ki egy munkatársat, hogy lásd és beállítsd, mely agenteket éri el.
            </p>
            <div className="flex flex-wrap gap-2">
              {users.length === 0 && <p className="text-sm text-ink-faint">Nincs szerkeszthető munkatárs.</p>}
              {users.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => setSelected({ kind: 'user', id: u.id })}
                  aria-pressed={selected?.kind === 'user' && selected.id === u.id}
                  className={`rounded-lg border px-3 py-2 text-left text-sm ${
                    selected?.kind === 'user' && selected.id === u.id
                      ? 'border-accent bg-accent/15'
                      : 'border-line'
                  }`}
                >
                  <span className="block font-medium">{u.name}</span>
                  <span className="block text-xs text-ink-faint">{u.email}</span>
                  {u.status === 'pending' && (
                    <span className="mt-1 inline-block">
                      <Badge tone="warning">Vár első belépésre</Badge>
                    </span>
                  )}
                </button>
              ))}
            </div>
          </Card>

          <Card title="Agentek">
            <p className="mb-3 text-xs text-ink-faint">
              Válassz ki egy agentet, hogy lásd, kiket ér el, és beállítsd a korlátozásait.
            </p>
            <div className="flex flex-wrap gap-2">
              {agents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setSelected({ kind: 'agent', id: a.id })}
                  aria-pressed={selected?.kind === 'agent' && selected.id === a.id}
                  className={`rounded-lg border px-3 py-2 text-left text-sm ${
                    selected?.kind === 'agent' && selected.id === a.id
                      ? 'border-accent bg-accent/15'
                      : 'border-line'
                  }`}
                >
                  <span className="block font-medium">{a.nickname}</span>
                  <span className="block text-xs text-ink-faint">{a.name}</span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {a.status !== 'active' && <Badge tone="warning">{a.status}</Badge>}
                    {a.adminOnly && <Badge tone="neutral">csak adminoknak</Badge>}
                    {a.outboundRestricted && <Badge tone="danger">csak engedéllyel kezdeményez</Badge>}
                  </span>
                </button>
              ))}
            </div>
          </Card>

          {selected && (
            <Card title={`${selectedLabel} kapcsolatai`}>
              <p className="mb-3 text-xs text-ink-faint">
                Pipa = <strong>igen</strong>, üres = <strong>nem</strong>. Kattints a váltáshoz.
              </p>
              <ul className="space-y-2">
                {agents
                  .filter((a) => !(selected.kind === 'agent' && a.id === selected.id))
                  .map((a) => {
                    const verbs =
                      filter === 'all' ? (['view', 'address'] as const) : ([filter] as const)
                    const existing = grants.find(
                      (g) =>
                        g.targetAgentId === a.id &&
                        (selected.kind === 'user'
                          ? g.subjectUserId === selected.id
                          : g.subjectAgentId === selected.id),
                    )
                    return (
                      <li
                        key={a.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-3 py-2"
                      >
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">{a.nickname}</span>
                          <span className="block text-xs text-ink-faint">{a.name}</span>
                        </span>
                        <span className="flex flex-wrap items-center gap-2">
                          {verbs.map((verb) => {
                            // Explicit grant az igazság — ne az „alapból engedett” runtime.
                            const on = existing
                              ? verb === 'view'
                                ? existing.canView
                                : existing.canAddress
                              : false
                            return (
                              <button
                                key={verb}
                                type="button"
                                disabled={pending}
                                onClick={() => toggleVerb(selected, a.id, verb)}
                                aria-pressed={on}
                                title={`${VERB_LABEL[verb].name} — ${VERB_LABEL[verb].hint}`}
                                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 disabled:cursor-wait disabled:opacity-60 ${
                                  on
                                    ? 'border-sage/50 bg-sage/15 text-ink'
                                    : 'border-dashed border-line bg-paper text-ink-soft hover:border-accent hover:bg-accent/10'
                                }`}
                              >
                                <span
                                  aria-hidden
                                  className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs font-bold ${
                                    on
                                      ? 'border-sage bg-sage text-white'
                                      : 'border-line bg-paper text-transparent'
                                  }`}
                                >
                                  ✓
                                </span>
                                <span>{VERB_LABEL[verb].name}</span>
                              </button>
                            )
                          })}
                        </span>
                      </li>
                    )
                  })}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          {selected?.kind === 'agent' && (
            <RestrictionPanel
              agent={agents.find((a) => a.id === selected.id) ?? null}
              pending={pending}
              onPreview={requestDryRun}
            />
          )}

          {selected && cone && (
            <Card title="Meddig ér el ez a jog?">
              {fullyDefaultOpen ? (
                <p className="text-sm">
                  Nincs korlátozás; ez a jog az egész szervezet agenthálózatára kiterjed.
                </p>
              ) : (
                <>
                  <p className="text-sm">
                    <strong>{cone.agentIds.length}</strong> agentet ér el közvetlenül vagy
                    közvetve. Ez azért fontos, mert egy agent a <em>saját</em> jogán dolgozik
                    tovább: ha megszólíthatod, akkor az ő kapcsolatai is a te kérésedet
                    szolgálhatják ki.
                  </p>
                  {cone.maxDepth >= REACHABILITY_DEPTH_WARNING_THRESHOLD && (
                    <p className="mt-2 rounded-lg border border-honey/40 bg-honey/10 px-3 py-2 text-sm">
                      Ez a lánc <strong>{cone.maxDepth}</strong> lépés mély. Érdemes átnézni, hogy
                      tényleg ilyen messzire szeretnéd-e engedni.
                    </p>
                  )}
                  {cone.hasCycle && (
                    <p className="mt-2 text-xs text-ink-faint">
                      A láncban visszacsatolás van (két agent kölcsönösen elérheti egymást). Ez
                      megengedett, a rendszer nem fut körbe tőle.
                    </p>
                  )}
                  <ul className="mt-3 space-y-1 text-xs text-ink-faint">
                    {cone.agentIds.map((id) => (
                      <li key={id}>{agents.find((a) => a.id === id)?.nickname ?? id}</li>
                    ))}
                  </ul>
                </>
              )}
            </Card>
          )}
        </div>
      </div>

      {dryRun && (
        <DryRunDialog run={dryRun} pending={pending} onCancel={() => setDryRun(null)} onConfirm={applyRestriction} />
      )}
    </div>
  )
}

/** Agent→agent kimenő korlátozás (az ember→agent jogok a kapcsolati listában vannak). */
function RestrictionPanel({
  agent,
  pending,
  onPreview,
}: {
  agent: GraphAgentView | null
  pending: boolean
  onPreview: (agent: GraphAgentView, patch: { inboundRestricted?: boolean; outboundRestricted?: boolean }) => void
}) {
  if (!agent) return null
  return (
    <Card title={`${agent.nickname} — kimenő kapcsolatok`}>
      <p className="mb-3 text-xs text-ink-faint">
        Azt, hogy <em>kik</em> látják / szólíthatják meg ezt az agentet, a bal oldali pipák
        döntik el. Itt csak azt állítod, hogy ez az agent kiket érhet el maga.
      </p>
      <label className="flex items-start gap-3 rounded-lg border border-line px-3 py-3 text-sm">
        <input
          type="checkbox"
          checked={agent.outboundRestricted}
          disabled={pending}
          onChange={(e) => onPreview(agent, { outboundRestricted: e.currentTarget.checked })}
          className="mt-1"
        />
        <span>
          <span className="block font-medium">Csak engedéllyel kezdeményezhet</span>
          <span className="mt-1 block text-xs text-ink-faint">
            Ez az agent csak azokat az agenteket éri el, akikhez kifejezetten felvetted a
            kapcsolatát.
          </span>
        </span>
      </label>
    </Card>
  )
}

/** A kötelező hatás-előnézet: mi szűnik meg, mi marad, és mekkora lesz utána a kör. */
function DryRunDialog({
  run,
  pending,
  onCancel,
  onConfirm,
}: {
  run: DryRun
  pending: boolean
  onCancel: () => void
  onConfirm: (run: DryRun) => void
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-access-dryrun-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-line bg-night-2 p-6">
        <h2 id="agent-access-dryrun-title" className="font-display text-xl font-semibold">
          Mi történik, ha ezt beállítod?
        </h2>
        <p className="mt-2 text-sm text-ink-soft">
          <strong>{run.agentName}</strong> — a változtatás előtt nézd át, mi szűnik meg. A rendszer
          semmit nem vesz fel automatikusan helyetted.
        </p>

        <section className="mt-5">
          <h3 className="text-sm font-semibold">Ezek a kapcsolatok megszűnnek</h3>
          {run.losingConnections.length === 0 ? (
            <p className="mt-1 text-sm text-ink-faint">
              Egy ma működő kapcsolat sem szűnik meg ezzel a beállítással.
            </p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {run.losingConnections.map((c, i) => (
                <li key={`${c.subjectId}-${c.targetAgentId}-${c.verb}-${i}`}>
                  {c.subjectLabel} → {c.targetLabel}:{' '}
                  {c.verb === 'view' ? 'nem fogja látni' : 'nem fogja tudni megszólítani'}
                </li>
              ))}
            </ul>
          )}
        </section>

        {run.affectedActivePaths.length > 0 && (
          <section className="mt-5">
            <h3 className="text-sm font-semibold">Éppen futó munka, amit ez érint</h3>
            <ul className="mt-2 space-y-1 text-sm text-ink-soft">
              {run.affectedActivePaths.map((p) => (
                <li key={`${p.kind}-${p.id}`}>
                  {p.kind === 'conversation' ? 'Beszélgetés' : 'Feladat'}: {p.label}
                </li>
              ))}
            </ul>
          </section>
        )}

        {run.keepExplicitGrantIds.length > 0 && (
          <p className="mt-5 text-sm text-ink-soft">
            {run.keepExplicitGrantIds.length} kapcsolat kifejezetten fel van véve, ezek megmaradnak.
          </p>
        )}

        <section className="mt-5">
          <h3 className="text-sm font-semibold">A változás után</h3>
          <p className="mt-1 text-sm">
            Ez az agent <strong>{run.coneAfter.agentIds.length}</strong> további agentet ér el
            közvetve.
            {run.coneAfter.maxDepth >= REACHABILITY_DEPTH_WARNING_THRESHOLD && (
              <> A lánc {run.coneAfter.maxDepth} lépés mély — érdemes átnézni.</>
            )}
          </p>
        </section>

        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button type="button" onClick={onCancel} className="rounded-lg border border-line px-4 py-2 text-sm">
            Mégsem
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => onConfirm(run)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            Értem, állítsd be
          </button>
        </div>
      </div>
    </div>
  )
}
