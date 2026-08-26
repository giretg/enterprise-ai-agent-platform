'use client'

/**
 * StepTemplate admin CRUD UI (Governed Flow Builder WP-3, §6).
 * Strukturált űrlap (NEM JSON) a governance-safe lépés-legókhoz: draft → published → retired,
 * opcionális "certified" eval-tier (D8). A globális (seed) sablonok read-only-k.
 */
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  createStepTemplateAction,
  updateStepTemplateAction,
  publishStepTemplateAction,
  retireStepTemplateAction,
  deleteStepTemplateAction,
  setStepTemplateEvalSamplesAction,
  certifyStepTemplateVersionAction,
} from '@/app/actions/step-template'
import { confirmDialog } from '@/components/ui/confirm-dialog'

type VersionView = {
  id: string
  version: number
  contentHash: string
  certified: boolean
  evalSampleCount: number
  isCurrentPublished: boolean
  createdAt: string
}
type Fragment = { step: Record<string, unknown>; suggestedGate: Record<string, unknown> | null }
export type StepTemplateAdminView = {
  id: string
  tenantId: string | null
  key: string
  name: string
  description: string
  category: string
  status: 'draft' | 'published' | 'retired'
  editable: boolean
  latestVersion: number
  fragment: Fragment | null
  currentPublishedVersionId: string | null
  versions: VersionView[]
  updatedAt: string
}

const STATUS_TONE: Record<string, string> = {
  draft: 'bg-ink/8 text-ink-soft',
  published: 'bg-sage/15 text-sage',
  retired: 'bg-coral/15 text-coral',
}

type FragmentForm = {
  name: string
  ticketType: string
  requiredCapabilities: string
  requiredFields: string
  criticality: string
  instructionTemplate: string
  gateEnabled: boolean
  gateId: string
  gateCriticality: string
  gateBlocking: boolean
  gateEvidenceRequired: boolean
}

const EMPTY_FORM: FragmentForm = {
  name: '',
  ticketType: '',
  requiredCapabilities: '',
  requiredFields: '',
  criticality: 'L1',
  instructionTemplate: '',
  gateEnabled: false,
  gateId: '',
  gateCriticality: 'L2',
  gateBlocking: true,
  gateEvidenceRequired: true,
}

