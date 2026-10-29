'use client'

import { useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  activateWarehouseAction,
  commitImportAction,
  confirmDatasetAction,
  previewImportAction,
  resolveExceptionAction,
  rollbackImportAction,
  uploadWarehouseFileAction,
  type loadWarehousePageAction,
} from '@/app/actions/warehouse'
import type { ImportPreview } from '@/domain/warehouse/warehouse-service'
import type { PlanCheck } from '@/domain/warehouse/plan'
import { Badge, Card } from '@/components/ui/shell'
import {
  warehouseFieldTypeLabel,
  warehouseMessage,
  warehouseUploadFileIssue,
  warehouseUploadStatus,
  WAREHOUSE_UPLOAD_NEED_FILE,
  WAREHOUSE_UPLOAD_NEED_ROLE,
} from '@/lib/warehouse-labels'

type PageData = Extract<Awaited<ReturnType<typeof loadWarehousePageAction>>, { success: true }>['data']
type ReadyData = Extract<PageData, { ready: true }>

const STATE_LABEL: Record<string, string> = {
  received: 'Átvéve',
  profiled: 'Átvizsgálva',
  awaiting_plan: 'Betöltési tervre vár',
  planned: 'Terv kész',
  previewed: 'Előnézet kész',
  awaiting_approval: 'Jóváhagyásra vár',
  loading: 'Betöltés folyamatban',
  published: 'Betöltve',
  awaiting_ai: 'AI-értelmezésre vár',
  awaiting_clarification: 'Tisztázásra vár',
  failed: 'Sikertelen',
  rolled_back: 'Visszavonva',
}

const STATE_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  published: 'success',
  awaiting_approval: 'warning',
  awaiting_plan: 'warning',
  failed: 'danger',
}

const EXCEPTION_LABEL: Record<string, string> = {
  suggested_link: 'Hasonló név — megerősítés kell',
  ambiguous_link: 'Több lehetséges ügyfél',
  unmatched_link: 'Nem található a törzsben',
  invalid_value: 'Hibás érték — a sor nem töltődött be',
  missing_required: 'Hiányzó kötelező érték',
  missing_key: 'Hiányzó azonosító',
  duplicate_key: 'Ismétlődő azonosító a fájlban',
}

const APPROVAL_LABEL: Record<string, string> = {
  new_dataset: 'új adatkészlet jön létre',
  new_fields: 'új mezők jönnek létre',
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' }) : '—'
}

function Help({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="text-sm text-ink-soft">
      <summary className="cursor-pointer font-medium text-ink">? {label}</summary>
      <div className="mt-2 max-w-3xl space-y-2">{children}</div>
    </details>
  )
}

export function WarehousePanel({ data, selectedImportId }: { data: PageData; selectedImportId: string | null }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null)

  function act(fn: () => Promise<{ success: boolean; error?: string }>, okText?: string, after?: () => void) {
    setMessage(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.success) setMessage({ tone: 'error', text: res.error ?? 'A művelet nem sikerült.' })
      else {
        if (okText) setMessage({ tone: 'ok', text: okText })
        after?.()
        router.refresh()
      }
    })
  }

  const banner = message ? (
    <p role={message.tone === 'error' ? 'alert' : 'status'} className={`rounded-lg p-3 text-sm ${message.tone === 'error' ? 'bg-red-50 text-red-800' : 'bg-sage/10 text-ink'}`}>
      {message.text}
    </p>
  ) : null

  if (!data.ready) {
    const status = data.status?.status
    return (
      <div className="space-y-4">
        {banner}
        <Card title={status === 'failed' ? 'Az adattárház létrehozása nem sikerült' : 'Az adattárház még nincs bekapcsolva'}>
          <p className="text-sm text-ink-soft">
            {status === 'failed'
              ? 'A már elkészült részek megmaradtak; az újrapróbálás onnan folytatja, ahol abbamaradt.'
              : 'Bekapcsoláskor a cégednek saját, elkülönített adatterület készül. Más cég nem látja, és az AI munkatársak is csak a te jogosultságaiddal érik el.'}
          </p>
          {data.permissions.operate ? (
            <button type="button" disabled={pending} onClick={() => act(() => activateWarehouseAction(), 'Az adattárház használatra kész.')} className="mt-4 rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {pending ? 'Létrehozás…' : status === 'failed' ? 'Újrapróbálom' : 'Adattárház létrehozása'}
            </button>
          ) : (
            <p className="mt-3 text-sm">A bekapcsolást egy admin kolléga végezheti el.</p>
          )}
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {banner}
      <UsageStrip data={data} />
      {data.permissions.import ? (
        <UploadCard pending={pending} act={act} onUploaded={(id) => router.push(`/control-plane/warehouse?import=${id}`)} />
      ) : (
        <Card title="Excel feltöltése">
          <p className="text-sm text-ink-soft">{WAREHOUSE_UPLOAD_NEED_ROLE}</p>
        </Card>
      )}
      {data.selected ? <ImportDetail data={data} pending={pending} act={act} /> : selectedImportId ? <p className="text-sm text-ink-soft">Ez a betöltés nem található.</p> : null}
      <ExceptionsCard data={data} pending={pending} act={act} />
      <DatasetsCard data={data} pending={pending} act={act} />
      <ImportsCard data={data} />
    </div>
  )
}

