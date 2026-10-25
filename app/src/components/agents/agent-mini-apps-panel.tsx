'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import {
  getMiniAppSharesAction,
  listMiniAppVersionsAction,
  openMiniAppLinkAction,
  setMiniAppArchivedAction,
  shareMiniAppAction,
  unshareMiniAppAction,
  type AgentMiniAppRow,
} from '@/app/actions/mini-apps'
import { Badge, Card } from '@/components/ui/shell'
import { miniAppLintLabel } from '@/domain/mini-app/lint-labels'
import { miniAppLinkTtlLabel, type MiniAppLinkTtl } from '@/lib/mini-app-settings'

type PanelData = {
  own: AgentMiniAppRow[]
  shared: AgentMiniAppRow[]
  organization: AgentMiniAppRow[]
  linkTtl: MiniAppLinkTtl
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })
}

const buttonClass =
  'rounded-lg border border-line bg-panel px-3 py-1 text-xs font-medium text-ink hover:border-coral/50 disabled:opacity-50'

/** #967 §6: az agent mini appjai — saját, vele megosztott, szervezetben elérhető. */
export function AgentMiniAppsPanel({
  agentName,
  data,
  error,
}: {
  agentId: string
  agentName: string
  data: PanelData | null
  error: string | null
}) {
  const total = data ? data.own.length + data.shared.length + data.organization.length : 0
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-night-2/40 p-4 text-sm text-ink-soft">
        <p>
          A <strong className="text-ink">mini app</strong> egy böngészőben megnyitható oldal (jellemzően riport), amit az
          AI munkatárs készített. Az adatokat a készítéskor beleírja, utána nem frissül magától, és nem tud adatot
          küldeni sehova. Ha frissíteni szeretnéd, kérd meg a munkatársat.
        </p>
      </div>
      {error ? <p className="text-sm text-coral">{error}</p> : null}
      {data && total === 0 ? (
        <Card>
          <p className="text-sm text-ink-soft">
            {agentName} még nem készített mini appot, és vele sem osztottak meg egyet. Kérd meg például így:{' '}
            <em>„Készíts riportot a heti nyitott ügyekről mini appként.”</em>
          </p>
        </Card>
      ) : null}
      {data ? (
        <>
          <MiniAppSection title="Saját" empty="Ez a munkatárs még nem készített mini appot." rows={data.own} linkTtl={data.linkTtl} />
          <MiniAppSection
            title="Vele megosztott"
            empty="Más munkatárs még nem osztott meg vele mini appot."
            rows={data.shared}
            linkTtl={data.linkTtl}
          />
          <MiniAppSection
            title="Szervezetben elérhető"
            empty="Nincs olyan mini app, amit az egész szervezet láthat."
            rows={data.organization}
            linkTtl={data.linkTtl}
          />
        </>
      ) : null}
    </div>
  )
}

function MiniAppSection({ title, empty, rows, linkTtl }: { title: string; empty: string; rows: AgentMiniAppRow[]; linkTtl: MiniAppLinkTtl }) {
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-soft">{empty}</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((row) => (
            <MiniAppRow key={row.appId} row={row} linkTtl={linkTtl} />
          ))}
        </ul>
      )}
    </Card>
  )
}

function SourceBadge({ row }: { row: AgentMiniAppRow }) {
  if (row.relation === 'shared') return <Badge>megosztva: {row.ownerAgentName}</Badge>
  if (row.relation === 'organization') return <Badge>az egész szervezet · {row.ownerAgentName}</Badge>
  return <Badge tone="success">saját</Badge>
}

