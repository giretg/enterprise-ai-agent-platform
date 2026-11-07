'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { saveAgentVoiceConfigAction } from '@/app/actions/voice'
import { VoiceCallIcon } from '@/components/agents/voice-call-button'
import { VOICE_GREETING_MAX_CHARS, VOICE_NAMES, VOICE_ROLE_MAX_CHARS, type AgentVoiceConfig, type VoiceCallStyle, type VoiceProviderId } from '@/domain/voice/config'

/** A jelenlegi, mentett állapot egy mondatban: mit lát most a többi felhasználó, és mi a teendő. */
function VoiceStatus({ config, keyConfigured, published }: { config: AgentVoiceConfig; keyConfigured: boolean; published: boolean }) {
  if (!config.enabled) {
    return <p className="text-ink">Most ki van kapcsolva: a munkatárs oldalán nincs hang-gomb, így senki nem tud vele hangon beszélni.</p>
  }
  if (!published) {
    return (
      <p className="text-coral-deep">
        Be van kapcsolva, de a gomb még nem látszik, mert a munkatárs nincs publikálva. Publikálni az{' '}
        {/* Teljes oldalbetöltés kell: a szakaszváltó csak betöltéskor olvassa a `section` paramétert. */}
        <a href="?section=elesites" className="underline">
          Élesítés
        </a>{' '}
        szakaszban lehet.
      </p>
    )
  }
  if (!keyConfigured) {
    return <p className="text-coral-deep">Be van kapcsolva, de céges kulcs nélkül a beszélgetés nem indul el. Add meg a kulcsot az alábbi linken.</p>
  }
  return (
    <p className="text-ink">
      Be van kapcsolva: a {config.callStyle === 'phone' ? 'zöld telefon' : 'hullámforma'} gomb a munkatárs dobozán, az oldala tetején és a chatben látszik mindenkinek, aki láthatja ezt a munkatársat.
    </p>
  )
}

const PROVIDER_OPTIONS: { value: VoiceProviderId; title: string; hint: string }[] = [
  { value: 'openai_live', title: 'OpenAI', hint: 'Külön beszélő és háttérmodell dolgozik. A céges OpenAI-kulcsot használja.' },
  { value: 'elevenlabs', title: 'ElevenLabs', hint: 'Egy modell beszél, és közvetlenül éri el az adatokat. A céges ElevenLabs-kulcsot használja. Hangfelvétel nem készül, az átirat 30 napig marad az ElevenLabsnél.' },
]

const CALL_STYLE_OPTIONS: { value: VoiceCallStyle; title: string; hint: string }[] = [
  { value: 'conversation', title: 'Beszélgetős munkatárs', hint: 'Főleg írásban dolgozik, de hangon is lehet vele beszélni. Hullámforma ikont kap.' },
  { value: 'phone', title: 'Telefonos munkatárs', hint: 'Elsősorban hívásra való, például rendelésfelvételre. Zöld telefon ikont kap.' },
]