function csvToArray(v: string): string[] {
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function formToFragment(f: FragmentForm): Fragment {
  const step: Record<string, unknown> = {
    id: '__PLACEHOLDER__',
    name: f.name.trim(),
    assignedRole: '__ROLE__',
  }
  if (f.ticketType.trim()) step.ticketType = f.ticketType.trim()
  const caps = csvToArray(f.requiredCapabilities)
  if (caps.length) step.requiredCapabilities = caps
  const fields = csvToArray(f.requiredFields)
  if (fields.length) step.outputContract = { requiredFields: fields }
  if (f.instructionTemplate.trim()) step.instructionTemplate = f.instructionTemplate.trim()
  if (f.criticality) step.criticality = f.criticality
  const suggestedGate = f.gateEnabled
    ? {
        id: f.gateId.trim() || 'approval',
        type: 'human_approval',
        blocking: f.gateBlocking,
        criticality: f.gateCriticality,
        evidenceRequired: f.gateEvidenceRequired,
      }
    : null
  return { step, suggestedGate }
}

function fragmentToForm(fr: Fragment | null): FragmentForm {
  if (!fr) return { ...EMPTY_FORM }
  const s = fr.step as Record<string, unknown>
  const oc = (s.outputContract as { requiredFields?: unknown } | undefined)?.requiredFields
  const g = fr.suggestedGate as Record<string, unknown> | null
  return {
    name: typeof s.name === 'string' ? s.name : '',
    ticketType: typeof s.ticketType === 'string' ? s.ticketType : '',
    requiredCapabilities: Array.isArray(s.requiredCapabilities)
      ? (s.requiredCapabilities as string[]).join(', ')
      : '',
    requiredFields: Array.isArray(oc) ? (oc as string[]).join(', ') : '',
    criticality: typeof s.criticality === 'string' ? s.criticality : 'L1',
    instructionTemplate: typeof s.instructionTemplate === 'string' ? s.instructionTemplate : '',
    gateEnabled: !!g,
    gateId: g && typeof g.id === 'string' ? g.id : '',
    gateCriticality: g && typeof g.criticality === 'string' ? g.criticality : 'L2',
    gateBlocking: g ? g.blocking !== false : true,
    gateEvidenceRequired: g ? g.evidenceRequired !== false : true,
  }
}

const inputCls = 'w-full rounded border border-ink/15 bg-transparent px-2 py-1 text-sm'
const labelCls = 'text-xs font-medium text-ink-soft'

function FragmentFields({
  form,
  onChange,
}: {
  form: FragmentForm
  onChange: (patch: Partial<FragmentForm>) => void
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1">
        <span className={labelCls}>Lépés neve *</span>
        <input className={inputCls} value={form.name} onChange={(e) => onChange({ name: e.target.value })} />
      </label>
      <label className="space-y-1">
        <span className={labelCls}>Ticket típus</span>
        <input
          className={inputCls}
          value={form.ticketType}
          onChange={(e) => onChange({ ticketType: e.target.value })}
          placeholder="pl. invoice_classification"
        />
      </label>
      <label className="space-y-1">
        <span className={labelCls}>Javasolt capability-k (vessző)</span>
        <input
          className={inputCls}
          value={form.requiredCapabilities}
          onChange={(e) => onChange({ requiredCapabilities: e.target.value })}
          placeholder="file_read, kb_search"
        />
      </label>
      <label className="space-y-1">
        <span className={labelCls}>Kimeneti mezők (requiredFields, vessző)</span>
        <input
          className={inputCls}
          value={form.requiredFields}
          onChange={(e) => onChange({ requiredFields: e.target.value })}
          placeholder="decision, confidence, evidence"
        />
      </label>
      <label className="space-y-1">
        <span className={labelCls}>Kritikalitás</span>
        <select
          className={inputCls}
          value={form.criticality}
          onChange={(e) => onChange({ criticality: e.target.value })}
        >
          <option value="L1">L1</option>
          <option value="L2">L2</option>
          <option value="L3">L3</option>
        </select>
      </label>
      <label className="space-y-1 sm:col-span-2">
        <span className={labelCls}>Prompt sablon (instructionTemplate)</span>
        <textarea
          className={`${inputCls} min-h-[64px]`}
          value={form.instructionTemplate}
          onChange={(e) => onChange({ instructionTemplate: e.target.value })}
        />
      </label>
      <div className="space-y-2 sm:col-span-2 rounded-lg border border-ink/10 p-3">
        <label className="flex items-center gap-2 text-xs font-medium text-ink">
          <input
            type="checkbox"
            checked={form.gateEnabled}
            onChange={(e) => onChange({ gateEnabled: e.target.checked })}
          />
          Ajánlott jóváhagyó kapu
        </label>
        {form.gateEnabled && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className={labelCls}>Kapu azonosító</span>
              <input className={inputCls} value={form.gateId} onChange={(e) => onChange({ gateId: e.target.value })} placeholder="approval" />
            </label>
            <label className="space-y-1">
              <span className={labelCls}>Kapu kritikalitás</span>
              <select
                className={inputCls}
                value={form.gateCriticality}
                onChange={(e) => onChange({ gateCriticality: e.target.value })}
              >
                <option value="L1">L1</option>
                <option value="L2">L2</option>
                <option value="L3">L3</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-ink-soft">
              <input type="checkbox" checked={form.gateBlocking} onChange={(e) => onChange({ gateBlocking: e.target.checked })} />
              Blokkoló
            </label>
            <label className="flex items-center gap-2 text-xs text-ink-soft">
              <input
                type="checkbox"
                checked={form.gateEvidenceRequired}
                onChange={(e) => onChange({ gateEvidenceRequired: e.target.checked })}
              />
              Bizonyíték kötelező
            </label>
          </div>
        )}
      </div>
      <p className="sm:col-span-2 text-[11px] text-ink-soft">
        A szerep <span className="font-mono">__ROLE__</span> placeholder marad — beszúráskor kell valós
        role-hoz kötni. A sablon SOHA nem ad futásidejű tool-jogot (a Tool Broker dönt).
      </p>
    </div>
  )
}

