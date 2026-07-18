'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState, useTransition } from 'react'
import { Badge, Card } from '@/components/ui/shell'
import {
  approveSelfUpdatingSource,
  approveSelfUpdatingVersion,
  createSelfUpdatingConnector,
  listSelfUpdatingConnectors,
  rejectSelfUpdatingVersion,
  rollbackSelfUpdatingVersion,
  setSelfUpdatingAutoApprove,
  setTenantSelfUpdatingAutoApprove,
  syncSelfUpdatingConnector,
  trustSelfUpdatingPartner,
} from '@/app/actions/self-updating-connectors'

type UsageRef = { type: string; name: string; id: string }
type DiffItem = { op: string; risk: string; change?: string; usedBy?: UsageRef[] }
type Diff = { added: DiffItem[]; breaking: DiffItem[]; narrowed: DiffItem[]; auth: DiffItem[] }
type Capability = {
  name: string; method: string; path: string; access: 'read' | 'write'; description: string | null
}
type Version = {
  id: string; versionNo: number; status: string; diffSummary: Diff | null
  capabilities: Capability[]
  fetchedAt: string; approvedAt: string | null; approvedByName: string
}
type ConnectorRow = {
  id: string; name: string; specUrl: string; urlApproved: boolean; trusted: boolean
  autoApproveEnabled: boolean; lastSyncedAt: string | null; activeSpecVersionId: string | null
  versions: Version[]
}

function friendlyChange(item: DiffItem) {
  if (item.change?.startsWith('required_param_added')) return `Új kötelező adat szükséges: ${item.change.split(': ').slice(1).join(': ')}.`
  if (item.change?.startsWith('optional_param_added')) return `Új választható adat érhető el: ${item.change.split(': ').slice(1).join(': ')}.`
  if (item.change?.startsWith('param_type_changed')) return `Megváltozott egy kért adat formátuma: ${item.change.split(': ').slice(1).join(': ')}.`
  if (item.change?.startsWith('param_now_required')) return `Egy korábban választható adat mostantól kötelező: ${item.change.split(': ').slice(1).join(': ')}.`
  if (item.change?.startsWith('initial_base_url') || item.change?.startsWith('initial_egress_hosts')) return 'Ez az a partner-cím, ahová a kapcsolat a hívásokat és a hitelesítést küldi. Első alkalommal mindig ellenőrizni kell.'
  if (item.change?.startsWith('base_url_changed') || item.change?.startsWith('egress_hosts_changed')) return 'Megváltozott, melyik partner-címre küldjük a hívásokat. Ezt biztonsági okból mindig ellenőrizni kell.'
  if (item.change === 'removed') return 'A partner megszüntette ezt a képességet.'
  if (item.change?.startsWith('header_now_required')) return 'A híváshoz mostantól egy új kötelező biztonsági fejléc kell.'
  if (item.change?.startsWith('initial_auth_mode')) return 'A partner által kért beléptetési mód első jóváhagyásra vár.'
  if (item.change?.startsWith('auth_config_changed')) return 'Megváltozott a partner beléptetési beállítása.'
  if (item.change === 'added_write') return 'Új, adatot módosító képesség.'
  if (item.change === 'added') return 'Új, csak olvasási képesség.'
  return item.change ?? 'A képesség megváltozott.'
}

function capabilityTitle(op: string, capabilities: Capability[]): string | null {
  const match = capabilities.find(
    (cap) => `${cap.method.toUpperCase()} ${cap.path}` === op,
  )
  if (!match) return null
  return match.description?.trim() || match.name
}

