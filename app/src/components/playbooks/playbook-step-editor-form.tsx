'use client'

import type { RawStep } from '@/components/playbooks/playbook-flow-graph'
import { PlaybookFieldHint } from '@/components/playbooks/playbook-field-hint'
import { syncInputSlotsWithTemplate } from '@/lib/playbook-v2/input-slots-sync'
import { getRoleCapabilities, getRoleType, PLAYBOOK_ROLE_TYPE_OPTIONS, type PlaybookRoleType } from '@/lib/playbook-v2/role-sync'
import type { PlaybookInputSlot, PlaybookRole, PlaybookStep } from '@/lib/playbook-v2/spec'

type RawRule = NonNullable<PlaybookStep['onComplete']>[number]
type ConditionOp = '==' | '!=' | '>=' | '<=' | '>' | '<'

export type OnCompleteFormRule = {
  conditionKind: 'default' | 'field'
  field: string
  op: ConditionOp
  value: string
  targetKind: 'step' | 'gate'
  targetId: string
}

export type InputSlotFormRow = {
  name: string
  type: PlaybookInputSlot['type']
  required: boolean
  source: PlaybookInputSlot['source']
  description: string
}

export type StepFormState = {
  name: string
  ticketType: string
  assignedRole: string
  roleType: PlaybookRoleType
  requiredCapabilities: string[]
  description: string
  instructionTemplate: string
  timeoutMinutes: string
  allowedStatesText: string
  requiredGateIds: string[]
  inputSlots: InputSlotFormRow[]
  onCompleteRules: OnCompleteFormRule[]
  retryMaxAttempts: string
  retryOnExhausted: '' | 'fail_process' | 'manual_review'
  inputContractJson: string
  outputContractJson: string
}

const CONDITION_OPS: ConditionOp[] = ['==', '!=', '>=', '<=', '>', '<']

const INPUT_SLOT_TYPES: PlaybookInputSlot['type'][] = ['string', 'number', 'boolean', 'freeform']
const INPUT_SLOT_SOURCES: PlaybookInputSlot['source'][] = ['config', 'trigger']

const FIELD_CLASS = 'w-full rounded border border-ink/15 bg-transparent px-2 py-1 text-sm'
const LABEL_CLASS = 'text-ink-soft mb-0.5 block'

function joinList(items: string[] | undefined): string {
  return (items ?? []).join(', ')
}

function parseList(text: string): string[] | undefined {
  const items = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return items.length > 0 ? items : undefined
}

function parseJsonField(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const parsed = JSON.parse(trimmed) as unknown
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('A JSON objektum kell legyen.')
  }
  return parsed as Record<string, unknown>
}

function stringifyJsonField(value: unknown): string {
  if (value == null) return ''
  return JSON.stringify(value, null, 2)
}

function parseConditionValue(raw: string): string | number | boolean {
  if (raw === 'true') return true
  if (raw === 'false') return false
  const num = Number(raw)
  if (raw.trim() !== '' && !Number.isNaN(num)) return num
  return raw
}

function inputSlotsToForm(slots: PlaybookInputSlot[] | undefined): InputSlotFormRow[] {
  return (slots ?? []).map((s) => ({
    name: s.name,
    type: s.type,
    required: s.required ?? true,
    source: s.source,
    description: s.description ?? '',
  }))
}

function formSlotsToPlaybook(rows: InputSlotFormRow[]): PlaybookInputSlot[] {
  return rows.map((r) => ({
    name: r.name,
    type: r.type,
    required: r.required,
    source: r.source,
    description: r.description.trim() || undefined,
  }))
}

export function stepFormFromRaw(step: RawStep, roles: PlaybookRole[] | undefined): StepFormState {
  const slots = step.inputSlots as PlaybookInputSlot[] | undefined
  return {
    name: step.name ?? '',
    ticketType: step.ticketType ?? '',
    assignedRole: step.assignedRole ?? '',
    roleType: getRoleType(roles, step.assignedRole),
    requiredCapabilities: getRoleCapabilities(roles, step.assignedRole),
    description: step.description ?? '',
    instructionTemplate: step.instructionTemplate ?? '',
    timeoutMinutes: step.timeoutMinutes != null ? String(step.timeoutMinutes) : '',
    allowedStatesText: joinList(step.allowedStates),
    requiredGateIds: [...(step.requiredGateIds ?? [])],
    inputSlots: inputSlotsToForm(slots),
    onCompleteRules: onCompleteToForm(step.onComplete),
    retryMaxAttempts:
      step.retryPolicy?.maxAttempts != null ? String(step.retryPolicy.maxAttempts) : '',
    retryOnExhausted: step.retryPolicy?.onExhausted ?? '',
    inputContractJson: stringifyJsonField(step.inputContract),
    outputContractJson: stringifyJsonField(step.outputContract),
  }
}

