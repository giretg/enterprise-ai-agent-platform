'use client'

/**
 * Governed Flow Builder — Decision Step / Branch outcome-tábla (WP-8, §11.5).
 *
 * A user OLVASHATÓ outcome-táblát szerkeszt (érték → célág), NEM JSON-t. A tábla a lépés-form
 * `onCompleteRules` állapotát írja (közös state a lépés-formmal → nincs deszinkron); a runtime
 * a meglévő `onComplete` + `evaluateAdvance` mechanizmuson determinisztikusan a deklarált ágat
 * választja (D13). A fallback (default) ág külön, kötelezően látható sor (`NO_SILENT_COMPLETE`).
 */
import type {
  OnCompleteFormRule,
  StepFormState,
} from '@/components/playbooks/playbook-step-editor-form'
import { PlaybookFieldHint } from '@/components/playbooks/playbook-field-hint'
import {
  ensureFieldInOutputContractJson,
  outputContractJsonHasField,
} from '@/lib/playbook-v2/output-contract-form'

const FIELD_CLASS = 'w-full rounded border border-ink/15 bg-transparent px-2 py-1 text-sm'

function detectDecisionField(rules: OnCompleteFormRule[]): string {
  const fieldRule = rules.find((r) => r.conditionKind === 'field' && r.field.trim())
  return fieldRule?.field.trim() || 'decision'
}

