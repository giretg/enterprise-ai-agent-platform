'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { setWarehouseAgentAccessAction, type getWarehouseAgentAccessAction } from '@/app/actions/warehouse'
import { Badge, Card } from '@/components/ui/shell'
import {
  WAREHOUSE_AGENT_ACCESS_OPTIONS,
  warehouseAgentAccessLabel,
  type WarehouseAgentAccess,
} from '@/lib/warehouse-settings'

type AccessData = Extract<Awaited<ReturnType<typeof getWarehouseAgentAccessAction>>, { success: true }>['data']

const selectClass = 'rounded-lg border border-line bg-panel px-2 py-1 text-sm disabled:opacity-50'
const ACCESS_TONE: Record<WarehouseAgentAccess, 'neutral' | 'success' | 'warning'> = { off: 'neutral', read: 'warning', import: 'success' }

function useSave() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  function save(input: Parameters<typeof setWarehouseAgentAccessAction>[0]) {
    setMessage(null)
    startTransition(async () => {
      const res = await setWarehouseAgentAccessAction(input)
      if (!res.success) setMessage({ tone: 'error', text: res.error })
      else {
        setMessage({ tone: 'ok', text: 'Mentve. A munkatárs a következő kérésétől már ezzel a szinttel dolgozik.' })
        router.refresh()
      }
    })
  }
  const banner = message ? (
    <p role={message.tone === 'error' ? 'alert' : 'status'} className={`rounded-lg p-2 text-sm ${message.tone === 'error' ? 'bg-red-50 text-red-800' : 'bg-sage/10 text-ink'}`}>
      {message.text}
    </p>
  ) : null
  return { pending, save, banner }
}

function AccessHelp() {
  return (
    <details className="text-sm text-ink-soft">
      <summary className="cursor-pointer font-medium text-ink">? Hogyan működik a hozzáférés?</summary>
      <div className="mt-2 max-w-3xl space-y-2">
        {WAREHOUSE_AGENT_ACCESS_OPTIONS.map((o) => (
          <p key={o.value}><b>{o.label}:</b> {o.hint}</p>
        ))}
        <p>
          A munkatárs soha nem tud többet, mint az az ember, aki éppen beszél vele: egy olvasó szerepű kolléga a
          munkatárson keresztül sem tölthet be adatot. Új adatkészletet vagy mezőt mindig ember hagy jóvá ezen az oldalon.
        </p>
      </div>
    </details>
  )
}

