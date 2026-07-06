'use client'

/**
 * Playbook Pack import-wizard (Governed Flow Builder WP-6, §9, D9).
 * Lépések: beolvasás → validálás (preview) → mapping (kulcs/név) → jóváhagyás+apply.
 * Az apply DRAFT Playbook(oka)t + tenant-scoped DRAFT StepTemplate-eket hoz létre;
 * SOHA nem publikál. A connector-template-ek manuális follow-upként jelennek meg.
 */
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { importPlaybookPackPreviewV2, importPlaybookPackApplyV2 } from '@/app/actions/playbook'

type Preview = {
  valid: boolean
  errors: string[]
  warnings: string[]
  metadata: { title?: string; author?: string; description?: string } | null
  playbooks: Array<{ key: string; name: string; contentHash: string; hashOk: boolean }>
  stepTemplates: Array<{ key: string; name: string; contentHash: string; hashOk: boolean }>
  connectorTemplates: Array<{ contentHash: string; hashOk: boolean }>
}

type ApplyResult = {
  createdPlaybooks: Array<{ key: string; playbookId: string; versionId: string }>
  createdStepTemplates: Array<{ key: string; id: string }>
  itemErrors: string[]
  connectorTemplatesPending: number
  warnings: string[]
}

type Mapping = { sourceKey: string; targetKey: string; targetName: string }

const inputCls = 'w-full rounded border border-ink/15 bg-transparent px-2 py-1 text-xs'