type Act = (fn: () => Promise<{ success: boolean; error?: string }>, okText?: string, after?: () => void) => void

function UsageStrip({ data }: { data: ReadyData }) {
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
      <div><dt className="text-ink-soft">Adatkészletek</dt><dd className="font-semibold">{data.datasets.length}</dd></div>
      <div><dt className="text-ink-soft">Tárolt adat</dt><dd className="font-semibold">{formatBytes(data.usage.storageBytes)}</dd></div>
      <div><dt className="text-ink-soft">Betöltések</dt><dd className="font-semibold">{data.usage.publishedImports} / {data.usage.imports}</dd></div>
      <div><dt className="text-ink-soft">E havi betöltött sorok</dt><dd className="font-semibold">{data.usage.rowsLoadedThisMonth}</dd></div>
      <div><dt className="text-ink-soft">Döntésre vár</dt><dd className="font-semibold">{data.exceptions.length}</dd></div>
    </dl>
  )
}

function UploadCard({ pending, act, onUploaded }: { pending: boolean; act: Act; onUploaded: (importId: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [issue, setIssue] = useState<string | null>(null)
  const status = warehouseUploadStatus({ canImport: true, pending, fileName: file?.name ?? null, issue })
  const hintId = 'warehouse-upload-hint'

  function pick(next: File | null) {
    if (!next) {
      setFile(null)
      setIssue(null)
      return
    }
    const nextIssue = warehouseUploadFileIssue(next)
    setFile(nextIssue ? null : next)
    setIssue(nextIssue)
  }

  return (
    <Card title="Excel feltöltése">
      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (pending) return
          if (!file) {
            setIssue(WAREHOUSE_UPLOAD_NEED_FILE)
            inputRef.current?.click()
            return
          }
          const form = new FormData()
          form.set('file', file)
          let importId: string | null = null
          act(
            async () => {
              const res = await uploadWarehouseFileAction(form)
              if (res.success) importId = res.data.importId
              return res
            },
            'Feltöltve. Ha a szerkezet ismert, az előnézet azonnal kérhető; különben kérd meg az AI munkatársad, hogy készítse el a betöltési tervet.',
            () => importId && onUploaded(importId),
          )
        }}
      >
        <label className="inline-flex cursor-pointer items-center rounded-lg border border-ink/20 bg-panel px-3 py-2 text-sm font-medium hover:bg-ink/5">
          Fájl kiválasztása
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            aria-describedby={hintId}
            onChange={(event) => {
              pick(event.target.files?.[0] ?? null)
              event.target.value = ''
            }}
          />
        </label>
        <span className="text-sm text-ink-soft">{file ? file.name : 'Nincs fájl kiválasztva'}</span>
        <button
          type="submit"
          disabled={pending}
          aria-describedby={hintId}
          className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'Feltöltés…' : 'Feltöltés'}
        </button>
      </form>
      <p id={hintId} role={status.tone === 'error' ? 'alert' : 'status'} className={`mt-2 text-sm ${status.tone === 'error' ? 'text-red-800' : 'text-ink-soft'}`}>
        {status.text}
      </p>
      <div className="mt-3">
        <Help label="Mi történik feltöltés után?">
          <p>A platform átvizsgálja a fájlt (munkalapok, fejléc, típusok, magyar szám- és dátumformátumok). Az eredeti fájl megmarad.</p>
          <p>Ha már töltöttél be ilyen szerkezetű fájlt, a mentett „recept” alapján AI nélkül készül a terv. Ha új a szerkezet, írd az AI munkatársadnak: „Töltsd be az adattárházba a most feltöltött Excelt.” — ő javasolja, melyik oszlop mit jelent.</p>
          <p>Legfeljebb 10 MB, .xlsx formátum.</p>
        </Help>
      </div>
    </Card>
  )
}

