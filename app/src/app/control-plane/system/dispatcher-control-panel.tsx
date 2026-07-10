'use client'

import { useState, useTransition } from 'react'
import { Card } from '@/components/ui/shell'
import { setDispatcherControls } from '@/app/actions/platform'
import type { HarnessLauncherMode } from '@/lib/harness-launcher-mode'
import type { DispatcherRuntimeView } from '@/lib/dispatcher-runtime'

export type DispatcherControlsView = {
  enabled: boolean
  allowedModes: string[]
  pollIntervalMs: number
  blockedNotifyChannel: string
  updatedById: string | null
  updatedAt: string | null
}

const MODE_INFO: Record<HarnessLauncherMode, { label: string; summary: string }> = {
  'local-wiki': {
    label: 'Beépített futtatás — a webapp saját folyamatában',
    summary:
      'Az agent ugyanabban a szerverben fut, amelyik ezt a felületet is kiszolgálja. Nincs külön konténer és nincs extra felhőköltség; cserébe a szerver a ticket teljes futása alatt foglalt.',
  },
  'cloud-run-job': {
    label: 'Cloud Run Job — külön konténer ticketenként',
    summary:
      'A szerver elindít egy konténert, és nem várja meg: az eredmény később, callbacken érkezik vissza. A konténer csak futás közben kerül pénzbe. Ez nem azonos a leállított, folyamatosan futó „wiki-dispatcher” service-szel.',
  },
  'docker-local': {
    label: 'Docker — a saját gépeden',
    summary: 'Az agent lokális Docker konténerben fut. Fejlesztéshez való, éles szerveren nincs értelme.',
  },
}

const ALL_MODES = ['local-wiki', 'cloud-run-job', 'docker-local'] as const