export function PlaybookPackImport() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [raw, setRaw] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [parsedPack, setParsedPack] = useState<unknown>(null)
  const [pbMappings, setPbMappings] = useState<Mapping[]>([])
  const [stMappings, setStMappings] = useState<Mapping[]>([])
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setRaw(String(reader.result ?? ''))
    reader.readAsText(file)
  }

  function runValidate() {
    setError(null)
    setResult(null)
    let pack: unknown
    try {
      pack = JSON.parse(raw)
    } catch {
      setError('A beillesztett tartalom nem érvényes JSON.')
      return
    }
    setParsedPack(pack)
    startTransition(async () => {
      const res = await importPlaybookPackPreviewV2({ pack })
      if (!res.success) {
        setError(res.error)
        return
      }
      const p = res.data as Preview
      setPreview(p)
      setPbMappings(p.playbooks.map((x) => ({ sourceKey: x.key, targetKey: x.key, targetName: x.name })))
      setStMappings(p.stepTemplates.map((x) => ({ sourceKey: x.key, targetKey: x.key, targetName: x.name })))
    })
  }

  function runApply() {
    setError(null)
    startTransition(async () => {
      const res = await importPlaybookPackApplyV2({
        pack: parsedPack,
        playbookMappings: pbMappings,
        stepTemplateMappings: stMappings,
      })
      if (!res.success) {
        setError(res.error)
        return
      }
      setResult(res.data as ApplyResult)
      router.refresh()
    })
  }

  function patchMapping(
    setter: React.Dispatch<React.SetStateAction<Mapping[]>>,
    idx: number,
    patch: Partial<Mapping>,
  ) {
    setter((ms) => ms.map((m, i) => (i === idx ? { ...m, ...patch } : m)))
  }

  return (
    <div className="space-y-5">
      {error && <p className="rounded-lg bg-coral/15 px-3 py-2 text-sm text-coral">{error}</p>}

      {/* 1. Beolvasás */}
      <div className="atelier-card space-y-3 p-4">
        <h2 className="font-display text-lg font-semibold">1. Pack beolvasása</h2>
        <input type="file" accept="application/json,.json" onChange={onFile} className="text-sm" />
        <textarea
          className="min-h-[120px] w-full rounded border border-ink/15 bg-transparent p-2 font-mono text-xs"
          placeholder="…vagy illeszd be ide a pack JSON-t"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
        />
        <button
          onClick={runValidate}
          disabled={pending || !raw.trim()}
          className="rounded-lg bg-ink px-4 py-1.5 text-sm text-paper disabled:opacity-50"
        >
          Validálás (preview)
        </button>
      </div>

      {/* 2. Preview */}
      {preview && (
        <div className="atelier-card space-y-3 p-4">
          <h2 className="font-display text-lg font-semibold">2. Ellenőrzés</h2>
          {preview.metadata && (
            <p className="text-sm text-ink-soft">
              <span className="font-medium text-ink">{preview.metadata.title}</span>
              {preview.metadata.author ? ` · ${preview.metadata.author}` : ''}
              {preview.metadata.description ? ` — ${preview.metadata.description}` : ''}
            </p>
          )}
          <p className={`text-sm ${preview.valid ? 'text-sage' : 'text-coral'}`}>
            {preview.valid ? '✓ A pack érvényes és importálható.' : '✗ A pack nem érvényes.'}
          </p>
          {preview.errors.map((e, i) => (
            <p key={i} className="text-xs text-coral">
              • {e}
            </p>
          ))}
          {preview.warnings.map((w, i) => (
            <p key={i} className="text-xs text-honey">
              ⚠ {w}
            </p>
          ))}
          <div className="grid gap-2 text-xs text-ink-soft sm:grid-cols-3">
            <div>Playbookok: {preview.playbooks.length}</div>
            <div>Lépés-sablonok: {preview.stepTemplates.length}</div>
            <div>Connector-sablonok: {preview.connectorTemplates.length}</div>
          </div>
          {preview.connectorTemplates.length > 0 && (
            <p className="rounded bg-honey/10 px-3 py-2 text-[11px] text-honey">
              A connector-sablonokat kézzel kell a connector-katalógusba importálni — a secret/grant
              SOHA nem utazik a packben (D9), ezt import után kell megadni.
            </p>
          )}
        </div>
      )}

      {/* 3. Mapping */}
      {preview?.valid && (pbMappings.length > 0 || stMappings.length > 0) && (
        <div className="atelier-card space-y-4 p-4">
          <h2 className="font-display text-lg font-semibold">3. Megfeleltetés (kulcs / név)</h2>
          <p className="text-xs text-ink-soft">
            A kulcs a tenanton belül egyedi kell legyen. Ha ütközik meglévővel, itt írd át.
          </p>
          {pbMappings.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-ink">Playbookok</h3>
              {pbMappings.map((m, i) => (
                <div key={m.sourceKey} className="grid gap-2 sm:grid-cols-2">
                  <input
                    className={inputCls}
                    value={m.targetKey}
                    onChange={(e) => patchMapping(setPbMappings, i, { targetKey: e.target.value })}
                    placeholder="kulcs"
                  />
                  <input
                    className={inputCls}
                    value={m.targetName}
                    onChange={(e) => patchMapping(setPbMappings, i, { targetName: e.target.value })}
                    placeholder="név"
                  />
                </div>
              ))}
            </div>
          )}
          {stMappings.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-ink">Lépés-sablonok</h3>
              {stMappings.map((m, i) => (
                <div key={m.sourceKey} className="grid gap-2 sm:grid-cols-2">
                  <input
                    className={inputCls}
                    value={m.targetKey}
                    onChange={(e) => patchMapping(setStMappings, i, { targetKey: e.target.value })}
                    placeholder="kulcs"
                  />
                  <input
                    className={inputCls}
                    value={m.targetName}
                    onChange={(e) => patchMapping(setStMappings, i, { targetName: e.target.value })}
                    placeholder="név"
                  />
                </div>
              ))}
            </div>
          )}

          {/* 4. Apply */}
          <div className="border-t border-ink/10 pt-3">
            <h2 className="font-display text-base font-semibold">4. Jóváhagyás és import</h2>
            <p className="mb-2 text-xs text-ink-soft">
              Az import DRAFT Playbookként/sablonként jön létre — semmi nem lesz élesítve. A
              publikálás a szokásos külön jóváhagyási lépés.
            </p>
            <button
              onClick={runApply}
              disabled={pending}
              className="rounded-lg bg-ink px-4 py-1.5 text-sm text-paper disabled:opacity-50"
            >
              Import vázlatként
            </button>
          </div>
        </div>
      )}

      {/* Eredmény */}
      {result && (
        <div className="atelier-card space-y-2 p-4">
          <h2 className="font-display text-lg font-semibold">Eredmény</h2>
          <p className="text-sm text-sage">
            {result.createdPlaybooks.length} Playbook és {result.createdStepTemplates.length} lépés-sablon
            létrehozva vázlatként.
          </p>
          {result.createdPlaybooks.map((p) => (
            <p key={p.playbookId} className="text-xs text-ink-soft">
              • Playbook <span className="font-mono">{p.key}</span> —{' '}
              <a className="text-coral underline" href={`/control-plane/playbooks/${p.playbookId}`}>
                megnyitás
              </a>
            </p>
          ))}
          {result.createdStepTemplates.map((s) => (
            <p key={s.id} className="text-xs text-ink-soft">
              • Sablon <span className="font-mono">{s.key}</span>
            </p>
          ))}
          {result.connectorTemplatesPending > 0 && (
            <p className="text-xs text-honey">
              {result.connectorTemplatesPending} connector-sablon kézi importra vár.
            </p>
          )}
          {result.itemErrors.map((e, i) => (
            <p key={i} className="text-xs text-coral">
              ✗ {e}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