function CountsTable({ preview }: { preview: ImportPreview }) {
  const c = preview.counts
  const rows: Array<[string, number]> = [
    ['Sorok a fájlban', c.sourceRows],
    ['Új rekord', c.new],
    ['Módosuló rekord', c.updated],
    ['Változatlan', c.unchanged],
    ['Hibás sor (nem töltődik be)', c.invalidRows],
    ['Ismétlődő azonosító a fájlban', c.duplicateKeys],
  ]
  return (
    <div className="space-y-3">
      <table className="text-sm">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}><td className="pr-6 text-ink-soft">{label}</td><td className="font-semibold">{value}</td></tr>
          ))}
        </tbody>
      </table>
      {Object.entries(c.links).map(([field, s]) => (
        <p key={field} className="text-sm">
          <span className="font-medium">Kapcsolás ({field}):</span> {s.matched + s.viaAlias} összekapcsolva · {s.suggested} javaslat · {s.ambiguous} több jelölt · {s.unmatched} nem található · {s.empty} üres
        </p>
      ))}
    </div>
  )
}

function ImportDetail({ data, pending, act }: { data: ReadyData; pending: boolean; act: Act }) {
  const selected = data.selected!
  const record = selected.import
  const preview = record.preview as ImportPreview | null
  const check = record.checkResult as (PlanCheck & { drift?: { datasetKey: string; missingColumns: string[]; newColumns: string[] } }) | null
  const needsApproval = record.approvalReasons.length > 0
  return (
    <Card title={`Betöltés: ${record.fileName}`}>
      <div className="space-y-4 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <Badge tone={STATE_TONE[record.state] ?? 'neutral'}>{STATE_LABEL[record.state] ?? record.state}</Badge>
          {record.planSource === 'recipe' ? <Badge tone="success">Mentett recept alapján (AI nélkül)</Badge> : record.planSource === 'ai' ? <Badge>AI javaslata</Badge> : null}
          <span className="text-ink-soft">Azonosító (az AI-nak): <code>{record.id}</code></span>
        </p>
        {check?.drift ? (
          <p className="rounded-lg bg-honey/10 p-3">
            A fájl szerkezete eltér a(z) <b>{check.drift.datasetKey}</b> korábbi betöltéseitől. Hiányzó oszlop: {check.drift.missingColumns.join(', ') || '—'}; új oszlop: {check.drift.newColumns.join(', ') || '—'}. Kérd meg az AI munkatársat, hogy egyeztesse veled, mit jelentenek.
          </p>
        ) : null}
        {record.state === 'awaiting_plan' && check && 'errors' in check && check.errors?.length ? (
          <div className="rounded-lg bg-red-50 p-3 text-red-800">
            <p className="font-medium">A betöltési terv még nem jó:</p>
            <ul className="ml-5 list-disc">{check.errors.map((e, i) => <li key={i}>{warehouseMessage(e.code)}</li>)}</ul>
          </div>
        ) : null}
        {record.state === 'awaiting_plan' && !check?.errors?.length ? (
          <p className="text-ink-soft">Írd az AI munkatársadnak: „Töltsd be az adattárházba a(z) {record.fileName} fájlt (azonosító: {record.id}).”</p>
        ) : null}
        {record.plan ? (
          <details>
            <summary className="cursor-pointer font-medium">Betöltési terv: {record.plan.dataset.title} ({record.plan.dataset.key}) · {record.plan.mode === 'upsert' ? `frissítés azonosító szerint: ${record.plan.businessKey.join(', ')}` : 'hozzáfűzés'}</summary>
            <table className="mt-2 w-full text-left">
              <thead className="text-ink-soft"><tr><th className="pr-4 font-medium">Excel-oszlop</th><th className="pr-4 font-medium">Mező</th><th className="pr-4 font-medium">Típus</th><th className="font-medium">Jelentés (javaslat)</th></tr></thead>
              <tbody>
                {record.plan.fields.map((f) => (
                  <tr key={f.target} className="border-t border-ink/10 align-top"><td className="pr-4">{f.source}</td><td className="pr-4"><code>{f.target}</code></td><td className="pr-4">{warehouseFieldTypeLabel(f.type)}{f.currency ? ` (${f.currency})` : ''}</td><td>{f.label}{f.meaning ? ` — ${f.meaning}` : ''}</td></tr>
                ))}
                {record.plan.links.map((l) => (
                  <tr key={l.as} className="border-t border-ink/10"><td className="pr-4">{l.field}</td><td className="pr-4"><code>{l.as}</code></td><td className="pr-4">kapcsolat</td><td>→ {l.toDataset}.{l.toField} ({l.by === 'key' ? 'azonosító' : 'név'} szerint)</td></tr>
                ))}
              </tbody>
            </table>
          </details>
        ) : null}
        {preview && ['previewed', 'awaiting_approval'].includes(record.state) ? <CountsTable preview={preview} /> : null}
        {needsApproval && ['previewed', 'awaiting_approval'].includes(record.state) ? (
          <p className="rounded-lg bg-honey/10 p-3">Jóváhagyás kell, mert {record.approvalReasons.map((r) => APPROVAL_LABEL[r] ?? r).join(' és ')}. Nézd át a tervet: az oszlopok jelentése az AI javaslata.</p>
        ) : null}
        {record.result && record.state === 'published' ? (
          <p className="rounded-lg bg-sage/10 p-3">
            Betöltve: {String((record.result as Record<string, unknown>).inserted)} új, {String((record.result as Record<string, unknown>).updated)} módosult, {String((record.result as Record<string, unknown>).unchanged)} változatlan. Döntésre váró tétel: {String((record.result as Record<string, unknown>).openExceptions)}.
          </p>
        ) : null}
        {record.state === 'failed' ? <p className="rounded-lg bg-red-50 p-3 text-red-800">A betöltés nem sikerült; semmi sem változott. Kérj új előnézetet, és próbáld újra.</p> : null}
        <div className="flex flex-wrap gap-2">
          {data.permissions.import && ['planned', 'previewed', 'awaiting_approval', 'failed'].includes(record.state) && record.plan ? (
            <button type="button" disabled={pending} onClick={() => act(() => previewImportAction({ importId: record.id }))} className="rounded-lg border border-ink/20 px-3 py-1.5 font-medium disabled:opacity-50">
              {preview ? 'Előnézet frissítése' : 'Előnézet'}
            </button>
          ) : null}
          {record.previewHash && ['previewed', 'awaiting_approval'].includes(record.state) && (needsApproval ? data.permissions.schema : data.permissions.import) ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => act(() => commitImportAction({ importId: record.id, previewHash: record.previewHash!, approve: needsApproval }), 'Betöltve.')}
              className="rounded-lg bg-ink px-3 py-1.5 font-semibold text-white disabled:opacity-50"
            >
              {needsApproval ? 'Jóváhagyom és betöltöm' : 'Betöltés'}
            </button>
          ) : null}
          {needsApproval && record.state === 'awaiting_approval' && !data.permissions.schema ? <p className="text-ink-soft">A jóváhagyást egy jóváhagyó vagy admin kolléga végezheti el.</p> : null}
          {record.state === 'published' && data.permissions.schema ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (window.confirm('A betöltés visszavonása: az új rekordok törlődnek, a módosítottak visszakapják korábbi értéküket. Folytatod?')) {
                  act(() => rollbackImportAction({ importId: record.id }), 'A betöltés visszavonva.')
                }
              }}
              className="rounded-lg border border-coral/40 px-3 py-1.5 font-medium text-coral disabled:opacity-50"
            >
              Betöltés visszavonása
            </button>
          ) : null}
        </div>
      </div>
    </Card>
  )
}

