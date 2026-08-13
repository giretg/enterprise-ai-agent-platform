'use client'

/**
 * Playbook-szerző agent panel (Feature-spec — Playbook-Role-Agent-Binding §5.A, §6,
 * WP-10). Natural language leírásból draftot kér az agenttől, megmutatja a szerkeszthető
 * diagramot (`PlaybookSpecEditor`) és a validációs hibákat, és csak EMBERI mentés után
 * kerül a draft a meglévő `draft → validál → jóváhagy → publish` láncba — az agent maga
 * sosem ír a DB-be, sosem publikál.
 */
import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { draftPlaybookFromDescription, createPlaybookV2, createPlaybookVersionV2 } from '@/app/actions/playbook'
import {
  PlaybookSpecEditor,
  type PlaybookDraftSpec,
  type PlaybookValidationResult,
} from '@/components/playbooks/playbook-spec-editor'
import {
  SkillSlashMenu,
  useSkillSlashAutocomplete,
} from '@/components/skills/skill-slash-autocomplete'
import { useTenantSkillOptions } from '@/components/skills/use-tenant-skill-options'

export function PlaybookAuthorPanel({ playbookId }: { playbookId?: string }) {
  const router = useRouter()
  const [savePending, startTransition] = useTransition()
  const [generating, setGenerating] = useState(false)
  const pending = generating || savePending
  const [open, setOpen] = useState(false)
  const [description, setDescription] = useState('')
  const [spec, setSpec] = useState<PlaybookDraftSpec | null>(null)
  const [validation, setValidation] = useState<PlaybookValidationResult | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null)
  const [statusText, setStatusText] = useState<string | null>(null)
  // Melyik skill leírását olvasta el az agent a tervezéshez — enélkül nem látszana,
  // hogy a draft egy meglévő, jóváhagyott munkamenet-leírásra épül-e.
  const [usedSkills, setUsedSkills] = useState<{ name: string; version: number }[]>([])

  // `/` a promptban → tenant skill-lista, ugyanaz a viselkedés, mint a chatben.
  // A kiválasztott `/skill-név` a szövegben marad: a szerző agent ebből ismeri fel,
  // melyik skill teljes leírását kell elolvasnia a folyamat tervezéséhez.
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const tenantSkills = useTenantSkillOptions(open)
  const slash = useSkillSlashAutocomplete({
    skills: tenantSkills,
    value: description,
    onChange: setDescription,
    inputRef: promptRef,
    disabled: pending,
  })

  async function generate() {
    setMessage(null)
    setUsedSkills([])
    setGenerating(true)
    setStatusText(
      spec
        ? 'Az agent frissíti és ellenőrzi a folyamatot…'
        : 'Az agent elemzi a folyamat leírását és validálja a specet…',
    )
    try {
      const res = await draftPlaybookFromDescription({
        description,
        existingSpec: spec ?? undefined,
        priorValidation: validation ?? undefined,
      })
      if (!res.success) {
        setMessage({ tone: 'err', text: res.error })
        return
      }
      const data = res.data as {
        spec: PlaybookDraftSpec
        validation: PlaybookValidationResult
        fixRounds?: number
        autoFixFailed?: boolean
        usedSkills?: { name: string; version: number }[]
      }
      setSpec(data.spec)
      setValidation(data.validation)
      setDescription('')
      setUsedSkills(data.usedSkills ?? [])

      if (data.autoFixFailed) {
        setMessage({
          tone: 'warn',
          text: 'Az agent 3 javítási körrel próbálkozott, de a spec még mindig hibás — kérem emberi javítást.',
        })
      } else if ((data.fixRounds ?? 0) > 0 && data.validation.valid) {
        setMessage({
          tone: 'ok',
          text: `${data.fixRounds} automatikus javítási kör után a spec érvényes lett.`,
        })
      }
    } finally {
      setStatusText(null)
      setGenerating(false)
    }
  }

  function save() {
    if (!spec) return
    setMessage(null)
    startTransition(async () => {
      let targetPlaybookId = playbookId
      if (!targetPlaybookId) {
        const created = await createPlaybookV2({
          key: spec.key ?? `draft-${Date.now()}`,
          name: spec.name ?? 'Névtelen Playbook',
          processType: spec.processType ?? 'unspecified',
        })
        if (!created.success) {
          setMessage({ tone: 'err', text: created.error })
          return
        }
        targetPlaybookId = created.data.id
      }
      const versionRes = await createPlaybookVersionV2({
        playbookId: targetPlaybookId,
        spec,
        changeSummary: 'Playbook-szerző agent draft',
      })
      if (!versionRes.success) {
        setMessage({ tone: 'err', text: versionRes.error })
        return
      }
      setOpen(false)
      setSpec(null)
      setValidation(null)
      router.push(`/control-plane/playbooks/${targetPlaybookId}`)
    })
  }

  return (
    <div className="atelier-card p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg font-semibold">Playbook-szerző agent</h2>
          <p className="text-xs text-ink-soft">
            Írd le természetes nyelven a folyamatot — az agent draftot javasol, de sosem publikál.
          </p>
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg border border-ink/20 px-3 py-1.5 text-sm"
        >
          {open ? 'Bezár' : '+ Draft leírásból'}
        </button>
      </div>

      {open && (
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-ink-soft">
              {spec ? 'Pontosítás / javítás' : 'Folyamat leírása'}
            </span>
            <span className="relative block">
              <textarea
                ref={promptRef}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value)
                  slash.syncCursor(e.target)
                  slash.setSelectedIndex(0)
                }}
                onSelect={(e) => slash.syncCursor(e.currentTarget)}
                onClick={(e) => slash.syncCursor(e.currentTarget)}
                onKeyUp={(e) => slash.syncCursor(e.currentTarget)}
                onKeyDown={(e) => slash.handleKeyDown(e)}
                rows={4}
                placeholder="Pl.: egy kutató agent gyűjtsön céginfót, majd egy ember hagyja jóvá. Skillre a / jellel hivatkozhatsz."
                className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
              />
              <SkillSlashMenu
                autocomplete={slash}
                emptyLabel="Ebben a szervezetben még nincs jóváhagyott skill."
              />
            </span>
            <span className="mt-1 block text-xs text-ink-soft">
              Írj <code>/</code> jelet, ha egy meglévő skillre akarsz hivatkozni — az agent
              elolvassa a skill teljes leírását, és ahhoz igazítja a lépést.
            </span>
          </label>

          <button
            onClick={generate}
            disabled={pending || !description.trim()}
            className="rounded-lg border border-ink/20 px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {pending
              ? spec
                ? 'Frissítés…'
                : 'Generálás…'
              : spec
                ? 'Draft frissítése'
                : 'Draft generálása'}
          </button>

          {pending && statusText && (
            <div className="flex items-center gap-2 rounded-lg border border-ink/10 bg-paper/60 px-3 py-2 text-sm text-ink-soft">
              <svg className="h-3.5 w-3.5 animate-spin shrink-0" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              {statusText}
            </div>
          )}

          {message && (
            <p
              className={`text-sm ${message.tone === 'err' ? 'text-coral' : message.tone === 'warn' ? 'text-honey' : 'text-sage'}`}
            >
              {message.text}
            </p>
          )}

          {usedSkills.length > 0 && (
            <p className="text-xs text-ink-soft">
              Az agent elolvasta ezt a skill-leírást és ehhez igazította a lépéseket:{' '}
              {usedSkills.map((s) => `${s.name} (v${s.version})`).join(', ')}.
            </p>
          )}

          {spec && (
            <>
              <PlaybookSpecEditor
                spec={spec}
                onSpecChange={setSpec}
                onValidationChange={setValidation}
              />
              <button
                onClick={save}
                disabled={pending || !validation?.valid}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Mentés draft-verzióként
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