export function PlaybookDecisionEditor({
  form,
  onChange,
  stepIds,
  gateIds,
}: {
  form: StepFormState
  onChange: (next: StepFormState) => void
  stepIds: string[]
  gateIds: string[]
}) {
  const decisionField = detectDecisionField(form.onCompleteRules)
  const branchRows = form.onCompleteRules
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.conditionKind === 'field')
  const fallbackIndex = form.onCompleteRules.findIndex((r) => r.conditionKind === 'default')
  const fallback = fallbackIndex >= 0 ? form.onCompleteRules[fallbackIndex] : null

  function patchRules(next: OnCompleteFormRule[]) {
    onChange({ ...form, onCompleteRules: next })
  }

  function setDecisionField(field: string) {
    const next = form.onCompleteRules.map((r) =>
      r.conditionKind === 'field' ? { ...r, field } : r,
    )
    onChange({ ...form, onCompleteRules: next })
  }

  function updateRow(index: number, partial: Partial<OnCompleteFormRule>) {
    patchRules(form.onCompleteRules.map((r, i) => (i === index ? { ...r, ...partial } : r)))
  }

  function addBranch() {
    patchRules([
      ...form.onCompleteRules,
      {
        conditionKind: 'field',
        field: decisionField,
        op: '==',
        value: '',
        targetKind: 'step',
        targetId: '',
      },
    ])
  }

  function removeRow(index: number) {
    patchRules(form.onCompleteRules.filter((_, i) => i !== index))
  }

  function addFallback() {
    patchRules([
      ...form.onCompleteRules,
      { conditionKind: 'default', field: '', op: '==', value: '', targetKind: 'gate', targetId: '' },
    ])
  }

  const hasDecisionOutput = outputContractJsonHasField(form.outputContractJson, decisionField)

  return (
    <fieldset className="space-y-2 rounded-lg border border-grape/30 bg-grape/5 p-3">
      <legend className="px-1 text-xs font-semibold text-grape">◈ Döntési ágak (outcome-tábla)</legend>
      <PlaybookFieldHint>
        Az agent strukturált döntést ad; a runtime a lenti tábla alapján determinisztikusan választ ágat.
        Minden lehetséges kimenethez adj célágat, és mindig legyen egy fallback (különben néma lezárás).
      </PlaybookFieldHint>

      <label className="block text-xs">
        <span className="mb-0.5 block text-ink-soft">Döntési mező (a kimenet melyik mezője dönt)</span>
        <input
          value={decisionField}
          onChange={(e) => setDecisionField(e.target.value.trim() || 'decision')}
          className={FIELD_CLASS}
          placeholder="decision"
        />
      </label>

      {!hasDecisionOutput && (
        <div className="flex items-center justify-between rounded border border-honey/40 bg-honey/10 px-2 py-1 text-[11px] text-honey">
          <span>A(z) „{decisionField}” nincs a kimeneti szerződésben.</span>
          <button
            type="button"
            onClick={() =>
              onChange({
                ...form,
                outputContractJson: ensureFieldInOutputContractJson(
                  form.outputContractJson,
                  decisionField,
                ),
              })
            }
            className="rounded border border-honey/50 px-1.5 py-0.5 font-medium hover:bg-honey/15"
          >
            Hozzáadom
          </button>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="grid grid-cols-[1fr_auto_1.2fr_auto] items-center gap-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
          <span>ha „{decisionField}” =</span>
          <span>→</span>
          <span>célág</span>
          <span></span>
        </div>
        {branchRows.length === 0 && (
          <p className="px-1 text-[11px] text-ink-faint">Még nincs ág — adj hozzá kimeneteket.</p>
        )}
        {branchRows.map(({ r, i }) => (
          <div key={i} className="grid grid-cols-[1fr_auto_1.2fr_auto] items-center gap-2">
            <input
              value={r.value}
              onChange={(e) => updateRow(i, { value: e.target.value })}
              className={FIELD_CLASS}
              placeholder="pl. clean_match"
            />
            <span className="text-ink-faint">→</span>
            <div className="flex items-center gap-1">
              <select
                value={r.targetKind}
                onChange={(e) =>
                  updateRow(i, { targetKind: e.target.value as 'step' | 'gate', targetId: '' })
                }
                className="rounded border border-ink/15 bg-transparent px-1 py-1 text-xs"
                title="Cél típusa"
              >
                <option value="step">lépés</option>
                <option value="gate">kapu</option>
              </select>
              <select
                value={r.targetId}
                onChange={(e) => updateRow(i, { targetId: e.target.value })}
                className="flex-1 rounded border border-ink/15 bg-transparent px-1 py-1 text-xs"
              >
                <option value="">— válassz —</option>
                {(r.targetKind === 'gate' ? gateIds : stepIds).map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={() => removeRow(i)}
              className="text-sm text-coral hover:opacity-70"
              title="Ág törlése"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addBranch}
          className="rounded border border-grape/30 px-2 py-1 text-xs text-grape hover:bg-grape/10"
        >
          + Kimeneti ág
        </button>
      </div>

      <div className="mt-2 border-t border-grape/20 pt-2">
        <div className="grid grid-cols-[auto_1.2fr_auto] items-center gap-2">
          <span className="text-[11px] font-semibold text-ink-soft">Fallback (minden más):</span>
          {fallback ? (
            <>
              <div className="flex items-center gap-1">
                <select
                  value={fallback.targetKind}
                  onChange={(e) =>
                    updateRow(fallbackIndex, {
                      targetKind: e.target.value as 'step' | 'gate',
                      targetId: '',
                    })
                  }
                  className="rounded border border-ink/15 bg-transparent px-1 py-1 text-xs"
                >
                  <option value="gate">kapu</option>
                  <option value="step">lépés</option>
                </select>
                <select
                  value={fallback.targetId}
                  onChange={(e) => updateRow(fallbackIndex, { targetId: e.target.value })}
                  className="flex-1 rounded border border-ink/15 bg-transparent px-1 py-1 text-xs"
                >
                  <option value="">— válassz —</option>
                  {(fallback.targetKind === 'gate' ? gateIds : stepIds).map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => removeRow(fallbackIndex)}
                className="text-sm text-coral hover:opacity-70"
                title="Fallback törlése"
              >
                ✕
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={addFallback}
              className="col-span-2 justify-self-start rounded border border-honey/40 px-2 py-1 text-xs text-honey hover:bg-honey/10"
            >
              + Fallback ág hozzáadása (ajánlott: manual_review kapu)
            </button>
          )}
        </div>
        {!fallback && (
          <p className="mt-1 text-[10px] text-coral">
            Fallback nélkül egy ismeretlen kimenet néma lezárást okozhat — adj hozzá egyet.
          </p>
        )}
      </div>
    </fieldset>
  )
}