function ExceptionsCard({ data, pending, act }: { data: ReadyData; pending: boolean; act: Act }) {
  if (data.exceptions.length === 0) return null
  return (
    <Card title="Döntésre váró tételek">
      <Help label="Miért kell itt dönteni?">
        <p>A platform nem kapcsol össze rekordokat találgatással. Ha egy rendelésben szereplő név nem pontosan egyezik az ügyféltörzzsel (pl. „Kovács Borház” ↔ „Kovács Borház Kft.”), az csak javaslat, amíg valaki meg nem erősíti.</p>
        <p>A megerősített párosítást a platform megjegyzi: a következő betöltésnél már magától köti össze.</p>
      </Help>
      <ul className="mt-3 divide-y divide-ink/10 text-sm">
        {data.exceptions.slice(0, 100).map((e) => (
          <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
            <div>
              <p className="font-medium">{EXCEPTION_LABEL[e.kind] ?? 'Ellenőrzendő adat'}: „{e.value ?? '—'}”</p>
              <p className="text-ink-soft">{data.datasets.find((d) => d.key === e.datasetKey)?.title ?? 'Adatkészlet'}{e.sourceRow ? ` · ${e.sourceRow}. sor` : ''}{e.kind === 'invalid_value' && e.detail ? ` · ${warehouseMessage(e.detail)}` : ''}</p>
            </div>
            {data.permissions.schema ? (
              <div className="flex flex-wrap gap-2">
                {(e.candidates ?? []).map((c) => (
                  <button key={c.id} type="button" disabled={pending} onClick={() => act(() => resolveExceptionAction({ exceptionId: e.id, action: 'link', targetId: c.id }), 'Összekapcsolva és megjegyezve.')} className="rounded-lg border border-ink/20 px-3 py-1 disabled:opacity-50">
                    Ez az: {c.label}
                  </button>
                ))}
                <button type="button" disabled={pending} onClick={() => act(() => resolveExceptionAction({ exceptionId: e.id, action: 'dismiss' }))} className="rounded-lg px-3 py-1 text-ink-soft underline disabled:opacity-50">
                  Rendben így (nem kapcsolom)
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function DatasetsCard({ data, pending, act }: { data: ReadyData; pending: boolean; act: Act }) {
  return (
    <Card title="Adatkészletek">
      {data.datasets.length === 0 ? (
        <p className="text-sm text-ink-soft">Még nincs adat. Tölts fel egy Excel-táblát (pl. ügyféllistát), vagy kérd az AI munkatársadat, hogy töltse be.</p>
      ) : (
        <ul className="space-y-4 text-sm">
          {data.datasets.map((d) => (
            <li key={d.key} className="rounded-lg border border-ink/10 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                  {d.title} <code className="text-ink-soft">{d.key}</code>{' '}
                  <Badge tone={d.definitionStatus === 'confirmed' ? 'success' : 'warning'} title={d.definitionStatus === 'confirmed' ? 'Egy kolléga megerősítette a mezők jelentését.' : 'A mezők jelentése az AI javaslata — amíg nincs megerősítve, az AI jelzi a válaszaiban.'}>
                    {d.definitionStatus === 'confirmed' ? 'Megerősített jelentés' : 'Javasolt jelentés'}
                  </Badge>
                </p>
                <div className="flex gap-2">
                  {d.definitionStatus !== 'confirmed' && data.permissions.schema ? (
                    <button type="button" disabled={pending} onClick={() => act(() => confirmDatasetAction({ datasetKey: d.key }), 'A mezők jelentése megerősítve.')} className="rounded-lg border border-ink/20 px-3 py-1 disabled:opacity-50">
                      Megerősítem a jelentéseket
                    </button>
                  ) : null}
                  <a href={`/api/control-plane/warehouse/export/${d.key}`} className="rounded-lg border border-ink/20 px-3 py-1">Letöltés (Excel)</a>
                </div>
              </div>
              <p className="mt-1 text-ink-soft">{d.rowMeaning ?? ''} · {d.rows} sor · frissítve: {formatDate(d.publishedAt)}{d.openExceptions ? ` · ${d.openExceptions} döntésre vár` : ''}</p>
              <details className="mt-2">
                <summary className="cursor-pointer">Mezők ({d.fields.length})</summary>
                <table className="mt-2 w-full text-left">
                  <tbody>
                    {d.fields.map((f) => (
                      <tr key={f.name} className="border-t border-ink/10 align-top">
                        <td className="pr-4"><code>{f.name}</code>{d.businessKey.includes(f.name) ? ' 🔑' : ''}</td>
                        <td className="pr-4">{f.role === 'link' ? `kapcsolat → ${f.linkDataset}` : warehouseFieldTypeLabel(f.type)}{f.currency ? ` (${f.currency}${f.amountBasis ? `, ${f.amountBasis === 'net' ? 'nettó' : f.amountBasis === 'gross' ? 'bruttó' : '?'}` : ''})` : ''}</td>
                        <td>{f.label}{f.meaning ? ` — ${f.meaning}` : ''}{f.status !== 'confirmed' ? <span className="text-ink-faint"> (javaslat)</span> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function ImportsCard({ data }: { data: ReadyData }) {
  if (data.imports.length === 0) return null
  return (
    <Card title="Betöltések">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-ink-soft"><tr><th className="py-2 pr-4 font-medium">Fájl</th><th className="pr-4 font-medium">Állapot</th><th className="pr-4 font-medium">Adatkészlet</th><th className="pr-4 font-medium">Feltöltve</th><th className="font-medium">Betöltve</th></tr></thead>
          <tbody>
            {data.imports.map((i) => (
              <tr key={i.id} className="border-t border-ink/10">
                <td className="py-2 pr-4"><Link className="text-coral-deep underline" href={`/control-plane/warehouse?import=${i.id}`}>{i.fileName}</Link></td>
                <td className="pr-4"><Badge tone={STATE_TONE[i.state] ?? 'neutral'}>{STATE_LABEL[i.state] ?? i.state}</Badge></td>
                <td className="pr-4">{i.datasetKey ?? '—'}</td>
                <td className="pr-4">{formatDate(i.createdAt)}</td>
                <td>{formatDate(i.publishedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