/** #1111 hang-pilot: a munkatárs hang-beállítása, csak platform-adminisztrátornak. */
export function VoiceSettingsForm({
  agentId,
  config,
  keyConfigured,
  elevenLabsAvailable,
  elevenLabsKeyConfigured,
  published,
  roleClipped,
}: {
  agentId: string
  config: AgentVoiceConfig
  keyConfigured: boolean
  elevenLabsAvailable: boolean
  elevenLabsKeyConfigured: boolean
  published: boolean
  roleClipped: boolean
}) {
  const [enabled, setEnabled] = useState(config.enabled)
  const [provider, setProvider] = useState<VoiceProviderId>(config.provider)
  const [elevenLabsVoiceId, setElevenLabsVoiceId] = useState(config.elevenLabsVoiceId ?? '')
  const [voice, setVoice] = useState<string>(config.voice)
  const [greeting, setGreeting] = useState(config.greeting)
  const [callStyle, setCallStyle] = useState<VoiceCallStyle>(config.callStyle)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  function save() {
    startTransition(async () => {
      setMessage(null)
      const res = await saveAgentVoiceConfigAction({ agentId, enabled, provider, voice, elevenLabsVoiceId, greeting, callStyle })
      setMessage(res.success ? { tone: 'ok', text: 'Mentve.' } : { tone: 'error', text: res.error })
    })
  }

  const onElevenLabs = provider === 'elevenlabs'
  const providerName = onElevenLabs ? 'ElevenLabs' : 'OpenAI'
  const selectedKeyConfigured = onElevenLabs ? elevenLabsKeyConfigured : keyConfigured
  const savedKeyConfigured = config.provider === 'elevenlabs' ? elevenLabsKeyConfigured : keyConfigured
  // A leállított szolgáltatóra mentett munkatárs is lássa a választását, különben a mentés csendben átállítaná.
  const providerOptions = PROVIDER_OPTIONS.filter((option) => option.value !== 'elevenlabs' || elevenLabsAvailable || config.provider === 'elevenlabs')

  return (
    <div className="space-y-3 text-sm">
      <p className="text-ink-soft">
        Bekapcsolva a munkatársnál megjelenik egy hang-gomb, amellyel böngészőben, telefonszám nélkül lehet vele
        beszélni. A hang és az elhangzott szöveg az {providerName} szolgáltatóhoz kerül, a céges kulcs számlájára. A platform
        tartalomszűrője és költségkerete ezt nem látja, ezért csak próbára való, valódi ügyféladat nélkül.
      </p>
      <VoiceStatus config={config} keyConfigured={savedKeyConfigured} published={published} />
      {selectedKeyConfigured ? null : (
        <p className="text-coral-deep">
          Nincs céges {providerName}-kulcs, ezért a hang nem kapcsolható be. A kulcsot a{' '}
          <Link href="/control-plane/settings?section=openrouter" className="underline">
            Beállítások → Céges modellkulcsok
          </Link>{' '}
          oldalon lehet megadni.
        </p>
      )}
      <label className="flex items-start gap-3">
        <input type="checkbox" className="mt-1" checked={enabled} disabled={pending} onChange={(e) => setEnabled(e.target.checked)} />
        <span className="font-medium text-ink">Hang-beszélgetés bekapcsolva</span>
      </label>
      {providerOptions.length > 1 ? (
        <fieldset>
          <legend className="font-medium text-ink">Hangszolgáltató</legend>
          <div className="mt-1 space-y-2">
            {providerOptions.map((option) => (
              <label key={option.value} className="flex items-start gap-3 rounded-lg border border-line px-3 py-2">
                <input
                  type="radio"
                  name="voice-provider"
                  className="mt-1"
                  checked={provider === option.value}
                  disabled={pending}
                  onChange={() => setProvider(option.value)}
                />
                <span>
                  <span className="block font-medium text-ink">{option.title}</span>
                  <span className="block text-ink-soft">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <span className="mt-1 block text-ink-soft">A váltás a következő beszélgetéstől érvényes. A munkaköri leírás, a jogosultságok és az eszközök ugyanazok maradnak.</span>
        </fieldset>
      ) : null}
      <fieldset>
        <legend className="font-medium text-ink">Milyen munkatárs ez?</legend>
        <div className="mt-1 space-y-2">
          {CALL_STYLE_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
              <input
                type="radio"
                name="voice-call-style"
                checked={callStyle === option.value}
                disabled={pending}
                onChange={() => setCallStyle(option.value)}
              />
              <VoiceCallIcon callStyle={option.value} />
              <span>
                <span className="block font-medium text-ink">{option.title}</span>
                <span className="block text-ink-soft">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <span className="mt-1 block text-ink-soft">
          Csak a gomb kinézete változik. A beszélgetés mindkét esetben böngészőben fut, a munkatárs telefonszámot nem kap.
        </span>
      </fieldset>
      {onElevenLabs ? (
        <label className="block">
          <span className="font-medium text-ink">Hang azonosítója</span>
          <input
            className="mt-1 block w-full max-w-md rounded-lg border border-line bg-transparent px-3 py-2"
            value={elevenLabsVoiceId}
            disabled={pending}
            placeholder="Üresen az ElevenLabs alapértelmezett hangja szól"
            onChange={(e) => setElevenLabsVoiceId(e.target.value)}
          />
          <span className="mt-1 block text-ink-soft">
            Az ElevenLabs hangtárában a hang menüjéből másolható ki. A váltás a következő beszélgetéstől érvényes. Próbával válaszd ki, melyik szól jól magyarul.
          </span>
        </label>
      ) : (
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
              {name === 'marin' ? `${name} (alapértelmezett)` : name}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-ink-soft">
          A nevek az OpenAI hangjait jelölik. A váltás a következő beszélgetéstől érvényes. Magyar hang nincs külön, ezért próbával válaszd ki, melyik szól a legjobban.
        </span>
      </label>
      )}
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
          kapcsolható ki. {onElevenLabs ? 'Az ElevenLabs szó szerint mondja el, és közben nem lehet félbeszakítani.' : 'A modell a mondatot átfogalmazhatja, próba közben figyeld.'}
        </span>
      </label>
      <p className="text-ink-soft">
        Hang közben a munkatárs csak a tudásbázisból és a memóriájából olvashat, a munkafájlokat olvashatja és hozzáfűzhet
        hozzájuk. Levelet nem küld, és más kapcsolatot sem használ. A beszélgetést indító felhasználó jogaival fut: csak
        megtekintési joggal a munkafájlba írás nem sikerül. A munkaköri leírást a legutóbb publikált változatból veszi.
      </p>
      {roleClipped ? (
        <p className="text-coral-deep">
          A munkaköri leírás hosszabb {VOICE_ROLE_MAX_CHARS} karakternél. Hang közben csak az eleje jut el a munkatárshoz, a szabályok viszont teljes egészében. Ha fontos rész maradna ki, rövidítsd a leírást.
        </p>
      ) : null}
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
