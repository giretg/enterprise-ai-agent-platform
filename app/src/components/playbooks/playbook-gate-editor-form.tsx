'use client'

import type { RawGate } from '@/components/playbooks/playbook-flow-graph'
import { PlaybookFieldHint } from '@/components/playbooks/playbook-field-hint'
import { PLAYBOOK_CRITICALITY_OPTIONS } from '@/components/playbooks/playbook-criticality-ui'
import type { GateType, PlaybookGate, PlaybookRole } from '@/lib/playbook-v2/spec'

type Condition = NonNullable<PlaybookGate['condition']>
type ConditionOp = '==' | '!=' | '>=' | '<=' | '>' | '<'

const GATE_TYPES: GateType[] = [
  'human_approval',
  'eval_check',
  'policy_check',
  'tool_authorization',
  'manual_review',
]

const GATE_TYPE_LABELS: Record<GateType, string> = {
  human_approval: 'human_approval — emberi jóváhagyás',
  eval_check: 'eval_check — értékelés',
  policy_check: 'policy_check — policy ellenőrzés',
  tool_authorization: 'tool_authorization — eszköz engedély',
  manual_review: 'manual_review — manuális review',
}

const CONDITION_OPS: ConditionOp[] = ['==', '!=', '>=', '<=', '>', '<']

const APPROVAL_MODES = [
  { value: 'single', label: 'single — egy jóváhagyó' },
  { value: 'four_eyes', label: 'four_eyes — four-eyes' },
  { value: 'multi_level', label: 'multi_level — többszintű' },
] as const

const FIELD_CLASS = 'w-full rounded border border-ink/15 bg-transparent px-2 py-1 text-sm'
const LABEL_CLASS = 'text-ink-soft mb-0.5 block'

export type GateFormState = {
  type: GateType | ''
  requiredActorRole: string
  criticality: string
  blocking: boolean
  conditionKind: 'none' | 'default' | 'field'
  conditionField: string
  conditionOp: ConditionOp
  conditionValue: string
  approvalMode: '' | 'single' | 'four_eyes' | 'multi_level'
  evidenceRequired: boolean
}

function parseConditionValue(raw: string): string | number | boolean {
  if (raw === 'true') return true
  if (raw === 'false') return false
  const num = Number(raw)
  if (raw.trim() !== '' && !Number.isNaN(num)) return num
  return raw
}

function conditionToForm(condition: RawGate['condition']): Pick<
  GateFormState,
  'conditionKind' | 'conditionField' | 'conditionOp' | 'conditionValue'
> {
  if (condition == null) {
    return { conditionKind: 'none', conditionField: '', conditionOp: '==', conditionValue: '' }
  }
  if (condition === 'default') {
    return { conditionKind: 'default', conditionField: '', conditionOp: '==', conditionValue: '' }
  }
  if (typeof condition === 'object') {
    return {
      conditionKind: 'field',
      conditionField: condition.field ?? '',
      conditionOp: (CONDITION_OPS.includes(condition.op as ConditionOp)
        ? condition.op
        : '==') as ConditionOp,
      conditionValue: condition.value != null ? String(condition.value) : '',
    }
  }
  return { conditionKind: 'none', conditionField: '', conditionOp: '==', conditionValue: '' }
}

function conditionFromForm(form: GateFormState): Condition | undefined {
  if (form.conditionKind === 'none') return undefined
  if (form.conditionKind === 'default') return 'default'
  if (form.conditionField.trim()) {
    return {
      field: form.conditionField.trim(),
      op: form.conditionOp,
      value: parseConditionValue(form.conditionValue),
    }
  }
  return undefined
}

export function gateFormFromRaw(gate: RawGate): GateFormState {
  const g = gate as PlaybookGate
  const cond = conditionToForm(gate.condition)
  const gateType = GATE_TYPES.includes(g.type as GateType) ? (g.type as GateType) : ''
  return {
    type: gateType,
    requiredActorRole: g.requiredActorRole ?? '',
    criticality: g.criticality ?? '',
    blocking: g.blocking ?? false,
    ...cond,
    approvalMode: g.approvalMode ?? '',
    evidenceRequired: g.evidenceRequired ?? false,
  }
}

