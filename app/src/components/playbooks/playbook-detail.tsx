'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  createPlaybookVersionV2,
  validatePlaybookVersionV2,
  submitPlaybookVersionV2,
  publishPlaybookVersionV2,
  rejectPlaybookVersionV2,
  assignPlaybookV2,
} from '@/app/actions/playbook'

type ValidationResult = {
  valid: boolean
  errors: Array<{ code: string; path: string; message: string }>
  warnings: Array<{ code: string; path: string; message: string }>
}

export type VersionView = {
  id: string
  version: number
  status: string
  changeSummary: string
  contentHash: string
  validationResult: unknown
  publishedAt: string | null
  createdAt: string
}

export type PlaybookHead = {
  id: string
  key: string
  name: string
  processType: string
  status: string
}

const VERSION_TONE: Record<string, string> = {
  draft: 'bg-ink/8 text-ink-soft',
  pending_approval: 'bg-honey/15 text-honey',
  published: 'bg-sage/15 text-sage',
  rejected: 'bg-coral/15 text-coral',
  retired: 'bg-ink/8 text-ink-soft',
}

const STARTER_SPEC = (key: string, processType: string) =>
  JSON.stringify(
    {
      schemaVersion: '1.0',
      key,
      name: key,
      processType,
      entryStepId: 'extract',
      roles: [
        { key: 'extractor', type: 'agent_role' },
        { key: 'approver', type: 'human_role', requiredPermissions: ['ticket:approve'] },
      ],
      steps: [
        {
          id: 'extract',
          name: 'Adatkinyerés',
          ticketType: 'interaction',
          assignedRole: 'extractor',
          allowedStates: ['ready', 'in_progress', 'done'],
          onComplete: [{ condition: 'default', nextStepId: 'approval' }],
        },
        {
          id: 'approval',
          name: 'Jóváhagyás',
          ticketType: 'interaction',
          assignedRole: 'approver',
          allowedStates: ['awaiting_human', 'approved'],
          requiredGateIds: ['approve_posting'],
        },
      ],
      gates: [
        {
          id: 'approve_posting',
          type: 'human_approval',
          requiredActorRole: 'approver',
          blocking: true,
          criticality: 'L2',
          evidenceRequired: true,
        },
      ],
      transitions: [{ fromStepId: 'extract', toStepId: 'approval', trigger: 'step.completed' }],
      outputContract: { requiredFields: ['decision'] },
    },
    null,
    2,
  )

function asValidation(v: unknown): ValidationResult | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Partial<ValidationResult>
  if (typeof r.valid !== 'boolean') return null
  return { valid: r.valid, errors: r.errors ?? [], warnings: r.warnings ?? [] }
}