export function DispatcherControlPanel({
  initial,
  runtime,
  canEdit,
}: {
  initial: DispatcherControlsView
  runtime: DispatcherRuntimeView
  canEdit: boolean
}) {
  const [controls, setControls] = useState(initial)
  const [intervalSec, setIntervalSec] = useState(Math.round(initial.pollIntervalMs / 1000))
  const [notifyEnabled, setNotifyEnabled] = useState(initial.blockedNotifyChannel.startsWith('chat:'))
  const [notifyKey, setNotifyKey] = useState(
    initial.blockedNotifyChannel.startsWith('chat:')
      ? initial.blockedNotifyChannel.slice('chat:'.length)
      : '',
  )
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function apply(next: { enabled?: boolean; allowedModes?: string[]; pollIntervalSeconds?: number; blockedNotifyChannel?: string }) {
    setMessage(null)
    startTransition(async () => {
      const res = await setDispatcherControls(next)
      if (res.success) {
        setControls(res.data)
        setIntervalSec(Math.round(res.data.pollIntervalMs / 1000))
        setNotifyEnabled(res.data.blockedNotifyChannel.startsWith('chat:'))
        setNotifyKey(
          res.data.blockedNotifyChannel.startsWith('chat:')
            ? res.data.blockedNotifyChannel.slice('chat:'.length)
            : '',
        )
        setMessage({ tone: 'ok', text: 'Mentve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  function toggleMode(mode: string) {
    const current = controls.allowedModes
    const next = current.includes(mode) ? current.filter((m) => m !== mode) : [...current, mode]
    apply({ allowedModes: next })
  }

  const trimmedNotifyKey = notifyKey.trim()
  const desiredNotifyChannel =
    notifyEnabled && trimmedNotifyKey ? `chat:${trimmedNotifyKey}` : 'audit-only:dispatch-blocked'
  const notifyChanged = desiredNotifyChannel !== controls.blockedNotifyChannel
  const notifyEnvName = trimmedNotifyKey
    ? `MONITOR_NOTIFY_WEBHOOK_${trimmedNotifyKey.toUpperCase().replace(/-/g, '_')}`
    : 'MONITOR_NOTIFY_WEBHOOK_<KULCS>'

  const allModesDisabled = controls.enabled && controls.allowedModes.length === 0
  const runtimeModeAllowed = runtime.mode !== null && controls.allowedModes.includes(runtime.mode)
  /** Igaz, ha ez a konkrét szerver a mostani beállításokkal tényleg elindítana egy agentet. */
  const thisServerWillDispatch = controls.enabled && runtimeModeAllowed
  const cloudRunJobReady = runtime.missingCloudRunEnv.length === 0

  return (
    <Card title="Dispatcher (agent-indítás)">
      <div className="space-y-5">

        {/* Globális be/ki */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex h-2.5 w-2.5 rounded-full ${
                thisServerWillDispatch ? 'bg-emerald-400' : 'bg-red-400'
              }`}
            />
            <div>
              <p className="text-sm font-semibold">
                {!controls.enabled
                  ? 'Szüneteltetve — sehol nem indul agent'
                  : runtimeModeAllowed
                    ? 'Aktív — ez a szerver indítja az agenteket'
                    : 'Aktív, de ez a szerver nem indít agentet'}
              </p>
              <p className="text-xs text-ink-soft">
                {!controls.enabled
                  ? 'A ready ticketek várnak a sorukra; egyetlen agent sem indul el, és nem fogy LLM-token.'
                  : runtimeModeAllowed
                    ? 'A ready ticketeket a dispatcher feldolgozza (token-fogyás lehetséges).'
                    : 'A főkapcsoló be van kapcsolva, de ennek a szervernek a futtató-környezete tiltva van — lásd lent.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={!canEdit || pending}
            onClick={() => apply({ enabled: !controls.enabled })}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
              controls.enabled ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-500 hover:bg-emerald-600'
            }`}
          >
            {controls.enabled ? '⏸ Leállítás' : '▶ Indítás'}
          </button>
        </div>

        {/* Futtató-környezetek engedélyezése */}
        <div className="border-t border-line/40 pt-4">
          <p className="mb-1 text-sm font-medium">Hol futhat az agent?</p>
          <p className="mb-3 text-xs text-ink-soft">
            Amikor egy ticket sorra kerül, az agentet el kell indítani valahol. Minden szerver
            pontosan egy futtató-környezetet használ — ezt indításkor kapja, és futás közben nem
            változtatható. Az alábbi kapcsolók azt engedélyezik, hogy az adott környezetben szabad-e
            egyáltalán agentet indítani. Ha egy szerver környezete ki van kapcsolva, az a szerver
            egyetlen ticketet sem indít el.
          </p>

          <div className="mb-3 rounded-lg border border-line/40 bg-surface/30 px-4 py-2.5">
            {runtime.mode ? (
              <>
                <p className="text-xs text-ink-soft">Ez a szerver, amelyik a felületet kiszolgálja:</p>
                <p className="text-sm font-medium">
                  {MODE_INFO[runtime.mode].label}{' '}
                  <span className="font-mono text-xs text-ink-soft">({runtime.mode})</span>
                </p>
                <p className="mt-0.5 text-xs text-ink-soft">
                  {runtime.modeFromEnv
                    ? 'A HARNESS_LAUNCHER_MODE env-változóból.'
                    : 'Az env nem állítja be, ezért a beépített alapértelmezés érvényes. Megváltoztatni deployjal lehet, nem innen.'}
                </p>
              </>
            ) : (
              <p className="text-sm text-red-300">
                Ismeretlen futtató-környezet: <span className="font-mono">{runtime.rawMode}</span>. A
                szerver HARNESS_LAUNCHER_MODE env-változója érvénytelen — a dispatch hibára fut.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            {ALL_MODES.map((mode) => {
              const active = controls.allowedModes.includes(mode)
              const isThisServer = runtime.mode === mode
              const cloudRunEnvMissing = mode === 'cloud-run-job' && !cloudRunJobReady
              return (
                <label
                  key={mode}
                  className={`flex cursor-pointer items-center justify-between gap-4 rounded-lg border px-4 py-2.5 transition-colors ${
                    active
                      ? 'border-emerald-500/40 bg-emerald-500/10'
                      : 'border-line/40 bg-surface/30'
                  } ${!canEdit || pending || !controls.enabled ? 'pointer-events-none opacity-50' : ''}`}
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{MODE_INFO[mode].label}</p>
                      {isThisServer ? (
                        <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                          Ez a szerver ezt használja
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-xs text-ink-soft">{MODE_INFO[mode].summary}</p>
                    {cloudRunEnvMissing ? (
                      <p className="mt-1 text-xs text-amber-400">
                        Ezen a szerveren nincs beállítva. Hiányzik:{' '}
                        <span className="font-mono">{runtime.missingCloudRunEnv.join(', ')}</span>. A
                        kapcsoló bekapcsolása önmagában nem elég — az env-változókat is be kell kötni
                        (apphosting.yaml), különben a szerver hibára fut.
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-ink-soft font-mono">{mode}</p>
                  </div>
                  <div className="relative shrink-0">
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={active}
                      disabled={!canEdit || pending || !controls.enabled}
                      onChange={() => toggleMode(mode)}
                    />
                    <div
                      className={`h-5 w-9 rounded-full transition-colors ${active ? 'bg-emerald-500' : 'bg-line'}`}
                    />
                    <div
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                        active ? 'translate-x-4' : 'translate-x-0.5'
                      }`}
                    />
                  </div>
                </label>
              )
            })}
          </div>

          {allModesDisabled ? (
            <p className="mt-2 text-xs text-amber-400">
              Egyetlen futtató-környezet sincs engedélyezve — a főkapcsoló ellenére sehol nem indul
              agent.
            </p>
          ) : controls.enabled && runtime.mode && !runtimeModeAllowed ? (
            <p className="mt-2 text-xs text-amber-400">
              Ez a szerver <span className="font-mono">{runtime.mode}</span> módban fut, de az nincs
              engedélyezve. Amíg így marad, innen egyetlen ticket sem indul el.
            </p>
          ) : null}
        </div>

        {/* Poll intervallum */}
        <div className="border-t border-line/40 pt-4">
          <label className="block text-sm font-medium">
            Lokális worker poll-intervalluma <span className="text-ink-soft">(csak fejlesztéshez)</span>
          </label>
          <p className="mb-2 text-xs text-ink-soft">
            Csak arra a workerre hat, amit a saját gépeden indítasz
            (<span className="font-mono">npm run dispatcher:worker</span>): milyen sűrűn nézzen rá a
            ticketekre (5–600 mp). A felhőben ez a mező nem csinál semmit — ott a biztonsági háló
            ütemét a „Biztonsági háló” panel Cloud Scheduler sora állítja.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={5}
              max={600}
              value={intervalSec}
              disabled={!canEdit || pending}
              onChange={(e) => setIntervalSec(Number(e.target.value))}
              className="w-28 rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-ink disabled:opacity-50"
            />
            <span className="text-sm text-ink-soft">másodperc</span>
            <button
              type="button"
              disabled={!canEdit || pending || intervalSec === Math.round(controls.pollIntervalMs / 1000)}
              onClick={() => apply({ pollIntervalSeconds: intervalSec })}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40"
            >
              Mentés
            </button>
          </div>
        </div>

        {/* Blokkolt dispatch értesítés */}
        <div className="border-t border-line/40 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <label className="block text-sm font-medium">Értesítés elakadt agent-indításról</label>
              <p className="text-xs text-ink-soft">
                Ha egy agent indítása elakad (például elfogyott a model-költségkeret), az mindig
                bekerül az audit naplóba. Bekapcsolva ezen felül chat-üzenet is megy egy előre
                engedélyezett csatornára.
              </p>
            </div>
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={notifyEnabled}
                disabled={!canEdit || pending}
                onChange={(e) => setNotifyEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-line bg-panel"
              />
              Chat webhook
            </label>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div>
              <input
                type="text"
                value={notifyKey}
                disabled={!canEdit || pending || !notifyEnabled}
                onChange={(e) => setNotifyKey(e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))}
                placeholder="ops"
                className="w-full rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-ink disabled:opacity-50"
              />
              <p className="mt-1 text-xs text-ink-soft">
                Aktuális: <span className="font-mono">{controls.blockedNotifyChannel}</span>
                {notifyEnabled ? (
                  <>
                    {' · '}env: <span className="font-mono">{notifyEnvName}</span>
                  </>
                ) : null}
              </p>
            </div>
            <button
              type="button"
              disabled={
                !canEdit ||
                pending ||
                !notifyChanged ||
                (notifyEnabled && trimmedNotifyKey.length === 0)
              }
              onClick={() => apply({ blockedNotifyChannel: desiredNotifyChannel })}
              className="h-9 rounded-lg bg-accent px-3 text-sm text-white disabled:opacity-40"
            >
              Mentés
            </button>
          </div>
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
          {' · '}a beállítás azonnal érvénybe lép — minden dispatch friss értéket olvas. A már
          elindult agent-futásokat nem szakítja meg.
        </p>
      </div>
    </Card>
  )
}
