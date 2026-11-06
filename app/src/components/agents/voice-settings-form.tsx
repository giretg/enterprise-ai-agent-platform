'use client'

import { useState, useTransition } from 'react'
import { saveAgentVoiceConfigAction } from '@/app/actions/voice'
import { VOICE_GREETING_MAX_CHARS, VOICE_NAMES, type AgentVoiceConfig } from '@/domain/voice/config'

/** #1111 hang-pilot: a munkatárs hang-beállítása, csak platform-adminisztrátornak. */
export function VoiceSettingsForm({
  agentId,
  config,
  keyConfigured,
}: {
  agentId: string
  config: AgentVoiceConfig
  keyConfigured: boolean
}) {
  const [enabled, setEnabled] = useState(config.enabled)
  const [voice, setVoice] = useState<string>(config.voice)
  const [greeting, setGreeting] = useState(config.greeting)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  function save() {
    startTransition(async () => {
      setMessage(null)
      const res = await saveAgentVoiceConfigAction({ agentId, enabled, voice, greeting })
      setMessage(res.success ? { tone: 'ok', text: 'Mentve.' } : { tone: 'error', text: res.error })
    })
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="text-ink-soft">
        Bekapcsolva a munkatárs oldalán megjelenik a „Beszélgetés hangon” gomb, amellyel böngészőben, telefonszám nélkül
        lehet vele beszélni. A hang és az elhangzott szöveg az OpenAI-hoz kerül, a céges kulcs számlájára. A platform
        tartalomszűrője és költségkerete ezt nem látja, ezért csak próbára való, valódi ügyféladat nélkül.
      </p>
      {keyConfigured ? null : (
        <p className="text-coral-deep">
          Nincs céges OpenAI-kulcs, ezért a hang nem kapcsolható be. A kulcsot a Beállítások → Céges kulcsok oldalon lehet
          megadni.
        </p>
      )}
      <label className="flex items-start gap-3">
        <input type="checkbox" className="mt-1" checked={enabled} disabled={pending} onChange={(e) => setEnabled(e.target.checked)} />
        <span className="font-medium text-ink">Hang-beszélgetés bekapcsolva</span>
      </label>
      <label className="block">
        <span className="font-medium text-ink">Hang</span>
        <select
          className="mt-1 block w-full max-w-xs rounded-lg border border-line bg-transparent px-3 py-2"
          value={voice}
          disabled={pending}
          onChange={(e) => setVoice(e.target.value)}
        >
          {VOICE_NAMES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="font-medium text-ink">Első mondat</span>
        <textarea
          className="mt-1 block w-full rounded-lg border border-line bg-transparent px-3 py-2"
          rows={2}
          maxLength={VOICE_GREETING_MAX_CHARS}
          value={greeting}
          disabled={pending}
          placeholder="Üresen: „Jó napot kívánok, [név] vagyok. Miben segíthetek?”"
          onChange={(e) => setGreeting(e.target.value)}
        />
        <span className="mt-1 block text-ink-soft">
          Mögé mindig odakerül: „Tájékoztatom, hogy mesterséges intelligenciával beszél.” Ezt a hívónak tudnia kell, ezért nem
          kapcsolható ki. A modell a mondatot átfogalmazhatja, próba közben figyeld.
        </span>
      </label>
      <p className="text-ink-soft">
        Hang közben a munkatárs csak a tudásbázisból és a memóriájából olvashat, a munkafájlokat olvashatja és hozzáfűzhet
        hozzájuk. Levelet nem küld, és más kapcsolatot sem használ. A munkaköri leírást a legutóbb publikált változatból veszi.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="rounded-full bg-coral px-4 py-1.5 font-semibold text-white hover:bg-coral/90 disabled:opacity-60"
        >
          {pending ? 'Mentés…' : 'Mentés'}
        </button>
        {message ? <span className={message.tone === 'ok' ? 'text-ink-soft' : 'text-coral-deep'}>{message.text}</span> : null}
      </div>
    </div>
  )
}
