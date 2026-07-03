'use client'

/**
 * Playbook-szerző agent panel (Feature-spec — Playbook-Role-Agent-Binding §5.A, §6,
 * WP-10). Natural language leírásból draftot kér az agenttől, megmutatja a read-only
 * diagramot (`PlaybookFlowGraph`) és a validációs hibákat, és csak EMBERI mentés után
 * kerül a draft a meglévő `draft → validál → jóváhagy → publish` láncba — az agent maga
 * sosem ír a DB-be, sosem publikál.
 */
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { draftPlaybookFromDescription, createPlaybookV2, createPlaybookVersionV2 } from '@/app/actions/playbook'
import { PlaybookFlowGraph } from '@/components/playbooks/playbook-flow-graph'

type ValidationIssue = { code: string; path: string; message: string }
type ValidationResult = { valid: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[] }

type DraftSpec = {
  key?: string
  name?: string
  processType?: string
  [k: string]: unknown
}

export function PlaybookAuthorPanel({ playbookId }: { playbookId?: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [description, setDescription] = useState('')
  const [spec, setSpec] = useState<DraftSpec | null>(null)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function generate() {
    setMessage(null)
    startTransition(async () => {
      const res = await draftPlaybookFromDescription({
        description,
        existingSpec: spec ?? undefined,
        priorValidation: validation ?? undefined,
      })
      if (res.success) {
        setSpec(res.data.spec as DraftSpec)
        setValidation(res.data.validation as ValidationResult)
        setDescription('')
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
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
        <button onClick={() => setOpen((v) => !v)} className="rounded-lg border border-ink/20 px-3 py-1.5 text-sm">
          {open ? 'Bezár' : '+ Draft leírásból'}
        </button>
      </div>

      {open && (
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block text-ink-soft">
              {spec ? 'Pontosítás / javítás' : 'Folyamat leírása'}
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="Pl.: egy kutató agent gyűjtsön céginfót, majd egy ember hagyja jóvá."
              className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
            />
          </label>

          <button
            onClick={generate}
            disabled={pending || !description.trim()}
            className="rounded-lg border border-ink/20 px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {pending ? 'Generálás…' : spec ? 'Draft frissítése' : 'Draft generálása'}
          </button>

          {message && <p className="text-sm text-coral">{message.text}</p>}

          {spec && (
            <div className="space-y-3 rounded-lg border border-ink/10 p-3">
              <div className="text-sm">
                <span className="font-semibold">{spec.name ?? '(névtelen)'}</span>{' '}
                <span className="font-mono text-xs text-ink-soft">{spec.key}</span>
              </div>

              <PlaybookFlowGraph spec={spec} />

              {validation && (
                <div className="space-y-1 text-xs">
                  <p className={validation.valid ? 'font-semibold text-sage' : 'font-semibold text-coral'}>
                    {validation.valid ? 'Valid — menthető draftként.' : 'Nem valid — javítsd a hibákat.'}
                  </p>
                  {validation.errors.map((e, i) => (
                    <p key={`err-${i}`} className="text-coral">
                      {e.path}: {e.message}
                    </p>
                  ))}
                  {validation.warnings.map((w, i) => (
                    <p key={`warn-${i}`} className="text-honey">
                      {w.path}: {w.message}
                    </p>
                  ))}
                </div>
              )}

              <button
                onClick={save}
                disabled={pending || !validation?.valid}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Mentés draft-verzióként
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
