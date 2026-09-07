'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { Badge, Card } from '@/components/ui/shell'
import { privacyCapabilityLevel, privacyCapabilityUi } from '@/domain/privacy/connector-privacy'
import {
  approveSelfUpdatingSource,
  approveSelfUpdatingVersion,
  listSelfUpdatingConnectors,
  rejectSelfUpdatingVersion,
  rollbackSelfUpdatingVersion,
  setSelfUpdatingAutoApprove,
  setTenantSelfUpdatingAutoApprove,
  syncSelfUpdatingConnector,
  trustSelfUpdatingPartner,
  updateSelfUpdatingConnectorApiKey,
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
  privacy: {
    structured_field_privacy: boolean
    stable_entity_ids: boolean
    entity_resolution: boolean
    free_text_hints: boolean
  } | null
  fetchedAt: string; approvedAt: string | null; approvedByName: string
}
export type SelfUpdatingConnectorRow = {
  id: string; name: string; specUrl: string; urlApproved: boolean; trusted: boolean
  autoApproveEnabled: boolean; lastSyncedAt: string | null; activeSpecVersionId: string | null
  privacy: Version['privacy']
  versions: Version[]
}

function friendlyChange(item: DiffItem) {
  if (item.change?.startsWith('required_param_added')) return `Új kötelező adat szükséges: ${item.change.split(': ').slice(1).join(': ')}.`
  if (item.change?.startsWith('optional_param_added')) return `Új választható adat érhető el: ${item.change.split(': ').slice(1).join(': ')}.`
  if (item.change?.startsWith('param_type_changed')) return `Megváltozott egy kért adat formátuma: ${item.change.split(': ').slice(1).join(': ')}.`
  if (item.change?.startsWith('param_now_required')) return `Egy korábban választható adat mostantól kötelező: ${item.change.split(': ').slice(1).join(': ')}.`
  if (item.change?.startsWith('initial_base_url') || item.change?.startsWith('initial_egress_hosts')) return 'Ez az a partner-cím, ahová a konnektor a hívásokat és a hitelesítést küldi. Első alkalommal mindig ellenőrizni kell.'
  if (item.change?.startsWith('base_url_changed') || item.change?.startsWith('egress_hosts_changed')) return 'Megváltozott, melyik partner-címre küldjük a hívásokat. Ezt biztonsági okból mindig ellenőrizni kell.'
  if (item.change === 'removed') return 'A partner megszüntette ezt a képességet.'
  if (item.change?.startsWith('header_now_required')) return 'A híváshoz mostantól egy új kötelező biztonsági fejléc kell.'
  if (item.change?.startsWith('initial_auth_mode')) return 'A partner által kért beléptetési mód első jóváhagyásra vár.'
  if (item.change?.startsWith('auth_config_changed')) return 'Megváltozott a partner beléptetési beállítása.'
  if (item.change?.startsWith('privacy_capability_added')) {
    return 'A konnektor mostantól jelöli a védendő mezőket, így a platform álnévre tudja cserélni őket.'
  }
  if (item.change?.startsWith('privacy_capability_removed')) {
    return 'A konnektor kevesebb adatvédelmi képességet vállal. Ezt ellenőrizni kell.'
  }
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

export function selfUpdatingSyncFeedback(data: {
  kind: string
  reason?: string
  autoApproved?: boolean
}): { ok: boolean; message: string } {
  if (data.kind === 'failed') {
    const unreachable = ['fetch_failed', 'ssrf_blocked', 'egress_not_allowlisted', 'scheme_blocked'].includes(data.reason ?? '')
    return {
      ok: false,
      message: data.reason === 'unsupported_auth'
        ? 'A partner leírása OAuth-belépést kér, amit ez a kulcs + link típus még nem támogat. Semmit nem vettünk át; a jelenlegi verzió marad érvényben.'
        : unreachable
          ? 'Nem sikerült elérni a partner API-leírását. Semmi nem változott — a konnektor a korábbi állapotban működik tovább. Próbáld később, vagy ellenőrizd a linket.'
          : 'A partner leírását nem sikerült értelmezni, ezért nem vettünk át semmit. A jelenlegi verzió érvényben marad.',
    }
  }
  if (data.kind === 'unchanged') {
    return { ok: true, message: 'A partner leírása nem változott; a jelenlegi állapot marad érvényben.' }
  }
  if (data.autoApproved) {
    return { ok: true, message: 'Az új, csak olvasási képességeket a jóváhagyott szabály szerint automatikusan átvettük.' }
  }
  return { ok: true, message: 'Változást találtunk. Nézd át az alábbi listát; addig minden a régiben marad.' }
}

export function TenantAutoApproveSwitch({
  tenantAuto,
  pending,
  onToggle,
}: {
  tenantAuto: boolean
  pending: boolean
  onToggle: (enabled: boolean) => void
}) {
  return (
    <label className="flex items-start gap-3 text-sm">
      <input
        type="checkbox"
        checked={tenantAuto}
        disabled={pending}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <span>
        <strong>Tisztán új, csak olvasási képességek automatikus átvételének engedélyezése.</strong>
        <br />
        <span className="text-xs text-ink-soft">
          Ez önmagában nem kapcsol be semmit: minden konnektornál külön is engedélyezni kell. Törlő,
          módosító, auth- vagy törésveszélyes változás mindig emberi jóváhagyást kér.
        </span>
      </span>
    </label>
  )
}

export function SelfUpdatingConnectorsPanel({ embedded = false }: { embedded?: boolean }) {
  const [rows, setRows] = useState<SelfUpdatingConnectorRow[]>([])
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [tenantAuto, setTenantAuto] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const reload = useCallback(async () => {
    const result = await listSelfUpdatingConnectors()
    if (!result.success) {
      setError(result.error)
      setLoadedOnce(true)
      return
    }
    setRows(result.data.connectors as SelfUpdatingConnectorRow[])
    setTenantAuto(result.data.tenantAutoApproveEnabled)
    setLoadedOnce(true)
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
      const feedback = selfUpdatingSyncFeedback(result.data)
      if (feedback.ok) setMessage(feedback.message)
      else setError(feedback.message)
      await reload()
    })
  }

  return (
    <div id="onfrissito" className="space-y-6 scroll-mt-6">
      {!embedded ? (
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Önfrissítő konnektorok</h1>
        </div>
      ) : null}

      {message ? <p className="rounded-md border border-sage/35 bg-sage/8 px-3 py-2 text-sm">{message}</p> : null}
      {error ? <p role="alert" className="rounded-md border border-coral/40 bg-coral/8 px-3 py-2 text-sm text-coral">{error}</p> : null}

      <Card title="Tenant biztonsági kapcsoló">
        <TenantAutoApproveSwitch
          tenantAuto={tenantAuto}
          pending={pending}
          onToggle={(enabled) =>
            run(
              () => setTenantSelfUpdatingAutoApprove({ enabled }),
              enabled
                ? 'A tenant engedélyezte a korlátozott automatikus átvételt.'
                : 'Az automatikus átvétel tenant-szinten kikapcsolva.',
            )
          }
        />
      </Card>

      <Card title={loadedOnce ? `Önfrissítő konnektorok (${rows.length})` : 'Önfrissítő konnektorok'}>
        {!loadedOnce ? (
          <p className="text-sm text-ink-soft">Betöltés…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-ink-soft">Még nincs önfrissítő konnektor.</p>
        ) : (
          <div className="space-y-3">
            {rows.map((row) => (
              <SelfUpdatingConnectorCard key={row.id} row={row} pending={pending} run={run} onSync={syncOne} />
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

export function SelfUpdatingConnectorCard({ row, pending, run, onSync }: {
  row: SelfUpdatingConnectorRow; pending: boolean
  run: (operation: () => Promise<{ success: boolean; error?: string }>, success: string) => void
  onSync: (connectorId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [newApiKey, setNewApiKey] = useState('')
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
  const lastSyncedLabel = row.lastSyncedAt
    ? new Date(row.lastSyncedAt).toLocaleString('hu-HU')
    : 'még nem volt sync'
  const toggleOpen = () => setOpen((current) => !current)

  return (
    <div className="rounded-lg border border-ink/12 bg-paper">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button
          type="button"
          className="font-semibold hover:underline"
          onClick={toggleOpen}
        >
          {open ? '▾' : '▸'} {row.name}
        </button>
        <Badge tone="success">önfrissítő</Badge>
        <Badge tone={row.urlApproved ? 'success' : 'warning'}>
          {row.urlApproved ? 'link jóváhagyva' : 'link jóváhagyásra vár'}
        </Badge>
        <Badge tone={row.trusted ? 'success' : 'warning'}>
          {row.trusted ? 'megbízható partner' : 'bizalom nincs jóváhagyva'}
        </Badge>
        {(() => {
          const ui = privacyCapabilityUi(privacyCapabilityLevel(row.privacy))
          return (
            <Badge tone={ui.tone} title={ui.title}>
              {ui.label}
            </Badge>
          )
        })()}
        {proposal ? <Badge tone="warning">frissítés vár</Badge> : null}
        {active ? <Badge tone="neutral">v{active.versionNo}</Badge> : null}
        <Badge tone="neutral">sync: {lastSyncedLabel}</Badge>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-md border border-ink/20 px-2.5 py-1 text-xs font-semibold"
            onClick={toggleOpen}
            aria-expanded={open}
          >
            {open ? 'Bezárás' : 'Részletek'}
          </button>
          <button
            type="button"
            disabled={pending || !row.urlApproved || !row.trusted}
            className="rounded-md border border-ink/20 px-2.5 py-1 text-xs font-semibold disabled:opacity-50"
            onClick={() => onSync(row.id)}
          >
            Frissítés
          </button>
        </div>
      </div>

      {open ? (
        <div className="space-y-4 border-t border-ink/10 px-4 py-4 text-sm">
          <p className="break-all text-xs text-ink-soft">{row.specUrl}</p>

          <div className="flex flex-wrap gap-2">
            {!row.urlApproved ? (
              <button
                disabled={pending}
                className="rounded-md border border-sage/40 px-3 py-1.5 text-xs font-semibold"
                onClick={() => run(() => approveSelfUpdatingSource({ connectorId: row.id }), 'A link jóváhagyva.')}
              >
                Link jóváhagyása
              </button>
            ) : null}
            {!row.trusted ? (
              <button
                disabled={pending}
                className="rounded-md border border-sage/40 px-3 py-1.5 text-xs font-semibold"
                onClick={() => run(() => trustSelfUpdatingPartner({ connectorId: row.id }), 'A partner megbízhatónak minősítve.')}
              >
                Megbízhatónak minősítem
              </button>
            ) : null}
            <button
              disabled={pending || !row.urlApproved || !row.trusted}
              className="rounded-md bg-ink px-3 py-1.5 text-xs font-semibold text-card disabled:opacity-50"
              onClick={() => onSync(row.id)}
            >
              Frissítés keresése
            </button>
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
          <p className="text-xs text-ink-soft">
            Megmutatjuk pontosan, mi változott. Amíg nem hagyod jóvá, minden a régiben marad.
          </p>

          {detailsOpen ? (
            <CapabilityList
              title={detailsTitle}
              capabilities={detailsCapabilities}
              emptyHint="Ehhez a konnektorhoz még nincs átvett vagy javasolt képességlista. Először keress frissítést."
            />
          ) : null}

          <div className="space-y-2 border-t border-ink/10 pt-3">
            <h4 className="text-sm font-semibold">Hozzáférési kulcs cseréje</h4>
            <p className="text-xs text-ink-soft">
              Az új kulcs azonnal felülírja a régit a titoktárolóban, és a következő hívástól ez lesz érvényben.
              A képességlista és a verziók nem változnak. Mentés után a „Frissítés keresése” gombbal ellenőrizhető,
              hogy a partner elfogadja-e az új kulcsot.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-[16rem] flex-1 text-xs">
                <span className="mb-1 block font-semibold">Új hozzáférési kulcs</span>
                <input
                  type="password"
                  value={newApiKey}
                  onChange={(e) => setNewApiKey(e.target.value)}
                  disabled={pending}
                  autoComplete="new-password"
                  placeholder="A partnertől kapott új kulcs"
                  className="w-full rounded-md border border-ink/15 bg-paper px-3 py-2 text-sm disabled:opacity-50"
                />
              </label>
              <button
                type="button"
                disabled={pending || !newApiKey.trim()}
                className="rounded-md border border-ink/20 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                onClick={() => {
                  const apiKey = newApiKey.trim()
                  run(async () => {
                    const result = await updateSelfUpdatingConnectorApiKey({ connectorId: row.id, apiKey })
                    if (result.success) setNewApiKey('')
                    return result
                  }, 'A hozzáférési kulcs frissült.')
                }}
              >
                Kulcs mentése
              </button>
            </div>
          </div>

          <label className="flex items-start gap-2 border-t border-ink/10 pt-3 text-xs">
            <input
              type="checkbox"
              checked={row.autoApproveEnabled}
              disabled={pending}
              onChange={(e) =>
                run(
                  () => setSelfUpdatingAutoApprove({ connectorId: row.id, enabled: e.target.checked }),
                  'A konnektor automatikus átvételi szabálya frissült.',
                )
              }
            />
            <span>
              Ennél a konnektornál a kizárólag új, csak olvasási képességek automatikusan átvehetők, ha a tenant
              kapcsolója is be van kapcsolva.
            </span>
          </label>

          {proposal?.diffSummary ? (
            <div className="space-y-3 border-t border-ink/10 pt-4">
              <h3 className="font-semibold">Változások a(z) „{row.name}” konnektorban</h3>
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
                <button
                  disabled={pending}
                  className="rounded-md border border-ink/20 px-3 py-2 text-xs font-semibold"
                  onClick={() =>
                    run(
                      () => rejectSelfUpdatingVersion({ connectorId: row.id, versionId: proposal.id }),
                      'A változásokat elutasítottad; minden a régiben maradt.',
                    )
                  }
                >
                  Mégse — minden marad a régiben
                </button>
                <button
                  disabled={pending}
                  className="rounded-md bg-coral px-3 py-2 text-xs font-semibold text-white"
                  onClick={() =>
                    run(
                      () => approveSelfUpdatingVersion({ connectorId: row.id, versionId: proposal.id }),
                      'A változások jóváhagyva és rögzítve.',
                    )
                  }
                >
                  Jóváhagyom ezeket a változásokat
                </button>
              </div>
            </div>
          ) : null}

          <div className="border-t border-ink/10 pt-4">
            <h4 className="font-semibold">Korábbi állapotok</h4>
            <p className="mt-1 text-xs text-ink-soft">
              Minden átvett frissítést megőrzünk. Ha gondot okoz, egy kattintással visszaállíthatod.
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-ink-soft">
                    <th className="py-2">Verzió</th>
                    <th>Átvéve</th>
                    <th>Ki hagyta jóvá</th>
                    <th>Állapot</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {row.versions.map((version) => {
                    const isActive = version.id === row.activeSpecVersionId
                    return (
                      <tr key={version.id} className="border-t border-ink/8">
                        <td className="py-2">
                          v{version.versionNo}
                          {isActive ? ' (jelenlegi)' : ''}
                        </td>
                        <td>{new Date(version.approvedAt ?? version.fetchedAt).toLocaleString('hu-HU')}</td>
                        <td>{version.approvedByName}</td>
                        <td>{version.status}</td>
                        <td className="text-right">
                          {!isActive && ['approved', 'superseded', 'rolled_back'].includes(version.status) ? (
                            <button
                              disabled={pending}
                              className="rounded border border-sage/35 px-2 py-1 font-semibold"
                              onClick={() =>
                                run(
                                  () =>
                                    rollbackSelfUpdatingVersion({
                                      connectorId: row.id,
                                      versionId: version.id,
                                    }),
                                  `A konnektor visszaállt a v${version.versionNo} állapotra.`,
                                )
                              }
                            >
                              Visszaállítás
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
