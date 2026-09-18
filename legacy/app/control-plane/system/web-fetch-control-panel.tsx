'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import { setWebFetchControls } from '@/app/actions/web-search'

export type WebFetchControlsView = {
  enabled: boolean
  discoveryEnabled: boolean
  updatedById: string | null
  updatedAt: string | null
}

export function WebFetchControlPanel({
  initial,
  canEdit,
}: {
  initial: WebFetchControlsView
  canEdit: boolean
}) {
  const [controls, setControls] = useState(initial)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function save(patch: { enabled?: boolean; discoveryEnabled?: boolean }) {
    setMessage(null)
    startTransition(async () => {
      const res = await setWebFetchControls(patch)
      if (res.success) {
        setControls(res.data)
        setMessage({ tone: 'ok', text: 'Mentve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  // A felfedezés csak akkor tényleges, ha a web_fetch platform-tool is engedélyezett.
  const discoveryEffective = controls.enabled && controls.discoveryEnabled

  return (
    <Card title="Web Fetch & Web-Discovery (kontrollált tartalom-letöltés)">
      <div className="space-y-6">
        <p className="text-xs text-ink-soft">
          A platform egyetlen új kimenő-hálózati felülete. Deny-by-default, SSRF-őr + web-egress role
          (dual-LLM izoláció). Mindkét kapcsoló <strong>alapból KI</strong>; bekapcsolatlanul a
          viselkedés bit-azonos a korábbival.
        </p>

        {/* web_fetch globális kill-switch (§7.2/1) */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex h-2.5 w-2.5 rounded-full ${controls.enabled ? 'bg-emerald-400' : 'bg-red-400'}`}
            />
            <div>
              <p className="text-sm font-semibold">
                web_fetch platform-tool — {controls.enabled ? 'engedélyezve' : 'kikapcsolva'}
              </p>
              <p className="text-xs text-ink-soft">
                {controls.enabled
                  ? 'A web-egress role agent letölthet official/vendor_doc doksit (egress-guard + hash-only audit).'
                  : 'Minden web_fetch hívás determinisztikusan leáll (web_fetch_disabled), hálózati hívás nélkül.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={!canEdit || pending}
            onClick={() => save({ enabled: !controls.enabled })}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
              controls.enabled ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-500 hover:bg-emerald-600'
            }`}
          >
            {controls.enabled ? 'Kikapcsolás' : 'Engedélyezés'}
          </button>
        </div>

        <div className="estate-rule" />

        {/* provisioning.web_discovery flag (§14) */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex h-2.5 w-2.5 rounded-full ${discoveryEffective ? 'bg-emerald-400' : controls.discoveryEnabled ? 'bg-amber-400' : 'bg-red-400'}`}
            />
            <div>
              <p className="text-sm font-semibold">
                Provisioning Web-Discovery — {controls.discoveryEnabled ? 'engedélyezve' : 'kikapcsolva'}
              </p>
              <p className="text-xs text-ink-soft">
                {discoveryEffective
                  ? 'Az admin névből felfedezhet kapcsolatot; a jelölt config-ot ember aktiválja.'
                  : controls.discoveryEnabled
                    ? 'Bekapcsolva, DE a web_fetch platform-tool ki van kapcsolva — a felfedezés fetch-e leáll.'
                    : 'A „Kapcsolat felfedezése névből" funkció determinisztikusan leáll (DISCOVERY_DISABLED).'}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={!canEdit || pending}
            onClick={() => save({ discoveryEnabled: !controls.discoveryEnabled })}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
              controls.discoveryEnabled ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-500 hover:bg-emerald-600'
            }`}
          >
            {controls.discoveryEnabled ? 'Kikapcsolás' : 'Engedélyezés'}
          </button>
        </div>

        {message ? (
          <p
            className={`rounded-lg border px-3 py-2 text-sm ${
              message.tone === 'ok'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-red-500/30 bg-red-500/10 text-red-300'
            }`}
          >
            {message.text}
          </p>
        ) : null}

        {!canEdit ? (
          <p className="text-xs text-ink-soft">Módosításhoz admin jogosultság szükséges.</p>
        ) : null}

        <p className="text-xs text-ink-soft">
          Utoljára módosítva:{' '}
          {controls.updatedAt ? new Date(controls.updatedAt).toLocaleString('hu-HU') : '— (alapértelmezett)'}
        </p>
      </div>
    </Card>
  )
}