function EvalEditor({
  templateId,
  versionId,
  onResult,
}: {
  templateId: string
  versionId: string
  onResult: (r: { success: boolean; error?: string }) => void
}) {
  const [rows, setRows] = useState<string[]>([''])
  const [pending, startTransition] = useTransition()
  function save() {
    const evalSamples = rows
      .map((r) => ({ sampleInput: {}, expectations: csvToArray(r) }))
      .filter((s) => s.expectations.length > 0)
    startTransition(async () => {
      onResult(await setStepTemplateEvalSamplesAction({ id: templateId, versionId, evalSamples }))
    })
  }
  return (
    <div className="space-y-2 rounded-lg border border-honey/20 bg-honey/5 p-3">
      <p className="text-xs font-medium text-ink">Eval-minták (certifikáláshoz, D8)</p>
      <p className="text-[11px] text-ink-soft">
        Mintánként vesszővel elválasztott elvárások; ezeknek le kell fedniük a kötelező kimeneti
        mezőket. A mentés felülírja a verzió korábbi eval-mintáit.
      </p>
      {rows.map((r, i) => (
        <div key={i} className="flex gap-1.5">
          <input
            className={inputCls}
            value={r}
            onChange={(e) => setRows((rs) => rs.map((x, xi) => (xi === i ? e.target.value : x)))}
            placeholder="decision, confidence, evidence"
          />
          <button
            onClick={() => setRows((rs) => rs.filter((_, xi) => xi !== i))}
            className="rounded border border-ink/20 px-2 text-xs"
          >
            −
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <button onClick={() => setRows((rs) => [...rs, ''])} className="rounded border border-ink/20 px-2 py-1 text-xs">
          + minta
        </button>
        <button
          onClick={save}
          disabled={pending}
          className="rounded border border-honey/40 px-2 py-1 text-xs text-honey disabled:opacity-50"
        >
          Eval-minták mentése
        </button>
      </div>
    </div>
  )
}

export function StepTemplateAdmin({ templates }: { templates: StepTemplateAdminView[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const [creating, setCreating] = useState(false)
  const [createKey, setCreateKey] = useState('')
  const [createName, setCreateName] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [createCat, setCreateCat] = useState('')
  const [createForm, setCreateForm] = useState<FragmentForm>({ ...EMPTY_FORM })

  const [editId, setEditId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<FragmentForm>({ ...EMPTY_FORM })
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editCat, setEditCat] = useState('')

  function run(fn: () => Promise<{ success: boolean; error?: string }>, okText: string) {
    setMsg(null)
    startTransition(async () => {
      const res = await fn()
      if (res.success) {
        setMsg({ tone: 'ok', text: okText })
        router.refresh()
      } else {
        setMsg({ tone: 'err', text: res.error ?? 'Ismeretlen hiba' })
      }
    })
  }

  function submitCreate() {
    run(
      () =>
        createStepTemplateAction({
          key: createKey,
          name: createName,
          description: createDesc || undefined,
          category: createCat || undefined,
          fragment: formToFragment({ ...createForm, name: createForm.name || createName }),
        }),
      'Sablon létrehozva (vázlat).',
    )
    setCreating(false)
    setCreateKey('')
    setCreateName('')
    setCreateDesc('')
    setCreateCat('')
    setCreateForm({ ...EMPTY_FORM })
  }

  function startEdit(t: StepTemplateAdminView) {
    setEditId(t.id)
    setEditForm(fragmentToForm(t.fragment))
    setEditName(t.name)
    setEditDesc(t.description)
    setEditCat(t.category)
  }

  function submitEdit(id: string) {
    run(
      () =>
        updateStepTemplateAction({
          id,
          name: editName,
          description: editDesc,
          category: editCat,
          fragment: formToFragment(editForm),
        }),
      'Sablon frissítve.',
    )
    setEditId(null)
  }

  return (
    <div className="space-y-4">
      {msg && (
        <p className={`rounded-lg px-3 py-2 text-sm ${msg.tone === 'ok' ? 'bg-sage/15 text-sage' : 'bg-coral/15 text-coral'}`}>
          {msg.text}
        </p>
      )}

      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold">Lépés-sablonok</h2>
        <button
          onClick={() => setCreating((v) => !v)}
          className="rounded-lg border border-ink/20 px-3 py-1.5 text-sm hover:bg-ink/5"
        >
          {creating ? 'Mégse' : '+ Új sablon'}
        </button>
      </div>

      {creating && (
        <div className="atelier-card space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className={labelCls}>Kulcs * (kisbetű-kötőjel)</span>
              <input className={inputCls} value={createKey} onChange={(e) => setCreateKey(e.target.value)} placeholder="invoice-triage" />
            </label>
            <label className="space-y-1">
              <span className={labelCls}>Megjelenő név *</span>
              <input className={inputCls} value={createName} onChange={(e) => setCreateName(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className={labelCls}>Kategória</span>
              <input className={inputCls} value={createCat} onChange={(e) => setCreateCat(e.target.value)} placeholder="Pénzügy" />
            </label>
            <label className="space-y-1">
              <span className={labelCls}>Leírás</span>
              <input className={inputCls} value={createDesc} onChange={(e) => setCreateDesc(e.target.value)} />
            </label>
          </div>
          <FragmentFields form={createForm} onChange={(patch) => setCreateForm((f) => ({ ...f, ...patch }))} />
          <button
            onClick={submitCreate}
            disabled={pending || !createKey || !createName}
            className="rounded-lg bg-ink px-4 py-1.5 text-sm text-paper disabled:opacity-50"
          >
            Létrehozás (vázlat)
          </button>
        </div>
      )}

      <div className="space-y-3">
        {templates.length === 0 && <p className="text-sm text-ink-soft">Még nincs sablon.</p>}
        {templates.map((t) => {
          const current = t.versions.find((v) => v.isCurrentPublished) ?? t.versions[0]
          return (
            <div key={t.id} className="atelier-card space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-ink">{t.name}</h3>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[t.status]}`}>
                      {t.status}
                    </span>
                    {t.tenantId === null && (
                      <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-semibold text-sky-300">
                        globális
                      </span>
                    )}
                    {current?.certified && (
                      <span className="rounded-full bg-honey/20 px-2 py-0.5 text-[11px] font-semibold text-honey">
                        ✓ certified
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 font-mono text-[11px] text-ink-soft">
                    {t.key} · v{t.latestVersion} · {t.category || 'nincs kategória'}
                  </p>
                  {t.description && <p className="mt-1 text-sm text-ink-soft">{t.description}</p>}
                </div>
                {t.editable && (
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      onClick={() => (editId === t.id ? setEditId(null) : startEdit(t))}
                      className="rounded border border-ink/20 px-2 py-1 text-xs hover:bg-ink/5"
                    >
                      {editId === t.id ? 'Bezár' : 'Szerkeszt'}
                    </button>
                    {t.status !== 'published' && (
                      <button
                        onClick={() => run(() => publishStepTemplateAction({ id: t.id }), 'Publikálva.')}
                        disabled={pending}
                        className="rounded border border-sage/40 px-2 py-1 text-xs text-sage hover:bg-sage/10 disabled:opacity-50"
                      >
                        Publikál
                      </button>
                    )}
                    {t.status === 'published' && (
                      <button
                        onClick={() => run(() => retireStepTemplateAction({ id: t.id }), 'Visszavonva.')}
                        disabled={pending}
                        className="rounded border border-coral/40 px-2 py-1 text-xs text-coral hover:bg-coral/10 disabled:opacity-50"
                      >
                        Visszavon
                      </button>
                    )}
                    {t.status === 'draft' && !t.currentPublishedVersionId && (
                      <button
                        onClick={() => {
                          void (async () => {
                            const confirmed = await confirmDialog({
                              title: 'Sablon törlése',
                              description: `Biztosan törlöd: ${t.name}?`,
                              confirmLabel: 'Törlés',
                              tone: 'danger',
                            })
                            if (!confirmed) return
                            run(() => deleteStepTemplateAction({ id: t.id }), 'Törölve.')
                          })()
                        }}
                        disabled={pending}
                        className="rounded border border-coral/40 px-2 py-1 text-xs text-coral hover:bg-coral/10 disabled:opacity-50"
                      >
                        Törlés
                      </button>
                    )}
                    {current && !current.certified && (
                      <button
                        onClick={() =>
                          run(
                            () => certifyStepTemplateVersionAction({ id: t.id, versionId: current.id }),
                            'Certifikálva.',
                          )
                        }
                        disabled={pending || current.evalSampleCount === 0}
                        title={current.evalSampleCount === 0 ? 'Előbb adj eval-mintát' : 'Certify'}
                        className="rounded border border-honey/40 px-2 py-1 text-xs text-honey hover:bg-honey/10 disabled:opacity-50"
                      >
                        Certify
                      </button>
                    )}
                  </div>
                )}
              </div>

              {editId === t.id && (
                <div className="space-y-3 rounded-lg border border-ink/10 bg-paper/40 p-3">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="space-y-1">
                      <span className={labelCls}>Név</span>
                      <input className={inputCls} value={editName} onChange={(e) => setEditName(e.target.value)} />
                    </label>
                    <label className="space-y-1">
                      <span className={labelCls}>Kategória</span>
                      <input className={inputCls} value={editCat} onChange={(e) => setEditCat(e.target.value)} />
                    </label>
                    <label className="space-y-1">
                      <span className={labelCls}>Leírás</span>
                      <input className={inputCls} value={editDesc} onChange={(e) => setEditDesc(e.target.value)} />
                    </label>
                  </div>
                  <FragmentFields form={editForm} onChange={(patch) => setEditForm((f) => ({ ...f, ...patch }))} />
                  <p className="text-[11px] text-ink-soft">
                    A fragment módosítása új verziót hoz létre; a publikált verzió változatlan marad, amíg
                    újra nem publikálod.
                  </p>
                  <button
                    onClick={() => submitEdit(t.id)}
                    disabled={pending}
                    className="rounded-lg bg-ink px-4 py-1.5 text-sm text-paper disabled:opacity-50"
                  >
                    Mentés
                  </button>
                  {current && (
                    <EvalEditor
                      templateId={t.id}
                      versionId={current.id}
                      onResult={(r) =>
                        r.success
                          ? (setMsg({ tone: 'ok', text: 'Eval-minták mentve.' }), router.refresh())
                          : setMsg({ tone: 'err', text: r.error ?? 'Hiba' })
                      }
                    />
                  )}
                </div>
              )}

              {t.versions.length > 0 && (
                <details className="text-xs text-ink-soft">
                  <summary className="cursor-pointer">Verziók ({t.versions.length})</summary>
                  <ul className="mt-1 space-y-0.5">
                    {t.versions.map((v) => (
                      <li key={v.id} className="font-mono">
                        v{v.version}
                        {v.isCurrentPublished ? ' · published' : ''}
                        {v.certified ? ' · ✓certified' : ''} · eval: {v.evalSampleCount} ·{' '}
                        {v.contentHash.slice(0, 16)}…
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