function DiffGroup({
  title,
  tone,
  items,
  capabilities = [],
}: {
  title: string
  tone: 'success' | 'danger' | 'warning'
  items: DiffItem[]
  capabilities?: Capability[]
}) {
  if (!items.length) return null
  const colors = tone === 'success' ? 'border-sage/35 bg-sage/8' : tone === 'danger' ? 'border-coral/40 bg-coral/8' : 'border-honey/40 bg-honey/8'
  return (
    <section className={`rounded-md border p-3 ${colors}`}>
      <h4 className="text-sm font-semibold">{title} ({items.length})</h4>
      <ul className="mt-2 space-y-2 text-sm">
        {items.map((item, index) => {
          const label = capabilityTitle(item.op, capabilities)
          return (
            <li key={`${item.op}-${index}`}>
              <p>
                {label ? <span className="font-semibold">{label}</span> : null}
                {label ? <span className="text-ink-soft"> — </span> : null}
                {friendlyChange(item)}{' '}
                <span title="Technikai részlet" className="font-mono text-xs text-ink-soft">
                  ⓘ {item.op}
                </span>
              </p>
              {item.usedBy?.length ? (
                <p className="mt-1 text-xs font-semibold text-coral">
                  Ezt használja: {item.usedBy.map((ref) => ref.name).join(', ')}. Jóváhagyás után frissítésre lehet szükség.
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function CapabilityList({ title, capabilities, emptyHint }: {
  title: string
  capabilities: Capability[]
  emptyHint?: string
}) {
  const reads = capabilities.filter((c) => c.access === 'read').length
  const writes = capabilities.filter((c) => c.access === 'write').length
  return (
    <section className="rounded-md border border-ink/12 bg-paper p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold">{title}</h4>
        {capabilities.length ? (
          <>
            <Badge tone="neutral">{reads} csak olvasás</Badge>
            {writes > 0 ? <Badge tone="warning">{writes} írás</Badge> : null}
          </>
        ) : null}
      </div>
      {!capabilities.length ? (
        <p className="mt-2 text-xs text-ink-soft">{emptyHint ?? 'Még nincs átvett képesség.'}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-ink-soft">
                <th className="py-1.5 pr-3">Funkció</th>
                <th className="pr-3">Jogosultság</th>
                <th>Végpont</th>
              </tr>
            </thead>
            <tbody>
              {capabilities.map((cap) => (
                <tr key={`${cap.method}-${cap.path}-${cap.name}`} className={`border-t border-ink/8 ${cap.access === 'write' ? 'bg-honey/10' : ''}`}>
                  <td className="py-2 pr-3 align-top">
                    <p className="font-semibold">{cap.description?.trim() || cap.name}</p>
                    {cap.description?.trim() ? <p className="mt-0.5 font-mono text-[11px] text-ink-soft">{cap.name}</p> : null}
                  </td>
                  <td className="pr-3 align-top">
                    <Badge tone={cap.access === 'write' ? 'warning' : 'neutral'}>
                      {cap.access === 'write' ? 'írás' : 'csak olvasás'}
                    </Badge>
                  </td>
                  <td className="align-top font-mono text-ink-soft" title="Technikai részlet">
                    ⓘ {cap.method} {cap.path}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function SelfUpdatingConnectorsPanel({ embedded = false }: { embedded?: boolean }) {
  const [rows, setRows] = useState<ConnectorRow[]>([])
  const [tenantAuto, setTenantAuto] = useState(false)
  const [name, setName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [specUrl, setSpecUrl] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const reload = useCallback(async () => {
    const result = await listSelfUpdatingConnectors()
    if (!result.success) { setError(result.error); return }
    setRows(result.data.connectors as ConnectorRow[])
    setTenantAuto(result.data.tenantAutoApproveEnabled)
  }, [])

  useEffect(() => { startTransition(reload) }, [reload])

  const run = (operation: () => Promise<{ success: boolean; error?: string }>, success: string) => {
    setError(null); setMessage(null)
    startTransition(async () => {
      const result = await operation()
      if (!result.success) { setError(result.error ?? 'A művelet nem sikerült.'); return }
      setMessage(success)
      await reload()
    })
  }

  const syncOne = (connectorId: string) => {
    setError(null); setMessage(null)
    startTransition(async () => {
      const result = await syncSelfUpdatingConnector({ connectorId })
      if (!result.success) { setError(result.error); return }
      if (result.data.kind === 'failed') {
        const unreachable = ['fetch_failed', 'ssrf_blocked', 'egress_not_allowlisted', 'scheme_blocked'].includes(result.data.reason)
        setError(result.data.reason === 'unsupported_auth'
          ? 'A partner leírása OAuth-belépést kér, amit ez a kulcs + link típus még nem támogat. Semmit nem vettünk át; a jelenlegi verzió marad érvényben.'
          : unreachable
          ? 'Nem sikerült elérni a partner API-leírását. Semmi nem változott — a kapcsolat a korábbi állapotban működik tovább. Próbáld később, vagy ellenőrizd a linket.'
          : 'A partner leírását nem sikerült értelmezni, ezért nem vettünk át semmit. A jelenlegi verzió érvényben marad.')
      } else if (result.data.kind === 'unchanged') {
        setMessage('A partner leírása nem változott; a jelenlegi állapot marad érvényben.')
      } else if (result.data.autoApproved) {
        setMessage('Az új, csak olvasási képességeket a jóváhagyott szabály szerint automatikusan átvettük.')
      } else {
        setMessage('Változást találtunk. Nézd át az alábbi listát; addig minden a régiben marad.')
      }
      await reload()
    })
  }

  return (
    <div id="onfrissito" className="space-y-6 scroll-mt-6">
      {embedded ? (
        <div>
          <h2 className="font-display text-xl font-semibold tracking-tight">Önfrissítő kapcsolatok</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Kulcs + API-leírás link. A partner új képességeit diffként, külön jóváhagyással veheted át; az agent mindig az utoljára jóváhagyott állapotot használja.
          </p>
        </div>
      ) : (
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Önfrissítő kapcsolatok</h1>
          <p className="mt-1 text-sm text-ink-soft">
            A partner új képességeit ellenőrzötten veheted át; az agent mindig az utoljára jóváhagyott állapotot használja.
          </p>
        </div>
      )}

      {message ? <p className="rounded-md border border-sage/35 bg-sage/8 px-3 py-2 text-sm">{message}</p> : null}
      {error ? <p role="alert" className="rounded-md border border-coral/40 bg-coral/8 px-3 py-2 text-sm text-coral">{error}</p> : null}

      {!embedded ? (
        <Card title="Kapcsolat típusa">
          <div className="grid gap-3 md:grid-cols-2">
            <Link href="/control-plane/provisioning" className="rounded-md border border-ink/15 p-4 hover:border-coral/35">
              <span className="font-semibold">Rögzített kapcsolat</span>
              <p className="mt-1 text-xs text-ink-soft">A képességeket a szokásos onboarding folyamatban állítod be.</p>
            </Link>
            <div className="rounded-md border border-sage/45 bg-sage/8 p-4">
              <span className="font-semibold">🔄 Önfrissítő kapcsolat</span>
              <p className="mt-1 text-xs text-ink-soft">
                Egy kulcs és a partner API-leírásának linkje kell. A későbbi változásokat egy gombbal, átnézés után veheted át.
              </p>
              <p title="A link megmondja, mire képes a partner API-ja. Csak olyan partnernél használd, akiben megbízol." className="mt-2 text-xs font-semibold text-sage">Mit jelent ez? ⓘ</p>
            </div>
          </div>
        </Card>
      ) : null}

      <Card title="Új önfrissítő kapcsolat">
        <div className="space-y-4">
          <label className="block text-sm"><span className="mb-1 block font-semibold">Kapcsolat neve</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-ink/15 bg-paper px-3 py-2" placeholder="Partner CRM" />
          </label>
          <label className="block text-sm"><span className="mb-1 block font-semibold">Hozzáférési kulcs</span>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="w-full rounded-md border border-ink/15 bg-paper px-3 py-2" autoComplete="new-password" />
            <span className="mt-1 block text-xs text-ink-soft">A partnertől kapott titkos kulcs. Biztonságos titoktárolóban marad; az adatbázisba soha nem kerül.</span>
          </label>
          <label className="block text-sm"><span className="mb-1 block font-semibold">API-leírás linkje</span>
            <input value={specUrl} onChange={(e) => setSpecUrl(e.target.value)} className="w-full rounded-md border border-ink/15 bg-paper px-3 py-2" placeholder="https://partner.example/openapi.json" />
            <span className="mt-1 block text-xs text-ink-soft">Innen olvassuk ki a képességeket, de csak amikor megnyomod a Frissítés keresése gombot — sosem magától.</span>
          </label>
          <p className="rounded-md border border-honey/35 bg-honey/8 p-3 text-xs">
            A linket általában egy másik kollégának kell jóváhagynia, mielőtt élesítjük — így biztos, hogy nem elgépelt vagy hamis címről olvasunk.
            Platform-superadmin egyedül is jóváhagyhatja és élesítheti.
          </p>
          <button type="button" disabled={pending || !name.trim() || !apiKey.trim() || !specUrl.trim()} className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-card disabled:opacity-50" onClick={() => run(async () => {
            const result = await createSelfUpdatingConnector({ name, apiKey, specUrl })
            if (result.success) { setName(''); setApiKey(''); setSpecUrl('') }
            return result
          }, 'A kapcsolat létrejött. Jóvá kell hagyni a linket és a partner megbízhatóságát, mielőtt frissítést kereshetsz.')}>
            Kapcsolat létrehozása
          </button>
        </div>
      </Card>

      <Card title="Tenant biztonsági kapcsoló">
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" checked={tenantAuto} disabled={pending} onChange={(e) => {
            const enabled = e.target.checked
            run(() => setTenantSelfUpdatingAutoApprove({ enabled }), enabled ? 'A tenant engedélyezte a korlátozott automatikus átvételt.' : 'Az automatikus átvétel tenant-szinten kikapcsolva.')
          }} />
          <span><strong>Tisztán új, csak olvasási képességek automatikus átvételének engedélyezése.</strong><br />
            <span className="text-xs text-ink-soft">Ez önmagában nem kapcsol be semmit: minden kapcsolatnál külön is engedélyezni kell. Törlő, módosító, auth- vagy törésveszélyes változás mindig emberi jóváhagyást kér.</span>
          </span>
        </label>
      </Card>

      <Card title={`Önfrissítő kapcsolatok (${rows.length})`}>
        {rows.length === 0 ? <p className="text-sm text-ink-soft">Még nincs önfrissítő kapcsolat.</p> : (
          <div className="space-y-4">{rows.map((row) => <ConnectorCard key={row.id} row={row} pending={pending} run={run} onSync={syncOne} />)}</div>
        )}
      </Card>
    </div>
  )
}

function ConnectorCard({ row, pending, run, onSync }: {
  row: ConnectorRow; pending: boolean
  run: (operation: () => Promise<{ success: boolean; error?: string }>, success: string) => void
  onSync: (connectorId: string) => void
}) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const proposal = row.versions.find((version) => version.status === 'proposed')
  const active = row.versions.find((version) => version.id === row.activeSpecVersionId)
  const detailsCapabilities = proposal?.capabilities?.length
    ? proposal.capabilities
    : active?.capabilities ?? []
  const detailsTitle = proposal
    ? `API részletei a javasolt frissítés után (v${proposal.versionNo})`
    : active
      ? `Jelenlegi API részletei (v${active.versionNo})`
      : 'API részletei'
  const diffCapabilities = [...(proposal?.capabilities ?? []), ...(active?.capabilities ?? [])]

  return (
    <article className="rounded-lg border border-ink/12 bg-paper p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="font-semibold">{row.name}</h3><p className="mt-1 break-all text-xs text-ink-soft">{row.specUrl}</p></div>
        <div className="flex gap-2"><Badge tone={row.urlApproved ? 'success' : 'warning'}>{row.urlApproved ? 'link jóváhagyva' : 'link jóváhagyásra vár'}</Badge><Badge tone={row.trusted ? 'success' : 'warning'}>{row.trusted ? 'megbízható partner' : 'bizalom nincs jóváhagyva'}</Badge></div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {!row.urlApproved ? <button disabled={pending} className="rounded-md border border-sage/40 px-3 py-1.5 text-xs font-semibold" onClick={() => run(() => approveSelfUpdatingSource({ connectorId: row.id }), 'A link jóváhagyva.')}>Link jóváhagyása</button> : null}
        {!row.trusted ? <button disabled={pending} className="rounded-md border border-sage/40 px-3 py-1.5 text-xs font-semibold" onClick={() => run(() => trustSelfUpdatingPartner({ connectorId: row.id }), 'A partner megbízhatónak minősítve.')}>Megbízhatónak minősítem</button> : null}
        <button disabled={pending || !row.urlApproved || !row.trusted} className="rounded-md bg-ink px-3 py-1.5 text-xs font-semibold text-card disabled:opacity-50" onClick={() => onSync(row.id)}>🔄 Frissítés keresése</button>
        <button
          type="button"
          disabled={!active && !proposal}
          className="rounded-md border border-ink/20 px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
          onClick={() => setDetailsOpen((open) => !open)}
          aria-expanded={detailsOpen}
        >
          {detailsOpen ? 'API részletek elrejtése' : 'API részletei'}
        </button>
      </div>
      <p className="mt-2 text-xs text-ink-soft">Megmutatjuk pontosan, mi változott. Amíg nem hagyod jóvá, minden a régiben marad.</p>

      {detailsOpen ? (
        <div className="mt-4">
          <CapabilityList
            title={detailsTitle}
            capabilities={detailsCapabilities}
            emptyHint="Ehhez a kapcsolathoz még nincs átvett vagy javasolt képességlista. Először keress frissítést."
          />
        </div>
      ) : null}

      <label className="mt-4 flex items-start gap-2 border-t border-ink/10 pt-3 text-xs">
        <input type="checkbox" checked={row.autoApproveEnabled} disabled={pending} onChange={(e) => run(() => setSelfUpdatingAutoApprove({ connectorId: row.id, enabled: e.target.checked }), 'A kapcsolat automatikus átvételi szabálya frissült.')} />
        <span>Ennél a kapcsolatnál a kizárólag új, csak olvasási képességek automatikusan átvehetők, ha a tenant kapcsolója is be van kapcsolva.</span>
      </label>

      {proposal?.diffSummary ? (
        <div className="mt-4 space-y-3 border-t border-ink/10 pt-4">
          <h3 className="font-semibold">Változások a(z) „{row.name}” kapcsolatban</h3>
          <DiffGroup
            title="🟢 Új képességek"
            tone="success"
            items={proposal.diffSummary.added}
            capabilities={diffCapabilities}
          />
          <DiffGroup
            title="🔴 Törésveszélyes változások"
            tone="danger"
            items={proposal.diffSummary.breaking}
            capabilities={diffCapabilities}
          />
          <DiffGroup
            title="🟠 Visszavont képességek"
            tone="warning"
            items={proposal.diffSummary.narrowed}
            capabilities={diffCapabilities}
          />
          <DiffGroup
            title="🔴 Beléptetési vagy kötelező fejléc-változások"
            tone="danger"
            items={proposal.diffSummary.auth}
            capabilities={diffCapabilities}
          />
          <CapabilityList
            title="Teljes funkciólista a javasolt frissítés után"
            capabilities={proposal.capabilities ?? []}
            emptyHint="A javasolt verzióhoz nem sikerült kiolvasni a képességlistát."
          />
          <div className="flex flex-wrap gap-2">
            <button disabled={pending} className="rounded-md border border-ink/20 px-3 py-2 text-xs font-semibold" onClick={() => run(() => rejectSelfUpdatingVersion({ connectorId: row.id, versionId: proposal.id }), 'A változásokat elutasítottad; minden a régiben maradt.')}>Mégse — minden marad a régiben</button>
            <button disabled={pending} className="rounded-md bg-coral px-3 py-2 text-xs font-semibold text-white" onClick={() => run(() => approveSelfUpdatingVersion({ connectorId: row.id, versionId: proposal.id }), 'A változások jóváhagyva és rögzítve.')}>Jóváhagyom ezeket a változásokat</button>
          </div>
        </div>
      ) : null}

      <div className="mt-5 border-t border-ink/10 pt-4">
        <h4 className="font-semibold">Korábbi állapotok</h4>
        <p className="mt-1 text-xs text-ink-soft">Minden átvett frissítést megőrzünk. Ha gondot okoz, egy kattintással visszaállíthatod.</p>
        <div className="mt-2 overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="text-ink-soft"><th className="py-2">Verzió</th><th>Átvéve</th><th>Ki hagyta jóvá</th><th>Állapot</th><th /></tr></thead><tbody>
          {row.versions.map((version) => { const active = version.id === row.activeSpecVersionId; return <tr key={version.id} className="border-t border-ink/8"><td className="py-2">v{version.versionNo}{active ? ' (jelenlegi)' : ''}</td><td>{new Date(version.approvedAt ?? version.fetchedAt).toLocaleString('hu-HU')}</td><td>{version.approvedByName}</td><td>{version.status}</td><td className="text-right">{!active && ['approved', 'superseded', 'rolled_back'].includes(version.status) ? <button disabled={pending} className="rounded border border-sage/35 px-2 py-1 font-semibold" onClick={() => run(() => rollbackSelfUpdatingVersion({ connectorId: row.id, versionId: version.id }), `A kapcsolat visszaállt a v${version.versionNo} állapotra.`)}>Visszaállítás</button> : null}</td></tr> })}
        </tbody></table></div>
      </div>
    </article>
  )
}