export function PlaybookDetail({
  playbook,
  versions,
  canEdit,
  canApprove,
}: {
  playbook: PlaybookHead
  versions: VersionView[]
  canEdit: boolean
  canApprove: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [specText, setSpecText] = useState(() => STARTER_SPEC(playbook.key, playbook.processType))
  const [changeSummary, setChangeSummary] = useState('')
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  function run(fn: () => Promise<{ success: boolean; error?: string }>, okText: string) {
    setMessage(null)
    startTransition(async () => {
      const res = await fn()
      if (res.success) {
        setMessage({ tone: 'ok', text: okText })
        router.refresh()
      } else {
        setMessage({ tone: 'err', text: res.error ?? 'Hiba' })
      }
    })
  }

  function createVersion() {
    setMessage(null)
    let spec: unknown
    try {
      spec = JSON.parse(specText)
    } catch {
      setMessage({ tone: 'err', text: 'A spec nem érvényes JSON.' })
      return
    }
    if (!changeSummary.trim()) {
      setMessage({ tone: 'err', text: 'Adj meg változás-összefoglalót.' })
      return
    }
    startTransition(async () => {
      const res = await createPlaybookVersionV2({ playbookId: playbook.id, spec, changeSummary })
      if (res.success) {
        const v = asValidation(res.data.validation)
        setChangeSummary('')
        setMessage({
          tone: v?.valid ? 'ok' : 'err',
          text: v?.valid
            ? `v${res.data.version} létrehozva, validáció zöld.`
            : `v${res.data.version} létrehozva, de szemantikai hibák: ${
                v?.errors.map((e) => e.code).join(', ') ?? '—'
              }`,
        })
        router.refresh()
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  return (
    <div className="space-y-6">
      <div className="atelier-card p-5">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-lg font-semibold">{playbook.name}</h2>
          <span className="font-mono text-xs text-ink-soft">{playbook.key}</span>
        </div>
        <p className="mt-1 text-xs text-ink-soft">Folyamattípus: {playbook.processType}</p>
      </div>

      {canEdit && (
        <section className="atelier-card p-5">
          <h2 className="mb-3 font-display text-lg font-semibold">Új verzió (JSON spec)</h2>
          <textarea
            value={specText}
            onChange={(e) => setSpecText(e.target.value)}
            rows={18}
            spellCheck={false}
            className="w-full rounded-lg border border-ink/15 bg-transparent px-3 py-2 font-mono text-xs"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={changeSummary}
              onChange={(e) => setChangeSummary(e.target.value)}
              placeholder="Változás összefoglaló"
              className="flex-1 rounded-lg border border-ink/15 bg-transparent px-3 py-2 text-sm"
            />
            <button
              onClick={createVersion}
              disabled={pending}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? 'Mentés…' : 'Verzió létrehozása'}
            </button>
          </div>
        </section>
      )}

      {message && (
        <p className={`text-sm ${message.tone === 'ok' ? 'text-sage' : 'text-coral'}`}>{message.text}</p>
      )}

      <section className="atelier-card p-5">
        <h2 className="mb-4 font-display text-lg font-semibold">Verziók</h2>
        <ul className="space-y-3">
          {versions.map((v) => {
            const validation = asValidation(v.validationResult)
            return (
              <li key={v.id} className="rounded-lg border border-ink/10 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">v{v.version}</span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        VERSION_TONE[v.status] ?? 'bg-ink/8 text-ink-soft'
                      }`}
                    >
                      {v.status}
                    </span>
                    {validation && (
                      <span
                        className={`text-xs ${validation.valid ? 'text-sage' : 'text-coral'}`}
                      >
                        {validation.valid
                          ? 'valid'
                          : `${validation.errors.length} hiba`}
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-[10px] text-ink-soft">
                    {v.contentHash.slice(0, 18)}…
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-soft">{v.changeSummary}</p>

                {validation && !validation.valid && validation.errors.length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {validation.errors.map((e, i) => (
                      <li key={i} className="font-mono text-[11px] text-coral">
                        {e.code} @ {e.path}: {e.message}
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  {canEdit && v.status === 'draft' && (
                    <>
                      <button
                        onClick={() =>
                          run(
                            () => validatePlaybookVersionV2({ playbookVersionId: v.id }),
                            'Validáció lefutott.',
                          )
                        }
                        disabled={pending}
                        className="rounded-lg border border-ink/20 px-3 py-1.5 text-xs disabled:opacity-50"
                      >
                        Validálás
                      </button>
                      <button
                        onClick={() =>
                          run(
                            () => submitPlaybookVersionV2({ playbookVersionId: v.id }),
                            'Jóváhagyásra küldve.',
                          )
                        }
                        disabled={pending}
                        className="rounded-lg border border-ink/20 px-3 py-1.5 text-xs disabled:opacity-50"
                      >
                        Jóváhagyásra küldés
                      </button>
                    </>
                  )}
                  {canApprove && v.status === 'pending_approval' && (
                    <>
                      <button
                        onClick={() =>
                          run(
                            () => publishPlaybookVersionV2({ playbookVersionId: v.id }),
                            'Verzió publikálva.',
                          )
                        }
                        disabled={pending}
                        className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                      >
                        Publikálás
                      </button>
                      <button
                        onClick={() => {
                          const reason = prompt('Elutasítás indoka:')
                          if (reason)
                            run(
                              () => rejectPlaybookVersionV2({ playbookVersionId: v.id, reason }),
                              'Verzió elutasítva.',
                            )
                        }}
                        disabled={pending}
                        className="rounded-lg border border-coral/40 px-3 py-1.5 text-xs text-coral disabled:opacity-50"
                      >
                        Elutasítás
                      </button>
                    </>
                  )}
                  {canEdit && v.status === 'published' && (
                    <button
                      onClick={() =>
                        run(
                          () =>
                            assignPlaybookV2({
                              playbookVersionId: v.id,
                              assignmentType: 'process_type',
                              assignmentKey: playbook.processType,
                              isDefault: true,
                            }),
                          `Alapértelmezett Playbook beállítva a(z) ${playbook.processType} folyamattípushoz.`,
                        )
                      }
                      disabled={pending}
                      className="rounded-lg border border-ink/20 px-3 py-1.5 text-xs disabled:opacity-50"
                    >
                      Beállítás alapértelmezettnek ({playbook.processType})
                    </button>
                  )}
                </div>
              </li>
            )
          })}
          {versions.length === 0 && <li className="text-sm text-ink-soft">Még nincs verzió.</li>}
        </ul>
      </section>
    </div>
  )
}
