'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'
import { createEval, runEval } from '@/app/actions/platform'
import { Badge, Card } from '@/components/ui/shell'

type AssertionType = 'contains' | 'not_contains' | 'min_length'

type AgentOption = {
  id: string
  name: string
}

type AssertionDraft = {
  description: string
  type: AssertionType
  value: string
}

type AssertionResult = {
  description?: string
  passed?: boolean
  reason?: string
}

type EvalRunView = {
  id: string
  passed: boolean
  score: number
  trigger: string
  createdAt: string
  details: unknown
}

type EvalView = {
  id: string
  name: string
  status: string
  goldenSet: Array<{ description: string; type: AssertionType; value: string | number }>
  lastRun: EvalRunView | null
}

function blankAssertion(): AssertionDraft {
  return { description: '', type: 'contains', value: '' }
}

function normalizeAssertion(assertion: AssertionDraft) {
  return {
    description: assertion.description.trim(),
    type: assertion.type,
    value:
      assertion.type === 'min_length'
        ? Number.parseInt(assertion.value, 10)
        : assertion.value.trim(),
  }
}

function assertionResults(details: unknown): AssertionResult[] {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return []
  const rawResults = (details as { results?: unknown }).results
  if (!Array.isArray(rawResults)) return []
  return rawResults.filter((item): item is AssertionResult => Boolean(item && typeof item === 'object'))
}

function scoreLabel(score: number): string {
  return `${Math.round(score * 100)}%`
}