export function buildGateFromForm(existing: RawGate, form: GateFormState): RawGate {
  const criticality = form.criticality || undefined
  const blocking =
    criticality === 'L2' || criticality === 'L3' ? true : form.blocking

  return {
    ...existing,
    type: form.type || existing.type,
    requiredActorRole: form.requiredActorRole.trim() || undefined,
    criticality: criticality as PlaybookGate['criticality'],
    blocking,
    condition: conditionFromForm(form),
    approvalMode: form.approvalMode || undefined,
    evidenceRequired: form.evidenceRequired || undefined,
  }
}

export function PlaybookGateEditorForm({
  form,
  onChange,
  roles,
}: {
  form: GateFormState
  onChange: (next: GateFormState) => void
  roles?: PlaybookRole[]
}) {
  function patch(partial: Partial<GateFormState>) {
    onChange({ ...form, ...partial })
  }

  const roleOptions = (roles ?? []).map((r) => r.key)

  return (
    <div className="space-y-3">
      <label className="block text-xs">
        <span className={LABEL_CLASS}>Kapu típusa (type)</span>
        <select
          value={form.type}
          onChange={(e) => patch({ type: e.target.value as GateType | '' })}
          className={FIELD_CLASS}
        >
          <option value="">— válassz —</option>
          {GATE_TYPES.map((t) => (
            <option key={t} value={t}>
              {GATE_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <PlaybookFieldHint>
          Mit ellenőriz ez a pont? Emberi jóváhagyás, automatikus policy-check, minősítés stb.
          A típus határozza meg, milyen döntés vagy ellenőrzés kell a folyamat továbblépéséhez.
        </PlaybookFieldHint>
      </label>

      <label className="block text-xs">
        <span className={LABEL_CLASS}>Szükséges szerep (requiredActorRole)</span>
        <select
          value={form.requiredActorRole}
          onChange={(e) => patch({ requiredActorRole: e.target.value })}
          className={FIELD_CLASS}
        >
          <option value="">— nincs megadva —</option>
          {roleOptions.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
        <PlaybookFieldHint>
          Ki hagyhatja jóvá vagy léphet át ezen a kapun? A playbookban definiált szerepkörök
          közül választhatsz (pl. marketing vezető). Emberi jóváhagyásnál érdemes emberi
          szerepet választani.
        </PlaybookFieldHint>
        {roleOptions.length === 0 && (
          <PlaybookFieldHint>
            Jelenleg nincs szerepkör a specben — előbb add hozzá a lépéseknél vagy a JSON-ban.
          </PlaybookFieldHint>
        )}
      </label>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs">
          <span className={LABEL_CLASS}>Kritikusság (criticality)</span>
          <select
            value={form.criticality}
            onChange={(e) => {
              const criticality = e.target.value
              patch({
                criticality,
                blocking: criticality === 'L2' || criticality === 'L3' ? true : form.blocking,
              })
            }}
            className={FIELD_CLASS}
          >
            <option value="">— nincs megadva —</option>
            {PLAYBOOK_CRITICALITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <PlaybookFieldHint>
            Mennyire kockázatos vagy fontos ez a döntési pont? Magasabb szintnél (L2/L3) szigorúbb
            szabályok érvényesek (pl. four-eyes: aki készítette, az nem hagyhatja jóvá).
          </PlaybookFieldHint>
        </label>
        <div className="block text-xs">
          <span className={LABEL_CLASS}>Blokkoló (blocking)</span>
          <label className="mt-1 flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.blocking}
              disabled={form.criticality === 'L2' || form.criticality === 'L3'}
              onChange={(e) => patch({ blocking: e.target.checked })}
            />
            <span>A folyamat megáll, amíg a kapu nincs teljesítve</span>
          </label>
          <PlaybookFieldHint>
            Bejelölve: a következő lépés nem indul el, amíg valaki át nem engedi a kaput.
            Kikapcsolva: a kapu figyelmeztetés vagy párhuzamos ellenőrzés lehet — L2/L3-nál
            automatikusan blokkoló marad.
          </PlaybookFieldHint>
        </div>
      </div>

      <fieldset className="rounded border border-ink/10 p-2 space-y-2">
        <legend className="px-1 text-xs font-semibold text-ink-soft">Feltétel (condition)</legend>
        <PlaybookFieldHint>
          Mikor aktiválódjon ez a kapu? Alapértelmezetten mindig; mező-összehasonlítással csak
          bizonyos eredmény esetén (pl. confidence kisebb mint 0,8 → emberi review).
        </PlaybookFieldHint>
        <label className="block text-xs">
          <span className={LABEL_CLASS}>Típus</span>
          <select
            value={form.conditionKind}
            onChange={(e) =>
              patch({ conditionKind: e.target.value as GateFormState['conditionKind'] })
            }
            className={FIELD_CLASS}
          >
            <option value="none">— nincs feltétel —</option>
            <option value="default">alap (default)</option>
            <option value="field">mező összehasonlítás</option>
          </select>
        </label>
        {form.conditionKind === 'field' && (
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="block text-xs">
              <span className={LABEL_CLASS}>Mező</span>
              <input
                value={form.conditionField}
                onChange={(e) => patch({ conditionField: e.target.value })}
                className={FIELD_CLASS}
                placeholder="pl. confidence"
              />
              <PlaybookFieldHint>A lépés kimenetének melyik adata alapján döntsünk?</PlaybookFieldHint>
            </label>
            <label className="block text-xs">
              <span className={LABEL_CLASS}>Operátor</span>
              <select
                value={form.conditionOp}
                onChange={(e) => patch({ conditionOp: e.target.value as ConditionOp })}
                className={FIELD_CLASS}
              >
                {CONDITION_OPS.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
              <PlaybookFieldHint>Hogyan hasonlítsuk össze? (egyenlő, nagyobb, kisebb stb.)</PlaybookFieldHint>
            </label>
            <label className="block text-xs">
              <span className={LABEL_CLASS}>Érték</span>
              <input
                value={form.conditionValue}
                onChange={(e) => patch({ conditionValue: e.target.value })}
                className={FIELD_CLASS}
                placeholder="pl. 0.85"
              />
              <PlaybookFieldHint>Milyen küszöbértékhez viszonyítunk? Szám, szöveg vagy true/false.</PlaybookFieldHint>
            </label>
          </div>
        )}
      </fieldset>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs">
          <span className={LABEL_CLASS}>Jóváhagyási mód (approvalMode)</span>
          <select
            value={form.approvalMode}
            onChange={(e) =>
              patch({ approvalMode: e.target.value as GateFormState['approvalMode'] })
            }
            className={FIELD_CLASS}
          >
            <option value="">— nincs megadva —</option>
            {APPROVAL_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <PlaybookFieldHint>
            Hány embernek kell jóváhagynia? Egy személy elég, két független szem (four-eyes), vagy
            több szintű lánc (multi_level).
          </PlaybookFieldHint>
        </label>
        <div className="block text-xs">
          <span className={LABEL_CLASS}>Bizonyíték kötelező (evidenceRequired)</span>
          <label className="mt-1 flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.evidenceRequired}
              onChange={(e) => patch({ evidenceRequired: e.target.checked })}
            />
            <span>Jóváhagyáskor dokumentum vagy indoklás kell</span>
          </label>
          <PlaybookFieldHint>
            Bejelölve: a jóváhagyónak csatolnia vagy rögzítenie kell, miért engedte át
            (audit / compliance célra).
          </PlaybookFieldHint>
        </div>
      </div>
    </div>
  )
}
