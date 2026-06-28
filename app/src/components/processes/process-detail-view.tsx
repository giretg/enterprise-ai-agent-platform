'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { transitionProcessTicket, cancelProcess } from '@/app/actions/process'

export type ProcessStepView = {
  id: string
  stepId: string
  stepName: string
  status: string
  assignedRole: string
  ticketId: string | null
  startedAt: string | null
  completedAt: string | null
}

export type DelegationView = {
  id: string
  fromStepId: string
  toStepId: string
  fromActorType: string
  toActorType: string
  status: string
}

export type IntendedFlow = {
  entryStepId: string
  steps: Array<{ stepId: string; ticketType: string; assignedRole: string }>
  routes: Array<{ fromStepId: string; toStepId: string | null; gateId: string | null }>
  gates: Array<{
    gateId: string
    stepId: string
    requiredActorRole: string | null
    criticality: string | null
    evidenceRequired: boolean
    blocking: boolean
  }>
}

export type ProcessDetailData = {
  process: {
    id: string
    processType: string
    status: string
    playbookRef: string
    playbookContentHash: string
    startedByType: string
    startedAt: string
    completedAt: string | null
    rootTicketId: string | null
  }
  steps: ProcessStepView[]
  delegations: DelegationView[]
  intended: IntendedFlow | null
}

const STEP_TONE: Record<string, string> = {
  pending: 'bg-ink/8 text-ink-soft',
  ready: 'bg-sky-500/15 text-sky-300',
  in_progress: 'bg-sky-500/15 text-sky-300',
  awaiting_gate: 'bg-honey/15 text-honey',
  completed: 'bg-sage/15 text-sage',
  skipped: 'bg-ink/8 text-ink-soft',
  failed: 'bg-coral/15 text-coral',
}

const PROC_TONE: Record<string, string> = {
  created: 'bg-ink/8 text-ink-soft',
  running: 'bg-sky-500/15 text-sky-300',
  awaiting_human: 'bg-honey/15 text-honey',
  blocked: 'bg-coral/15 text-coral',
  completed: 'bg-sage/15 text-sage',
  failed: 'bg-coral/15 text-coral',
  cancelled: 'bg-ink/8 text-ink-soft',
}

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}>{children}</span>
}

