import type { ReactNode } from 'react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Badge } from '../../shared/components/Badge'
import { Card } from '../../shared/components/Card'
import { useDemo } from '../../shared/context/DemoContext'
import {
  availableModels,
  availablePermissions,
} from '../../shared/mock-data'
import type { CreateAgentInput } from '../../shared/types'

const STEPS = [
  'Alapadatok',
  'Prompt',
  'Erőforrások',
  'Modell',
  'Jogosultság',
] as const

const defaultInput: CreateAgentInput = {
  name: '',
  role: '',
  systemPrompt: '',
  resourceIds: [],
  provider: availableModels[0].provider,
  model: availableModels[0].model,
  temperature: 0.1,
  permissions: ['board.ticket.read'],
}

export function AgentWizardPage() {
  const navigate = useNavigate()
  const { catalogResources, createAgent } = useDemo()
  const [step, setStep] = useState(0)
  const [input, setInput] = useState<CreateAgentInput>(defaultInput)

  const canNext =
    (step === 0 && input.name.trim() && input.role.trim()) ||
    (step === 1 && input.systemPrompt.trim()) ||
    step === 2 ||
    step === 3 ||
    (step === 4 && input.permissions.length > 0)

  const handleCreate = () => {
    const agentId = createAgent(input)
    navigate(`/control-plane/agents/${agentId}`)
  }

  return (
    <div>
      <Link
        to="/control-plane/agents"
        className="mb-4 inline-block text-sm text-slate-400 hover:text-slate-200"
      >
        ← Agent Registry
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-50">
          Új agent létrehozása
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Lépcsős wizard — alapadat → prompt → erőforrások → modell → jogosultság
        </p>
      </div>

      <div className="mb-8 flex gap-2">
        {STEPS.map((label, i) => (
          <div
            key={label}
            className={`flex-1 rounded-lg border px-3 py-2 text-center text-xs ${
              i === step
                ? 'border-sky-600 bg-sky-950/40 text-sky-200'
                : i < step
                  ? 'border-emerald-800/50 bg-emerald-950/20 text-emerald-300'
                  : 'border-slate-700 text-slate-500'
            }`}
          >
            {i + 1}. {label}
          </div>
        ))}
      </div>

      <Card>
        {step === 0 && (
          <div className="space-y-4">
            <Field label="Agent neve">
              <input
                value={input.name}
                onChange={(e) => setInput({ ...input, name: e.target.value })}
                placeholder="pl. Határidő Asszisztens"
                className={inputClass}
              />
            </Field>
            <Field label="Szerep / feladatleírás">
              <textarea
                value={input.role}
                onChange={(e) => setInput({ ...input, role: e.target.value })}
                rows={3}
                placeholder="Mit csinál ez az agent?"
                className={inputClass}
              />
            </Field>
          </div>
        )}

        {step === 1 && (
          <Field label="System prompt (munkaköri leírás)">
            <textarea
              value={input.systemPrompt}
              onChange={(e) =>
                setInput({ ...input, systemPrompt: e.target.value })
              }
              rows={8}
              placeholder="Ki vagy és mi a dolgod…"
              className={`${inputClass} font-mono text-xs`}
            />
          </Field>
        )}

        {step === 2 && (
          <div className="space-y-2">
            <p className="mb-3 text-sm text-slate-400">
              Válaszd ki a katalógusból a hozzárendelendő erőforrásokat
            </p>
            {catalogResources.map((res) => (
              <label
                key={res.id}
                className="flex cursor-pointer items-start gap-3 rounded border border-slate-700/50 p-3 hover:bg-slate-800/40"
              >
                <input
                  type="checkbox"
                  checked={input.resourceIds.includes(res.id)}
                  onChange={(e) => {
                    setInput({
                      ...input,
                      resourceIds: e.target.checked
                        ? [...input.resourceIds, res.id]
                        : input.resourceIds.filter((id) => id !== res.id),
                    })
                  }}
                  className="mt-1"
                />
                <div>
                  <div className="flex flex-wrap gap-2">
                    <span className="text-sm font-medium text-slate-200">
                      {res.name}
                    </span>
                    <Badge variant="mono">{res.type}</Badge>
                    <Badge variant="mono">v{res.version}</Badge>
                  </div>
                  <p className="text-xs text-slate-500">{res.description}</p>
                </div>
              </label>
            ))}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <Field label="Modell (Model Gateway)">
              <select
                value={`${input.provider}|${input.model}`}
                onChange={(e) => {
                  const [provider, model] = e.target.value.split('|')
                  setInput({ ...input, provider, model })
                }}
                className={inputClass}
              >
                {availableModels.map((m) => (
                  <option key={m.model} value={`${m.provider}|${m.model}`}>
                    {m.model} — {m.provider}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`Temperature: ${input.temperature}`}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={input.temperature}
                onChange={(e) =>
                  setInput({
                    ...input,
                    temperature: parseFloat(e.target.value),
                  })
                }
                className="w-full"
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Badge variant="purple">PII-redaction</Badge>
              <Badge variant="purple">output-schema-validation</Badge>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm text-slate-400">Jogosultságok (RBAC)</p>
              {availablePermissions.map((perm) => (
                <label
                  key={perm}
                  className="flex items-center gap-2 text-sm text-slate-300"
                >
                  <input
                    type="checkbox"
                    checked={input.permissions.includes(perm)}
                    onChange={(e) => {
                      setInput({
                        ...input,
                        permissions: e.target.checked
                          ? [...input.permissions, perm]
                          : input.permissions.filter((p) => p !== perm),
                      })
                    }}
                  />
                  <code className="font-mono text-xs">{perm}</code>
                </label>
              ))}
            </div>
            <div className="rounded border border-slate-700/60 bg-slate-900/50 p-4">
              <p className="text-sm font-medium text-slate-200">Összegzés</p>
              <dl className="mt-2 space-y-1 text-xs text-slate-400">
                <div>
                  <strong className="text-slate-300">{input.name}</strong> —{' '}
                  {input.role}
                </div>
                <div>Modell: {input.model}</div>
                <div>Erőforrások: {input.resourceIds.length} db</div>
                <div>Életciklus: Teszt / Eval (paused)</div>
              </dl>
            </div>
          </div>
        )}

        <div className="mt-6 flex justify-between border-t border-slate-700/60 pt-4">
          <button
            type="button"
            disabled={step === 0}
            onClick={() => setStep((s) => s - 1)}
            className="rounded-md border border-slate-600 px-4 py-2 text-sm text-slate-300 disabled:opacity-40"
          >
            ← Vissza
          </button>
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              disabled={!canNext}
              onClick={() => setStep((s) => s + 1)}
              className="rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              Tovább →
            </button>
          ) : (
            <button
              type="button"
              disabled={!canNext}
              onClick={handleCreate}
              className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              Agent létrehozása
            </button>
          )}
        </div>
      </Card>
    </div>
  )
}

const inputClass =
  'w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-200'

function Field({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-slate-400">
        {label}
      </label>
      {children}
    </div>
  )
}