/** Adattárház oldal + Beállítások: alapérték és munkatársankénti szint. */
export function WarehouseAgentAccessPanel({ data, title = 'AI munkatársak hozzáférése' }: { data: AccessData; title?: string }) {
  const { pending, save, banner } = useSave()
  return (
    <Card title={title}>
      <div id="ai-munkatarsak" className="space-y-4 text-sm">
        <p className="text-ink-soft">Itt döntöd el, melyik AI munkatárs kérdezhet az adattárházból, és melyik tölthet be adatot.</p>
        {banner}
        <label className="flex flex-wrap items-center gap-3">
          <span className="font-medium text-ink">Alapérték minden munkatársnak</span>
          <select
            className={selectClass}
            disabled={!data.canEdit || pending}
            value={data.defaultAgentAccess}
            onChange={(e) => save({ level: e.target.value as WarehouseAgentAccess })}
          >
            {WAREHOUSE_AGENT_ACCESS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <span className="text-ink-soft">— akkor érvényes, ha egy munkatársnak nincs külön beállítása.</span>
        </label>
        {data.agents.length === 0 ? (
          <p className="text-ink-soft">Még nincs AI munkatárs. Amint létrehozol egyet, itt beállíthatod a hozzáférését.</p>
        ) : (
          <table className="w-full text-left">
            <thead className="text-ink-soft"><tr><th className="py-2 pr-4 font-medium">Munkatárs</th><th className="pr-4 font-medium">Hozzáférés</th><th className="font-medium" /></tr></thead>
            <tbody>
              {data.agents.map((agent) => (
                <tr key={agent.id} className="border-t border-ink/10">
                  <td className="py-2 pr-4">
                    <Link className="text-coral-deep underline" href={`/control-plane/agents/${agent.id}`}>{agent.name}</Link>
                    {agent.status !== 'active' ? <span className="text-ink-faint"> (nem aktív)</span> : null}
                  </td>
                  <td className="pr-4">
                    {data.canEdit ? (
                      <select
                        className={selectClass}
                        disabled={pending}
                        aria-label={`${agent.name} hozzáférése`}
                        value={agent.overridden ? agent.access : 'default'}
                        onChange={(e) => save({ agentId: agent.id, level: e.target.value === 'default' ? null : (e.target.value as WarehouseAgentAccess) })}
                      >
                        <option value="default">Alapérték ({warehouseAgentAccessLabel(data.defaultAgentAccess)})</option>
                        {WAREHOUSE_AGENT_ACCESS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : (
                      <Badge tone={ACCESS_TONE[agent.access]}>{warehouseAgentAccessLabel(agent.access)}</Badge>
                    )}
                  </td>
                  <td className="text-ink-soft">{agent.overridden ? 'egyedi beállítás' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!data.canEdit ? <p className="text-ink-soft">A hozzáférést egy admin kolléga módosíthatja.</p> : null}
        <AccessHelp />
      </div>
    </Card>
  )
}

/** Tárolás és korlátok — admin tájékoztatás (környezeti beállítás, nem szerkeszthető a felületen). */
export function WarehouseStorageCard({ storage }: { storage: AccessData['storage'] }) {
  return (
    <Card title="Tárolás és korlátok">
      <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-ink-soft">Hol vannak az adatok?</dt>
          <dd className="font-medium">
            {storage.dedicatedDatabase
              ? 'Külön adattárház-adatbázisban, a céged saját, elkülönített területén'
              : 'A platform adatbázisában, a céged saját, elkülönített területén'}
          </dd>
        </div>
        <div><dt className="text-ink-soft">Legnagyobb feltölthető fájl</dt><dd className="font-medium">{Math.round(storage.maxFileBytes / 1024 / 1024)} MB (.xlsx)</dd></div>
        <div><dt className="text-ink-soft">Egy lekérdezés legfeljebb</dt><dd className="font-medium">{storage.queryMaxRows} sort ad vissza (lapozható)</dd></div>
        <div><dt className="text-ink-soft">Ki módosíthat szerkezetet?</dt><dd className="font-medium">Jóváhagyó vagy admin; betölteni operátor is tud</dd></div>
      </dl>
      <p className="mt-3 text-xs text-ink-soft">
        A tárolás helyét az üzemeltető állítja be (<code>WAREHOUSE_DATABASE_URL</code> környezeti változó); ha nincs megadva,
        az adatok a platform adatbázisában, cégenként külön sémában vannak.
      </p>
    </Card>
  )
}

/** Munkatárs oldal: ennek az egy munkatársnak a szintje. */
export function AgentWarehouseAccessCard({
  agentId,
  data,
}: {
  agentId: string
  data: { canEdit: boolean; ready: boolean; access: WarehouseAgentAccess; overridden: boolean; defaultAgentAccess: WarehouseAgentAccess }
}) {
  const { pending, save, banner } = useSave()
  return (
    <Card title="Adattárház">
      <div className="space-y-3 text-sm">
        <p className="text-ink-soft">
          A céges Excel-táblákból (ügyfelek, rendelések…) épült adattárház. Itt állíthatod, hogy ez a munkatárs kérdezhet-e
          belőle, és tölthet-e be adatot.
        </p>
        {!data.ready ? (
          <p className="rounded-lg bg-honey/10 p-2">Az adattárház még nincs bekapcsolva. <Link className="underline" href="/control-plane/warehouse">Bekapcsolás és feltöltés →</Link></p>
        ) : null}
        {banner}
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium text-ink">Hozzáférés</span>
          {data.canEdit ? (
            <select
              className={selectClass}
              disabled={pending}
              value={data.overridden ? data.access : 'default'}
              onChange={(e) => save({ agentId, level: e.target.value === 'default' ? null : (e.target.value as WarehouseAgentAccess) })}
            >
              <option value="default">Alapérték ({warehouseAgentAccessLabel(data.defaultAgentAccess)})</option>
              {WAREHOUSE_AGENT_ACCESS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <Badge tone={ACCESS_TONE[data.access]}>{warehouseAgentAccessLabel(data.access)}</Badge>
          )}
        </div>
        <p className="text-ink-soft">{WAREHOUSE_AGENT_ACCESS_OPTIONS.find((o) => o.value === data.access)!.hint}</p>
        {!data.canEdit ? <p className="text-ink-soft">A hozzáférést egy admin kolléga módosíthatja.</p> : null}
        <Link className="text-coral-deep underline" href="/control-plane/warehouse">Adattárház megnyitása</Link>
      </div>
    </Card>
  )
}
