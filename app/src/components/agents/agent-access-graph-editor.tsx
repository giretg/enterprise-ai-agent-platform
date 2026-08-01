'use client'

/**
 * Kapcsolati ábra — az agent-hozzáférési gráf admin szerkesztője (issue #142).
 *
 * ÜZLETI JELENTÉS: ez a „ki kivel beszélhet" szerkesztő. A felhasználónak NEM kell
 * ismernie a `view` / `address` / inbound / outbound / principal szakkifejezéseket:
 * a felület végig hétköznapi magyarul beszél („láthatja" / „megszólíthatja",
 * „csak engedéllyel érhető el"), és minden művelet mellett ott a magyarázat.
 *
 * Az ábra MAGA a policy: a felül lévő sávban a munkatársak, alattuk az agentek; egy
 * irányított kapcsolat két, egymástól FÜGGETLEN sávot hordoz — kék „L" (láthatja) és
 * bordó „M" (megszólíthatja). A két jog nem csak színnel különül el: mindkettőnek van
 * felirata, ikonja, fókuszállapota és billentyűzetes művelete.
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
  connectionState,
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

  const stateFor = useCallback(
    (subject: GraphSubject, targetAgentId: string, verb: 'view' | 'address') =>
      connectionState({
        tenantId,
        agents,
        grants,
        subject,
        targetAgentId,
        verb,
        subjectIsTenantAdmin: true,
      }),
    [tenantId, agents, grants],
  )

  /** Egy ige ki/be kapcsolása. Ha mindkettő lekerül, a kapcsolat sora törlődik. */
  const toggleVerb = (subject: GraphSubject, targetAgentId: string, verb: 'view' | 'address') => {
    const existing = grants.find(
      (g) =>
        g.targetAgentId === targetAgentId &&
        (subject.kind === 'user' ? g.subjectUserId === subject.id : g.subjectAgentId === subject.id),
    )
    const nextView = verb === 'view' ? !(existing?.canView ?? false) : existing?.canView ?? false
    const nextAddress =
      verb === 'address' ? !(existing?.canAddress ?? false) : existing?.canAddress ?? false

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
        setError(res.error)
        return
      }
      setNotice(
        !nextView && !nextAddress
          ? 'A kapcsolat megszűnt.'
          : 'A kapcsolat mentve. Azonnal érvényes minden felületen.',
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
        {fullyDefaultOpen ? (
          <p className="mt-3 rounded-lg border border-honey/40 bg-honey/10 px-3 py-2 text-sm">
            Jelenleg <strong>nincs korlátozás</strong>: a szervezeten belül mindenki elér mindenkit.
            Ez a jog az egész szervezet agenthálózatára kiterjed. Ha szűkíteni szeretnél, kapcsold be
            a korlátozást annál az agentnél, akit védeni akarsz — előtte megmutatjuk, mi szűnne meg.
          </p>
        ) : (
          <p className="mt-3 text-sm text-ink-faint">
            Néhány agentnél korlátozás van bekapcsolva, ezért ott csak a felvett kapcsolatok
            működnek. A többi agentnél továbbra sincs korlátozás.
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
              {users.length === 0 && <p className="text-sm text-ink-faint">Nincs aktív munkatárs.</p>}
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
                    {(a.inboundRestricted || a.outboundRestricted) && (
                      <Badge tone="danger">korlátozott</Badge>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </Card>

          {selected && (
            <Card title={`${selectedLabel} kapcsolatai`}>
              <p className="mb-3 text-xs text-ink-faint">
                Kapcsold be vagy ki jogonként. Ha mindkét jog lekerül, a kapcsolat megszűnik.
                Ahol nincs korlátozás, ott a kapcsolat <em>alapból</em> működik — ilyenkor a
                gomb bekapcsolása csak akkor számít, ha később korlátozást kapcsolsz be.
              </p>
              <ul className="space-y-2">
                {agents
                  .filter((a) => !(selected.kind === 'agent' && a.id === selected.id))
                  .map((a) => {
                    const view = stateFor(selected, a.id, 'view')
                    const address = stateFor(selected, a.id, 'address')
                    if (filter === 'view' && !view.allowed) return null
                    if (filter === 'address' && !address.allowed) return null
                    return (
                      <li
                        key={a.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-3 py-2"
                      >
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">{a.nickname}</span>
                          <span className="block text-xs text-ink-faint">{a.name}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          {(['view', 'address'] as const).map((verb) => {
                            const state = verb === 'view' ? view : address
                            return (
                              <button
                                key={verb}
                                type="button"
                                disabled={pending}
                                onClick={() => toggleVerb(selected, a.id, verb)}
                                aria-pressed={state.basis === 'grant'}
                                title={`${VERB_LABEL[verb].name} — ${VERB_LABEL[verb].hint}`}
                                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold focus-visible:outline focus-visible:outline-2 ${
                                  state.basis === 'grant'
                                    ? verb === 'view'
                                      ? 'border-[#4d86a6] bg-[#4d86a6]/20'
                                      : 'border-[#8c2840] bg-[#8c2840]/20'
                                    : 'border-line text-ink-faint'
                                }`}
                              >
                                <span aria-hidden>{verb === 'view' ? '👁' : '💬'}</span>
                                <span>{VERB_LABEL[verb].short}</span>
                                <span className="sr-only">
                                  {VERB_LABEL[verb].name} — {a.nickname}
                                </span>
                                {state.allowed && state.basis === 'implicit' && (
                                  <span className="font-normal">(alapból)</span>
                                )}
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

/** A kiválasztott agent két korlátozás-kapcsolója, kötelező hatás-előnézettel. */
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
    <Card title={`${agent.nickname} korlátozásai`}>
      <p className="mb-3 text-xs text-ink-faint">
        Amíg egy korlátozás ki van kapcsolva, a szervezeten belül mindenki eléri ezt az agentet.
        Bekapcsolás után csak a kifejezetten felvett kapcsolatok működnek.
      </p>
      <div className="space-y-3">
        <label className="flex items-start gap-3 rounded-lg border border-line px-3 py-3 text-sm">
          <input
            type="checkbox"
            checked={agent.inboundRestricted}
            disabled={pending}
            onChange={(e) => onPreview(agent, { inboundRestricted: e.currentTarget.checked })}
            className="mt-1"
          />
          <span>
            <span className="block font-medium">Csak engedéllyel érhető el</span>
            <span className="mt-1 block text-xs text-ink-faint">
              Ezt az agentet csak azok látják és szólíthatják meg, akiknek kifejezetten felvetted
              a kapcsolatát.
            </span>
          </span>
        </label>
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
              Ez az agent csak azokat a kollégákat éri el, akiket kifejezetten megadtál neki.
            </span>
          </span>
        </label>
      </div>
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