function onCompleteToForm(rules: RawStep['onComplete']): OnCompleteFormRule[] {
  return (rules ?? []).map((r) => {
    const cond = r?.condition
    const isDefault = cond == null || cond === 'default'
    let field = ''
    let op: ConditionOp = '=='
    let value = ''
    if (!isDefault && typeof cond === 'object') {
      field = cond.field ?? ''
      op = (CONDITION_OPS.includes(cond.op as ConditionOp) ? cond.op : '==') as ConditionOp
      value = cond.value != null ? String(cond.value) : ''
    }
    return {
      conditionKind: isDefault ? 'default' : 'field',
      field,
      op,
      value,
      targetKind: r?.gateId ? 'gate' : 'step',
      targetId: r?.gateId ?? r?.nextStepId ?? '',
    }
  })
}

function onCompleteFromForm(rules: OnCompleteFormRule[]): RawRule[] | undefined {
  const built = rules
    .filter((r) => r.targetId.trim())
    .map((r) => {
      const rule: RawRule = {
        condition:
          r.conditionKind === 'field' && r.field.trim()
            ? { field: r.field.trim(), op: r.op, value: parseConditionValue(r.value) }
            : 'default',
      }
      if (r.targetKind === 'gate') rule.gateId = r.targetId.trim()
      else rule.nextStepId = r.targetId.trim()
      return rule
    })
  return built.length > 0 ? built : undefined
}

function mergeSyncedInputSlots(
  template: string | undefined,
  formRows: InputSlotFormRow[],
): PlaybookInputSlot[] | undefined {
  const formAsPlaybook = formSlotsToPlaybook(formRows)
  const synced = syncInputSlotsWithTemplate(template, formAsPlaybook)
  if (!synced) return undefined
  const formByName = new Map(formRows.map((r) => [r.name, r]))
  return synced.map((slot) => {
    const row = formByName.get(slot.name)
    if (!row) return slot
    return {
      ...slot,
      type: row.type,
      required: row.required,
      source: row.source,
      description: row.description.trim() || undefined,
    }
  })
}

export function applyInstructionTemplateToForm(
  form: StepFormState,
  instructionTemplate: string,
): StepFormState {
  const synced = syncInputSlotsWithTemplate(
    instructionTemplate || undefined,
    formSlotsToPlaybook(form.inputSlots),
  )
  return {
    ...form,
    instructionTemplate,
    inputSlots: inputSlotsToForm(synced),
  }
}

export type StepSaveResult = {
  stepPatch: RawStep
  jsonError?: string
}

export function buildStepFromForm(existing: RawStep, form: StepFormState): StepSaveResult {
  try {
    const instructionTemplate = form.instructionTemplate.trim() || undefined
    const timeoutRaw = form.timeoutMinutes.trim()
    const timeoutMinutes =
      timeoutRaw !== '' ? Math.max(1, Math.floor(Number(timeoutRaw))) : undefined
    const retryRaw = form.retryMaxAttempts.trim()
    const retryPolicy =
      retryRaw !== '' && form.retryOnExhausted
        ? {
            maxAttempts: Math.max(1, Math.floor(Number(retryRaw))),
            onExhausted: form.retryOnExhausted,
          }
        : undefined

    return {
      stepPatch: {
        ...existing,
        name: form.name.trim() || existing.name,
        ticketType: form.ticketType.trim() || existing.ticketType,
        assignedRole: form.assignedRole.trim() || existing.assignedRole,
        description: form.description.trim() || undefined,
        instructionTemplate,
        inputSlots: mergeSyncedInputSlots(instructionTemplate, form.inputSlots),
        timeoutMinutes: timeoutMinutes && !Number.isNaN(timeoutMinutes) ? timeoutMinutes : undefined,
        allowedStates: parseList(form.allowedStatesText),
        requiredGateIds:
          form.requiredGateIds.length > 0 ? [...form.requiredGateIds] : undefined,
        onComplete: onCompleteFromForm(form.onCompleteRules),
        retryPolicy,
        inputContract: parseJsonField(form.inputContractJson),
        outputContract: parseJsonField(form.outputContractJson),
      },
    }
  } catch (e) {
    return {
      stepPatch: existing,
      jsonError: e instanceof Error ? e.message : 'Érvénytelen mező.',
    }
  }
}