export function ProcessDetailView({ data, canAct }: { data: ProcessDetailData; canAct: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [evidence, setEvidence] = useState('')

  const gateByStep = new Map((data.intended?.gates ?? []).map((g) => [g.stepId, g]))

  // §9.2 eltérés-jelölés: a delegacios él (from→to) szerepel-e a szándékolt routingban.
  const intendedEdges = new Set(
    (data.intended?.routes ?? [])
      .filter((r) => r.toStepId)
      .map((r) => `${r.fromStepId}→${r.toStepId}`),
  )

  function doTransition(ticketId: string, toState: string, withEvidence: boolean) {
    setMessage(null)
    let approvalEvidence: Record<string, unknown> | undefined
    if (withEvidence) {
      if (!evidence.trim()) {
        setMessage({ tone: 'err', text: 'A kapu jóváhagyásához bizonyíték szükséges.' })
        return
      }
      approvalEvidence = { note: evidence.trim() }
    }
    startTransition(async () => {
      const res = await transitionProcessTicket({ ticketId, toState, approvalEvidence })
      if (res.success) {
        setEvidence('')
        setMessage({ tone: 'ok', text: `Átmenet végrehajtva: → ${toState}` })
        router.refresh()
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  function doCancel() {
    const reason = prompt('A folyamat visszavonásának indoka:')
    if (!reason) return
    setMessage(null)
    startTransition(async () => {
      const res = await cancelProcess({ id: data.process.id, reason })
      if (res.success) {
        setMessage({ tone: 'ok', text: 'Folyamat visszavonva.' })
        router.refresh()
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  const isClosed = ['completed', 'failed', 'cancelled'].includes(data.process.status)

  return (
    <div className="space-y-6">
      <div className="atelier-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-display text-lg font-semibold">{data.process.processType}</h2>
              <Pill tone={PROC_TONE[data.process.status] ?? 'bg-ink/8 text-ink-soft'}>
                {data.process.status}
              </Pill>
            </div>
            <p className="mt-1 font-mono text-xs text-ink-soft">{data.process.playbookRef}</p>
          </div>
          {canAct && !isClosed && (
            <button
              onClick={doCancel}
              disabled={pending}
              className="rounded-lg border border-coral/40 px-3 py-1.5 text-sm text-coral disabled:opacity-50"
            >
              Folyamat visszavonása
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-ink-soft">
          Indítva: {new Date(data.process.startedAt).toLocaleString('hu-HU')} ({data.process.startedByType})
          {data.process.completedAt
            ? ` · Lezárva: ${new Date(data.process.completedAt).toLocaleString('hu-HU')}`
            : ''}
        </p>
      </div>

      {message && (
        <p className={`text-sm ${message.tone === 'ok' ? 'text-sage' : 'text-coral'}`}>{message.text}</p>
      )}

      {/* Step timeline + gate panel */}
      <section className="atelier-card p-5">
        <h2 className="mb-4 font-display text-lg font-semibold">Lépések</h2>
        <ol className="space-y-3">
          {data.steps.map((s) => {
            const gate = gateByStep.get(s.stepId)
            const showGateApproval =
              canAct && gate?.blocking && s.status !== 'completed' && !isClosed
            return (
              <li key={s.id} className="rounded-lg border border-ink/10 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-medium">{s.stepName}</span>
                    <span className="ml-2 font-mono text-xs text-ink-soft">{s.stepId}</span>
                  </div>
                  <Pill tone={STEP_TONE[s.status] ?? 'bg-ink/8 text-ink-soft'}>{s.status}</Pill>
                </div>
                <p className="mt-1 text-xs text-ink-soft">
                  Szerep: {s.assignedRole}
                  {gate ? (
                    <>
                      {' · '}Kötelező kapu: <span className="font-mono">{gate.gateId}</span>
                      {gate.criticality ? ` (${gate.criticality})` : ''}
                      {gate.evidenceRequired ? ' · bizonyíték kötelező' : ''}
                    </>
                  ) : null}
                </p>

                {showGateApproval && (
                  <div className="mt-3 rounded-lg bg-honey/5 p-3">
                    <p className="text-xs text-ink-soft">
                      Kötelező emberi kapu. A jóváhagyáshoz{' '}
                      {gate?.requiredActorRole ? (
                        <>
                          <span className="font-mono">{gate.requiredActorRole}</span> szerep és{' '}
                        </>
                      ) : null}
                      bizonyíték szükséges. Az agent nem kerülheti meg.
                    </p>
                    {gate?.evidenceRequired && (
                      <input
                        value={evidence}
                        onChange={(e) => setEvidence(e.target.value)}
                        placeholder="Jóváhagyási bizonyíték / megjegyzés"
                        className="mt-2 w-full rounded-lg border border-ink/15 bg-transparent px-3 py-1.5 text-sm"
                      />
                    )}
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => s.ticketId && doTransition(s.ticketId, 'approved', true)}
                        disabled={pending || !s.ticketId}
                        className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                      >
                        Jóváhagyás
                      </button>
                      <button
                        onClick={() => s.ticketId && doTransition(s.ticketId, 'rejected', false)}
                        disabled={pending || !s.ticketId}
                        className="rounded-lg border border-ink/20 px-3 py-1.5 text-sm disabled:opacity-50"
                      >
                        Elutasítás
                      </button>
                    </div>
                  </div>
                )}
              </li>
            )
          })}
          {data.steps.length === 0 && <li className="text-sm text-ink-soft">Még nincs lépés.</li>}
        </ol>
      </section>

      {/* Delegacios élek */}
      <section className="atelier-card p-5">
        <h2 className="mb-4 font-display text-lg font-semibold">Delegáció</h2>
        <ul className="space-y-2 text-sm">
          {data.delegations.map((d) => {
            const deviates = !intendedEdges.has(`${d.fromStepId}→${d.toStepId}`)
            return (
              <li key={d.id} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">
                  {d.fromStepId} ({d.fromActorType}) → {d.toStepId} ({d.toActorType})
                </span>
                <Pill tone={d.status === 'done' ? 'bg-sage/15 text-sage' : 'bg-sky-500/15 text-sky-300'}>
                  {d.status}
                </Pill>
                {deviates && <Pill tone="bg-coral/15 text-coral">eltérés a Playbooktól</Pill>}
              </li>
            )
          })}
          {data.delegations.length === 0 && <li className="text-ink-soft">Még nincs átadás.</li>}
        </ul>
      </section>

      {/* Szándékolt vs. tényleges flow (§9.2) */}
      {data.intended && (
        <section className="atelier-card p-5">
          <h2 className="mb-4 font-display text-lg font-semibold">Szándékolt vs. tényleges</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">
                Szándékolt (Playbook)
              </p>
              <ol className="space-y-1 text-sm">
                {data.intended.steps.map((st) => (
                  <li key={st.stepId} className="font-mono text-xs">
                    {st.stepId === data.intended!.entryStepId ? '▶ ' : '· '}
                    {st.stepId} <span className="text-ink-soft">({st.assignedRole})</span>
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">
                Tényleges (audit/step)
              </p>
              <ol className="space-y-1 text-sm">
                {data.steps.map((s) => (
                  <li key={s.id} className="font-mono text-xs">
                    {s.stepId}{' '}
                    <span className="text-ink-soft">
                      ({s.status})
                    </span>
                  </li>
                ))}
                {data.steps.length === 0 && <li className="text-ink-soft">—</li>}
              </ol>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