export function EvalWorkspace({
  agents,
  evals,
  selectedAgentId,
}: {
  agents: AgentOption[]
  evals: EvalView[]
  selectedAgentId?: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [agentId, setAgentId] = useState(selectedAgentId ?? agents[0]?.id ?? '')
  const [name, setName] = useState('S6 wiki válaszminőség')
  const [assertions, setAssertions] = useState<AssertionDraft[]>([blankAssertion()])
  const [selectedEvalId, setSelectedEvalId] = useState(evals[0]?.id ?? '')
  const [proposedContent, setProposedContent] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [lastManualRun, setLastManualRun] = useState<{ passed: boolean; score: number; details: unknown } | null>(null)

  const selectedEval = useMemo(
    () => evals.find((evalDef) => evalDef.id === selectedEvalId) ?? evals[0],
    [evals, selectedEvalId],
  )

  function routeToAgent(nextAgentId: string) {
    setAgentId(nextAgentId)
    setSelectedEvalId('')
    setMessage(null)
    setLastManualRun(null)
    router.push(`/control-plane/governance/evals?agentId=${nextAgentId}`)
  }

  const canCreate =
    agentId &&
    name.trim() &&
    assertions.every((assertion) => {
      const normalized = normalizeAssertion(assertion)
      return (
        normalized.description &&
        (assertion.type === 'min_length'
          ? Number.isFinite(normalized.value) && Number(normalized.value) > 0
          : String(normalized.value).length > 0)
      )
    })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-ink-soft">
          Agent:
          <select
            value={agentId}
            onChange={(event) => routeToAgent(event.target.value)}
            className="ml-2 rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Golden set létrehozása">
          <div className="space-y-4">
            <label className="block text-sm text-ink-soft">
              Név
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
              />
            </label>

            <div className="space-y-3">
              {assertions.map((assertion, index) => (
                <div key={index} className="atelier-soft space-y-3 p-3">
                  <div className="grid gap-3 md:grid-cols-[1fr_160px]">
                    <label className="block text-sm text-ink-soft">
                      Ellenőrzés
                      <input
                        value={assertion.description}
                        onChange={(event) => {
                          const next = [...assertions]
                          next[index] = { ...assertion, description: event.target.value }
                          setAssertions(next)
                        }}
                        placeholder="A válasz említi a hivatalos modellutat"
                        className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
                      />
                    </label>
                    <label className="block text-sm text-ink-soft">
                      Típus
                      <select
                        value={assertion.type}
                        onChange={(event) => {
                          const next = [...assertions]
                          next[index] = {
                            ...assertion,
                            type: event.target.value as AssertionType,
                            value: '',
                          }
                          setAssertions(next)
                        }}
                        className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
                      >
                        <option value="contains">Tartalmazza</option>
                        <option value="not_contains">Nem tartalmazza</option>
                        <option value="min_length">Minimum hossz</option>
                      </select>
                    </label>
                  </div>
                  <div className="flex gap-3">
                    <input
                      value={assertion.value}
                      type={assertion.type === 'min_length' ? 'number' : 'text'}
                      min={assertion.type === 'min_length' ? 1 : undefined}
                      onChange={(event) => {
                        const next = [...assertions]
                        next[index] = { ...assertion, value: event.target.value }
                        setAssertions(next)
                      }}
                      placeholder={assertion.type === 'min_length' ? '120' : 'chatgpt-oauth'}
                      className="min-w-0 flex-1 rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
                    />
                    <button
                      type="button"
                      disabled={assertions.length === 1}
                      onClick={() => setAssertions(assertions.filter((_, i) => i !== index))}
                      className="rounded-full border border-line px-3 py-2 text-sm text-ink-soft disabled:opacity-40"
                    >
                      Törlés
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setAssertions([...assertions, blankAssertion()])}
                className="rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink-soft"
              >
                Új ellenőrzés
              </button>
              <button
                type="button"
                disabled={pending || !canCreate}
                onClick={() => {
                  startTransition(async () => {
                    const res = await createEval({
                      agentId,
                      name,
                      goldenSet: assertions.map(normalizeAssertion),
                    })
                    if (res.success) {
                      setMessage('Eval létrehozva.')
                      setSelectedEvalId(res.data.id)
                      setAssertions([blankAssertion()])
                      router.refresh()
                    } else {
                      setMessage(res.error)
                    }
                  })
                }}
                className="rounded-full bg-sky/20 px-4 py-2 text-sm font-semibold text-sky disabled:opacity-50"
              >
                Mentés
              </button>
            </div>
          </div>
        </Card>

        <Card title="Kézi futtatás">
          {evals.length === 0 ? (
            <p className="text-sm text-ink-faint">Ehhez az agenthez még nincs eval.</p>
          ) : (
            <div className="space-y-4">
              <label className="block text-sm text-ink-soft">
                Eval
                <select
                  value={selectedEval?.id ?? ''}
                  onChange={(event) => {
                    setSelectedEvalId(event.target.value)
                    setLastManualRun(null)
                  }}
                  className="mt-1 w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
                >
                  {evals.map((evalDef) => (
                    <option key={evalDef.id} value={evalDef.id}>
                      {evalDef.name}
                    </option>
                  ))}
                </select>
              </label>

              <textarea
                value={proposedContent}
                onChange={(event) => setProposedContent(event.target.value)}
                rows={8}
                placeholder="Illeszd be ide az agent válaszát vagy a javasolt memória-tartalmat..."
                className="w-full rounded-lg border border-line bg-night-2 p-3 text-sm text-ink"
              />

              <button
                type="button"
                disabled={pending || !selectedEval || !proposedContent.trim()}
                onClick={() => {
                  if (!selectedEval) return
                  startTransition(async () => {
                    const res = await runEval({
                      evalId: selectedEval.id,
                      agentId,
                      proposedContent,
                    })
                    if (res.success) {
                      setLastManualRun({
                        passed: res.data.passed,
                        score: res.data.score,
                        details: res.data.details,
                      })
                      setMessage('Eval lefutott.')
                      router.refresh()
                    } else {
                      setMessage(res.error)
                    }
                  })
                }}
                className="rounded-full bg-sage/20 px-4 py-2 text-sm font-semibold text-sage disabled:opacity-50"
              >
                Futtatás
              </button>

              {lastManualRun && (
                <div className="atelier-soft p-3 text-sm">
                  <div className="mb-2 flex items-center gap-2">
                    <Badge tone={lastManualRun.passed ? 'success' : 'danger'}>
                      {lastManualRun.passed ? 'Átment' : 'Nem ment át'}
                    </Badge>
                    <span className="font-mono text-xs text-ink-faint">
                      score {scoreLabel(lastManualRun.score)}
                    </span>
                  </div>
                  <ResultList details={lastManualRun.details} />
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      <Card title="Eval készlet">
        {evals.length === 0 ? (
          <p className="text-sm text-ink-faint">Nincs mentett eval ehhez az agenthez.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-ink-faint">
                  <th className="pb-2 pr-4">Név</th>
                  <th className="pb-2 pr-4">Állapot</th>
                  <th className="pb-2 pr-4 text-right">Ellenőrzések</th>
                  <th className="pb-2 pr-4 text-right">Legutóbbi score</th>
                  <th className="pb-2">Legutóbbi részletek</th>
                </tr>
              </thead>
              <tbody>
                {evals.map((evalDef) => (
                  <tr key={evalDef.id} className="border-b border-line/50 align-top">
                    <td className="py-3 pr-4 font-medium">{evalDef.name}</td>
                    <td className="py-3 pr-4">
                      <Badge tone={evalDef.status === 'active' ? 'success' : 'neutral'}>
                        {evalDef.status}
                      </Badge>
                    </td>
                    <td className="py-3 pr-4 text-right font-mono text-xs">
                      {evalDef.goldenSet.length}
                    </td>
                    <td className="py-3 pr-4 text-right font-mono text-xs">
                      {evalDef.lastRun ? scoreLabel(evalDef.lastRun.score) : 'nincs futás'}
                    </td>
                    <td className="py-3">
                      {evalDef.lastRun ? (
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone={evalDef.lastRun.passed ? 'success' : 'danger'}>
                              {evalDef.lastRun.passed ? 'Átment' : 'Nem ment át'}
                            </Badge>
                            <span className="font-mono text-xs text-ink-faint">
                              {new Date(evalDef.lastRun.createdAt).toLocaleString('hu-HU')}
                            </span>
                          </div>
                          <ResultList details={evalDef.lastRun.details} compact />
                        </div>
                      ) : (
                        <span className="text-ink-faint">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {message && <p className="text-sm text-ink-soft">{message}</p>}
    </div>
  )
}

function ResultList({ details, compact = false }: { details: unknown; compact?: boolean }) {
  const results = assertionResults(details)
  if (results.length === 0) {
    return <p className="text-xs text-ink-faint">Nincs assertion-részlet.</p>
  }

  return (
    <ul className={`space-y-1 ${compact ? 'max-h-24 overflow-auto' : ''}`}>
      {results.map((result, index) => (
        <li key={index} className="flex items-start justify-between gap-3 text-xs">
          <span className={result.passed ? 'text-ink-soft' : 'text-coral-deep'}>
            {result.description ?? result.reason ?? `Ellenőrzés ${index + 1}`}
          </span>
          <span className={`shrink-0 font-semibold ${result.passed ? 'text-sage' : 'text-coral-deep'}`}>
            {result.passed ? 'OK' : 'FAIL'}
          </span>
        </li>
      ))}
    </ul>
  )
}