function emptyOnCompleteRule(): OnCompleteFormRule {
  return {
    conditionKind: 'default',
    field: '',
    op: '==',
    value: '',
    targetKind: 'step',
    targetId: '',
  }
}

const ALL_CAPABILITIES = [
  'agent_catalog', 'agent_resolve', 'agent_ask', 'user_directory',
  'ticket_create', 'board_write',
  'http_api_get', 'http_api_request',
  'web_search', 'web_research_request',
  'kb_search',
  'file_read', 'file_write', 'file_edit', 'file_list', 'file_glob', 'file_search', 'file_delete',
  'xlsx_read_sheet', 'xlsx_write_cells', 'xlsx_append_rows', 'xlsx_create',
  'pptx_create', 'docx_read', 'pdf_read', 'pdf_create', 'create_html',
  'gmail_search', 'gmail_get_message', 'gmail_create_draft', 'gmail_send',
  'sandbox_app.create', 'sandbox_app.update_artifact', 'sandbox_app.preview', 'sandbox_app.export',
]

export function PlaybookStepEditorForm({
  form,
  onChange,
  stepIds,
  gateIds,
  roles,
}: {
  form: StepFormState
  onChange: (next: StepFormState) => void
  stepIds: string[]
  gateIds: string[]
  roles?: PlaybookRole[]
}) {
  function patch(partial: Partial<StepFormState>) {
    onChange({ ...form, ...partial })
  }

  function updateOnCompleteRule(index: number, partial: Partial<OnCompleteFormRule>) {
    const next = form.onCompleteRules.map((r, i) => (i === index ? { ...r, ...partial } : r))
    patch({ onCompleteRules: next })
  }

  function updateInputSlot(index: number, partial: Partial<InputSlotFormRow>) {
    const next = form.inputSlots.map((r, i) => (i === index ? { ...r, ...partial } : r))
    patch({ inputSlots: next })
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs">
          <span className={LABEL_CLASS}>Lépés neve (name)</span>
          <input
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
            className={FIELD_CLASS}
          />
          <PlaybookFieldHint>
            Emberi olvasható név a folyamatábrán és a ticketeken — pl. „Facebook posztszöveg előkészítése”.
          </PlaybookFieldHint>
        </label>
        <label className="block text-xs">
          <span className={LABEL_CLASS}>Ticket típus (ticketType)</span>
          <input
            value={form.ticketType}
            onChange={(e) => patch({ ticketType: e.target.value })}
            className={FIELD_CLASS}
            placeholder="Pl.: agent_task, human_approval"
          />
          <PlaybookFieldHint>
            Milyen típusú munkacikk jön létre ebből a lépésből a futás során. Segít szűrni,
            riportolni és összekötni a platform ticket-kezelésével.
          </PlaybookFieldHint>
        </label>
      </div>

      <label className="block text-xs">
        <span className={LABEL_CLASS}>Leírás (description)</span>
        <textarea
          value={form.description}
          onChange={(e) => patch({ description: e.target.value })}
          rows={2}
          className={FIELD_CLASS}
        />
        <PlaybookFieldHint>
          Rövid üzleti kontextus a lépéshez — mit ér el, mire figyeljen a végrehajtó. Nem helyettesíti
          a prompt sablont, de segít az emberi operátoroknak és az agentnek.
        </PlaybookFieldHint>
      </label>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs">
          <span className={LABEL_CLASS}>Hozzárendelt szerep (assignedRole)</span>
          <input
            value={form.assignedRole}
            onChange={(e) => {
              const assignedRole = e.target.value
              patch({
                assignedRole,
                roleType: getRoleType(roles, assignedRole),
              })
            }}
            className={FIELD_CLASS}
          />
          <PlaybookFieldHint>
            Ki végzi a munkát? Absztrakt szerepkör azonosító (pl. marketing_copy_assistant) — nem
            konkrét személy vagy agent neve, hanem a playbook szerepkészletéből való hivatkozás.
          </PlaybookFieldHint>
        </label>
        <label className="block text-xs">
          <span className={LABEL_CLASS}>Szerep típusa (roles[].type)</span>
          <select
            value={form.roleType}
            onChange={(e) => patch({ roleType: e.target.value as PlaybookRoleType })}
            className={FIELD_CLASS}
          >
            {PLAYBOOK_ROLE_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <PlaybookFieldHint>
            Agent végzi automatikusan, vagy emberi szerepkör vár el interakciót (jóváhagyás,
            kitöltés). Mentéskor a JSON roles tömbjében is frissül.
          </PlaybookFieldHint>
        </label>
      </div>

      {form.roleType === 'agent_role' && (
        <fieldset className="rounded border border-ink/10 p-2 space-y-1">
          <legend className="px-1 text-xs font-semibold text-ink-soft">
            Szükséges képességek (requiredCapabilities)
          </legend>
          <PlaybookFieldHint>
            Az agent csak akkor köthető ehhez a szerephez, ha ezek a tool-ok engedélyezve vannak nála.
            Jelöld be azokat, amelyeket a lépés ténylegesen használ.
          </PlaybookFieldHint>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
            {ALL_CAPABILITIES.map((cap) => (
              <label key={cap} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={form.requiredCapabilities.includes(cap)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...form.requiredCapabilities, cap]
                      : form.requiredCapabilities.filter((c) => c !== cap)
                    patch({ requiredCapabilities: next })
                  }}
                />
                <span className="font-mono">{cap}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <label className="block text-xs">
        <span className={LABEL_CLASS}>Prompt sablon (instructionTemplate)</span>
        <textarea
          value={form.instructionTemplate}
          onChange={(e) => onChange(applyInstructionTemplateToForm(form, e.target.value))}
          rows={4}
          className={`${FIELD_CLASS} font-mono`}
          placeholder="Pl.: Gyűjts infót a {{companyName}} cégről…"
        />
        <PlaybookFieldHint>
          Az agent tényleges utasítása. A dupla kapcsos zárójeles változók helyére futáskor kerülnek
          az adatok (pl. bank neve, kampánycsatorna). Új változó hozzáadásakor az input rések listája
          automatikusan frissül.
        </PlaybookFieldHint>
      </label>

      {form.inputSlots.length > 0 && (
        <fieldset className="rounded border border-ink/10 p-2 space-y-2">
          <legend className="px-1 text-xs font-semibold text-ink-soft">Input rések (inputSlots)</legend>
          <PlaybookFieldHint>
            A promptban használt változók definíciói — honnan jön az értékük, kötelező-e, milyen típusú.
          </PlaybookFieldHint>
          {form.inputSlots.map((slot, i) => (
            <div key={slot.name} className="grid gap-2 rounded border border-ink/10 bg-paper/40 p-2 sm:grid-cols-2">
              <label className="block text-xs sm:col-span-2">
                <span className={LABEL_CLASS}>{'{{'}{slot.name}{'}}'}</span>
                <input value={slot.name} readOnly className={`${FIELD_CLASS} text-ink-soft`} />
              </label>
              <label className="block text-xs">
                <span className={LABEL_CLASS}>Típus</span>
                <select
                  value={slot.type}
                  onChange={(e) =>
                    updateInputSlot(i, { type: e.target.value as PlaybookInputSlot['type'] })
                  }
                  className={FIELD_CLASS}
                >
                  {INPUT_SLOT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <PlaybookFieldHint>Szöveg, szám, igaz/hamis vagy szabad formátum — validáláshoz.</PlaybookFieldHint>
              </label>
              <label className="block text-xs">
                <span className={LABEL_CLASS}>Forrás</span>
                <select
                  value={slot.source}
                  onChange={(e) =>
                    updateInputSlot(i, { source: e.target.value as PlaybookInputSlot['source'] })
                  }
                  className={FIELD_CLASS}
                >
                  {INPUT_SLOT_SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <PlaybookFieldHint>
                  config: egyszer beállított érték a folyamatnál; trigger: minden futásnál érkező
                  bemenet (pl. chatből, ticketből).
                </PlaybookFieldHint>
              </label>
              <div className="sm:col-span-2">
                <label className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={slot.required}
                    onChange={(e) => updateInputSlot(i, { required: e.target.checked })}
                  />
                  <span>Kötelező (required) — a lépés nem indul, ha hiányzik</span>
                </label>
              </div>
              <label className="block text-xs sm:col-span-2">
                <span className={LABEL_CLASS}>Leírás</span>
                <input
                  value={slot.description}
                  onChange={(e) => updateInputSlot(i, { description: e.target.value })}
                  className={FIELD_CLASS}
                />
                <PlaybookFieldHint>Segítség az operátornak: mit jelent ez a mező üzletileg?</PlaybookFieldHint>
              </label>
            </div>
          ))}
        </fieldset>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs">
          <span className={LABEL_CLASS}>Timeout (perc, timeoutMinutes)</span>
          <input
            type="number"
            min={1}
            value={form.timeoutMinutes}
            onChange={(e) => patch({ timeoutMinutes: e.target.value })}
            className={FIELD_CLASS}
            placeholder="Pl.: 60"
          />
          <PlaybookFieldHint>
            Meddig várható a lépés befejezése? Ha lejár, a rendszer jelezhet vagy eskalálhat —
            elkerülve, hogy a folyamat örökre beragadjon.
          </PlaybookFieldHint>
        </label>
        <label className="block text-xs">
          <span className={LABEL_CLASS}>Engedélyezett állapotok (allowedStates)</span>
          <input
            value={form.allowedStatesText}
            onChange={(e) => patch({ allowedStatesText: e.target.value })}
            className={FIELD_CLASS}
            placeholder="ready, in_progress, done, failed"
          />
          <PlaybookFieldHint>
            A ticket milyen állapotokon mehet át ebben a lépésben (vesszővel elválasztva). Pl. emberi
            lépésnél: awaiting_human, approved.
          </PlaybookFieldHint>
        </label>
      </div>

      {gateIds.length > 0 && (
        <fieldset className="rounded border border-ink/10 p-2 space-y-1">
          <legend className="px-1 text-xs font-semibold text-ink-soft">
            Kötelező kapuk (requiredGateIds)
          </legend>
          <PlaybookFieldHint>
            Mely jóváhagyási pontoknak kell teljesülniük, mielőtt ez a lépés lezárulhat? A folyamat
            addig vár, amíg a kijelölt kapukon át nem engedik.
          </PlaybookFieldHint>
          {gateIds.map((gid) => (
            <label key={gid} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={form.requiredGateIds.includes(gid)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...form.requiredGateIds, gid]
                    : form.requiredGateIds.filter((id) => id !== gid)
                  patch({ requiredGateIds: next })
                }}
              />
              {gid}
            </label>
          ))}
        </fieldset>
      )}

      <fieldset className="rounded border border-ink/10 p-2 space-y-2">
        <legend className="px-1 text-xs font-semibold text-ink-soft">
          Befejezési szabályok (onComplete)
        </legend>
        <PlaybookFieldHint>
          Mi történjen, ha a lépés kész? Hova menjen tovább a folyamat — következő lépésre vagy
          ellenőrző kapura. Feltétellel elágazhatsz (pl. magas confidence → egyenesen tovább, alacsony → review).
        </PlaybookFieldHint>
        {form.onCompleteRules.length === 0 && (
          <p className="text-xs text-ink-faint">Nincs szabály — adj hozzá legalább egyet.</p>
        )}
        {form.onCompleteRules.map((rule, i) => (
          <div key={i} className="space-y-2 rounded border border-ink/10 bg-paper/40 p-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block text-xs">
                <span className={LABEL_CLASS}>Feltétel</span>
                <select
                  value={rule.conditionKind}
                  onChange={(e) =>
                    updateOnCompleteRule(i, {
                      conditionKind: e.target.value as 'default' | 'field',
                    })
                  }
                  className={FIELD_CLASS}
                >
                  <option value="default">alap (default)</option>
                  <option value="field">mező összehasonlítás</option>
                </select>
              </label>
              <label className="block text-xs">
                <span className={LABEL_CLASS}>Cél típusa</span>
                <select
                  value={rule.targetKind}
                  onChange={(e) =>
                    updateOnCompleteRule(i, { targetKind: e.target.value as 'step' | 'gate' })
                  }
                  className={FIELD_CLASS}
                >
                  <option value="step">következő lépés</option>
                  <option value="gate">kapu</option>
                </select>
              </label>
            </div>
            {rule.conditionKind === 'field' && (
              <div className="grid gap-2 sm:grid-cols-3">
                <label className="block text-xs">
                  <span className={LABEL_CLASS}>Mező</span>
                  <input
                    value={rule.field}
                    onChange={(e) => updateOnCompleteRule(i, { field: e.target.value })}
                    className={FIELD_CLASS}
                  />
                </label>
                <label className="block text-xs">
                  <span className={LABEL_CLASS}>Operátor</span>
                  <select
                    value={rule.op}
                    onChange={(e) =>
                      updateOnCompleteRule(i, { op: e.target.value as ConditionOp })
                    }
                    className={FIELD_CLASS}
                  >
                    {CONDITION_OPS.map((op) => (
                      <option key={op} value={op}>
                        {op}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs">
                  <span className={LABEL_CLASS}>Érték</span>
                  <input
                    value={rule.value}
                    onChange={(e) => updateOnCompleteRule(i, { value: e.target.value })}
                    className={FIELD_CLASS}
                  />
                </label>
              </div>
            )}
            <label className="block text-xs">
              <span className={LABEL_CLASS}>
                {rule.targetKind === 'gate' ? 'Kapu (gateId)' : 'Lépés (nextStepId)'}
              </span>
              <select
                value={rule.targetId}
                onChange={(e) => updateOnCompleteRule(i, { targetId: e.target.value })}
                className={FIELD_CLASS}
              >
                <option value="">— válassz —</option>
                {(rule.targetKind === 'gate' ? gateIds : stepIds).map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() =>
                patch({ onCompleteRules: form.onCompleteRules.filter((_, j) => j !== i) })
              }
              className="text-xs text-coral hover:underline"
            >
              Szabály törlése
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            patch({ onCompleteRules: [...form.onCompleteRules, emptyOnCompleteRule()] })
          }
          className="rounded border border-ink/20 px-2 py-1 text-xs"
        >
          + Szabály hozzáadása
        </button>
      </fieldset>

      <fieldset className="rounded border border-ink/10 p-2 space-y-2">
        <legend className="px-1 text-xs font-semibold text-ink-soft">Újrapróbálás (retryPolicy)</legend>
        <PlaybookFieldHint>
          Ha az agent vagy a rendszer hibázik, hányszor próbálkozzon újra, és mi legyen, ha elfogynak
          a próbák (folyamat leáll vs. emberi vizsgálat).
        </PlaybookFieldHint>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block text-xs">
            <span className={LABEL_CLASS}>Max. próbálkozás (maxAttempts)</span>
            <input
              type="number"
              min={1}
              value={form.retryMaxAttempts}
              onChange={(e) => patch({ retryMaxAttempts: e.target.value })}
              className={FIELD_CLASS}
            />
          </label>
          <label className="block text-xs">
            <span className={LABEL_CLASS}>Kimerülés esetén (onExhausted)</span>
            <select
              value={form.retryOnExhausted}
              onChange={(e) =>
                patch({
                  retryOnExhausted: e.target.value as StepFormState['retryOnExhausted'],
                })
              }
              className={FIELD_CLASS}
            >
              <option value="">— nincs —</option>
              <option value="fail_process">fail_process</option>
              <option value="manual_review">manual_review</option>
            </select>
          </label>
        </div>
      </fieldset>

      <div className="grid gap-2 lg:grid-cols-2">
        <label className="block text-xs">
          <span className={LABEL_CLASS}>Bemeneti szerződés (inputContract, JSON)</span>
          <textarea
            value={form.inputContractJson}
            onChange={(e) => patch({ inputContractJson: e.target.value })}
            rows={4}
            spellCheck={false}
            className={`${FIELD_CLASS} font-mono text-xs`}
            placeholder="{}"
          />
          <PlaybookFieldHint>
            Haladó: milyen mezőket vár el a lépés bemenetén (gépi validáció). Üresen hagyható, ha nem
            kell szigorú séma.
          </PlaybookFieldHint>
        </label>
        <label className="block text-xs">
          <span className={LABEL_CLASS}>Kimeneti szerződés (outputContract, JSON)</span>
          <textarea
            value={form.outputContractJson}
            onChange={(e) => patch({ outputContractJson: e.target.value })}
            rows={4}
            spellCheck={false}
            className={`${FIELD_CLASS} font-mono text-xs`}
            placeholder="{}"
          />
          <PlaybookFieldHint>
            Haladó: milyen mezőket kell produkálnia a lépésnek befejezéskor. Segít ellenőrizni, hogy
            a következő lépés megkapja-e a szükséges adatokat.
          </PlaybookFieldHint>
        </label>
      </div>
    </div>
  )
}