function MiniAppRow({ row, linkTtl }: { row: AgentMiniAppRow; linkTtl: MiniAppLinkTtl }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [versions, setVersions] = useState<Array<{ version: number; createdAt: string; changeNote: string | null }> | null>(null)
  const [sharing, setSharing] = useState(false)
  const archived = row.status === 'archived'

  const run = (fn: () => Promise<void>) => startTransition(async () => {
    setMessage(null)
    await fn()
  })

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink">{row.name}</span>
        <SourceBadge row={row} />
        {row.visibility === 'organization' && row.relation === 'owner' ? <Badge tone="warning">az egész szervezet látja</Badge> : null}
        {row.copiedFrom ? <Badge>másolat: {row.copiedFrom}</Badge> : null}
        {archived ? <Badge tone="danger">archiválva</Badge> : null}
      </div>
      {row.description ? <p className="text-sm text-ink-soft">{row.description}</p> : null}
      <p className="text-xs text-ink-soft">
        {row.version}. verzió · utoljára módosítva: {formatWhen(row.updatedAt)} · készült: {formatWhen(row.createdAt)}
      </p>
      {row.sharedWith ? (
        <div className="flex flex-wrap gap-1 text-xs">
          <span className="text-ink-soft">Megosztva:</span>
          {row.sharedWith.split(', ').map((name) => (
            <Badge key={name}>{name}</Badge>
          ))}
        </div>
      ) : null}
      {row.lintWarnings.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-honey">
          {row.lintWarnings.map((code) => (
            <li key={code}>{miniAppLintLabel(code)}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!archived ? (
          <>
            <a href={`/control-plane/mini-apps/${row.appId}`} target="_blank" rel="noreferrer" className={buttonClass}>
              Megnyitás
            </a>
            <button
              type="button"
              className={buttonClass}
              disabled={pending}
              onClick={() =>
                preview
                  ? setPreview(null)
                  : run(async () => {
                      const res = await openMiniAppLinkAction({ appId: row.appId })
                      if (res.success) setPreview(res.data.openUrl)
                      else setMessage(res.error)
                    })
              }
            >
              {preview ? 'Előnézet bezárása' : 'Előnézet'}
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={buttonClass}
          disabled={pending}
          onClick={() =>
            versions
              ? setVersions(null)
              : run(async () => {
                  const res = await listMiniAppVersionsAction({ appId: row.appId })
                  if (res.success) setVersions(res.data.versions)
                  else setMessage(res.error)
                })
          }
        >
          {versions ? 'Verziók elrejtése' : 'Verziók'}
        </button>
        <a href={`/api/control-plane/mini-apps/${row.appId}/download`} className={buttonClass}>
          Letöltés .html-ként
        </a>
        {row.canManage && !archived ? (
          <button type="button" className={buttonClass} onClick={() => setSharing((open) => !open)}>
            {sharing ? 'Megosztás bezárása' : 'Megosztás kezelése'}
          </button>
        ) : null}
        {row.canManage ? (
          <button
            type="button"
            className={buttonClass}
            disabled={pending}
            onClick={() => {
              if (
                !archived &&
                !window.confirm('Az app eltűnik a listákból és a megosztások megszűnnek. 90 napig visszaállítható. Archiválod?')
              ) {
                return
              }
              run(async () => {
                const res = await setMiniAppArchivedAction({ appId: row.appId, archived: !archived })
                if (res.success) router.refresh()
                else setMessage(res.error)
              })
            }}
          >
            {archived ? 'Visszaállítás' : 'Archiválás'}
          </button>
        ) : null}
      </div>
      {message ? <p className="text-sm text-coral">{message}</p> : null}
      {versions ? (
        <ul className="space-y-1 rounded-lg border border-line p-3 text-xs">
          {versions.map((v) => (
            <li key={v.version} className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{v.version}. verzió</span>
              <span className="text-ink-soft">{formatWhen(v.createdAt)}</span>
              {v.changeNote ? <span className="text-ink-soft">— {v.changeNote}</span> : null}
              {!archived ? (
                <button
                  type="button"
                  className="text-coral-deep underline"
                  onClick={() =>
                    run(async () => {
                      const res = await openMiniAppLinkAction({ appId: row.appId, version: v.version })
                      if (res.success) setPreview(res.data.openUrl)
                      else setMessage(res.error)
                    })
                  }
                >
                  előnézet
                </button>
              ) : null}
              <a className="text-coral-deep underline" href={`/api/control-plane/mini-apps/${row.appId}/download?version=${v.version}`}>
                letöltés
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {preview ? (
        <iframe
          src={preview}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          title={`${row.name} előnézet`}
          className="h-[520px] w-full rounded-xl border border-line bg-white"
        />
      ) : null}
      {sharing ? <ShareManager appId={row.appId} linkTtl={linkTtl} onChanged={() => router.refresh()} /> : null}
    </li>
  )
}

type ShareState = {
  visibility: string
  shares: Array<{ agentId: string; agentName: string; sharedBy: string; createdAt: string }>
  candidates: Array<{ id: string; name: string }>
}

function ShareManager({ appId, linkTtl, onChanged }: { appId: string; linkTtl: MiniAppLinkTtl; onChanged: () => void }) {
  const [state, setState] = useState<ShareState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pick, setPick] = useState('')
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    let alive = true
    void getMiniAppSharesAction({ appId }).then((res) => {
      if (!alive) return
      if (res.success) setState(res.data)
      else setError(res.error)
    })
    return () => {
      alive = false
    }
  }, [appId])

  const act = (fn: () => Promise<{ success: boolean; error?: string }>) =>
    startTransition(async () => {
      setError(null)
      const res = await fn()
      if (!res.success) setError(res.error ?? 'Hiba történt.')
      const next = await getMiniAppSharesAction({ appId })
      if (next.success) setState(next.data)
      onChanged()
    })

  if (!state) return <p className="text-xs text-ink-soft">{error ?? 'Megosztások betöltése…'}</p>
  const organization = state.visibility === 'organization'
  const sharedIds = new Set(state.shares.map((share) => share.agentId))
  const candidates = state.candidates.filter((candidate) => !sharedIds.has(candidate.id))

  return (
    <div className="space-y-3 rounded-lg border border-line p-3 text-sm">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={organization}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.checked
            if (
              next &&
              !window.confirm(
                'A szervezet minden AI munkatársa — a jövőben létrehozottak is — megnyithatja és lemásolhatja ezt az appot, és rajtuk keresztül minden kolléga, aki ezeket a munkatársakat eléri. Bekapcsolod?',
              )
            ) {
              return
            }
            act(() =>
              next
                ? shareMiniAppAction({ appId, organization: true })
                : unshareMiniAppAction({ appId, organization: true }),
            )
          }}
        />
        <span>
          <span className="font-medium text-ink">Az egész szervezet láthatja</span>
          <span className="block text-xs text-ink-soft">
            A szervezet minden AI munkatársa — a jövőben létrehozottak is — megnyithatja és lemásolhatja ezt az appot.
          </span>
        </span>
      </label>
      <div>
        <p className="font-medium text-ink">Konkrét munkatársak</p>
        {state.shares.length === 0 ? (
          <p className="text-xs text-ink-soft">Még nincs megosztva egyetlen munkatárssal sem.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {state.shares.map((share) => (
              <li key={share.agentId} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold">{share.agentName}</span>
                <span className="text-ink-soft">
                  {formatWhen(share.createdAt)} óta · megosztotta: {share.sharedBy}
                </span>
                <button
                  type="button"
                  className="text-coral-deep underline"
                  disabled={pending}
                  onClick={() => act(() => unshareMiniAppAction({ appId, agentIds: [share.agentId] }))}
                >
                  Visszavonás
                </button>
              </li>
            ))}
          </ul>
        )}
        {candidates.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              className="rounded-lg border border-line bg-night-2 px-2 py-1 text-xs"
            >
              <option value="">Válassz munkatársat…</option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={buttonClass}
              disabled={!pick || pending}
              onClick={() => {
                const agentId = pick
                setPick('')
                act(() => shareMiniAppAction({ appId, agentIds: [agentId] }))
              }}
            >
              Megosztás
            </button>
          </div>
        ) : null}
      </div>
      <p className="text-xs text-ink-soft">
        A már kiadott gyors linkek a lejáratukig (ennél a szervezetnél: {miniAppLinkTtlLabel(linkTtl)}) még működnek. Az
        állandó link azonnal elérhetetlenné válik annak, akinek már nincs hozzáférése.
      </p>
      {error ? <p className="text-xs text-coral">{error}</p> : null}
    </div>
  )
}
