'use client'

/**
 * Governed Flow Builder — React Flow custom node-ok (WP-2).
 * A node-ok tisztán prezentációs vetületek (D1): a `data.model` a spec-ből derivált CanvasNode.
 * FONTOS: statikus Tailwind osztálynevek (a JIT nem lát dinamikus interpolációt).
 */
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '@/lib/playbook-v2/canvas-mapping'

type NodeModelData = { model: CanvasNode; hasError?: boolean }

function readModel(data: unknown): NodeModelData {
  return data as NodeModelData
}

const HANDLE_CLASS = '!h-2.5 !w-2.5 !border-2 !border-paper !bg-ink/40'

export function StartNode() {
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-sage/60 bg-sage/15 px-3 py-1.5 text-xs font-semibold text-sage shadow-sm">
      <span aria-hidden>▶</span> Start
      <Handle type="source" position={Position.Right} className={`${HANDLE_CLASS} !bg-sage`} />
    </div>
  )
}

export function EndNode() {
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-ink/25 bg-ink/8 px-3 py-1.5 text-xs font-semibold text-ink-soft shadow-sm">
      <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
      <span aria-hidden>⯀</span> Vége
    </div>
  )
}

export function StepNode({ data, selected }: NodeProps) {
  const { model, hasError } = readModel(data)
  const human = model.roleType === 'human_role'
  const shell = human
    ? 'border-honey/45' + (selected ? ' ring-2 ring-honey/60' : '')
    : 'border-accent/45' + (selected ? ' ring-2 ring-accent/60' : '')
  const errRing = hasError ? ' ring-2 ring-coral/70' : ''
  return (
    <div className={`w-[210px] rounded-xl border bg-paper px-3 py-2.5 shadow-sm transition-shadow ${shell}${errRing}`}>
      <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span aria-hidden className="text-sm">{human ? '👤' : '🤖'}</span>
          <span className="text-sm font-semibold leading-tight text-ink">{model.label}</span>
        </div>
        {model.isEntry && (
          <span className="shrink-0 rounded-full bg-sage/20 px-1.5 py-0.5 text-[9px] font-bold text-sage">
            START
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {human ? (
          <span className="rounded-full bg-honey/12 px-1.5 py-0.5 text-[10px] font-medium text-honey">ember</span>
        ) : (
          <span className="rounded-full bg-accent/12 px-1.5 py-0.5 text-[10px] font-medium text-accent">agent</span>
        )}
        {model.roleKey && (
          <span className="max-w-[130px] truncate rounded-full bg-ink/6 px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
            {model.roleKey}
          </span>
        )}
      </div>
      {(model.step?.requiredGateIds?.length ?? 0) > 0 && (
        <p className="mt-1 text-[10px] text-honey">◆ {model.step?.requiredGateIds?.length} kötelező kapu</p>
      )}
      <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />
    </div>
  )
}

export function DecisionNode({ data, selected }: NodeProps) {
  const { model, hasError } = readModel(data)
  const ring = selected ? ' ring-2 ring-grape/60' : ''
  const errRing = hasError ? ' ring-2 ring-coral/70' : ''
  const outcomeCount = model.outcomes.length
  return (
    <div className={`w-[220px] rounded-xl border border-grape/50 bg-grape/8 px-3 py-2.5 shadow-sm${ring}${errRing}`}>
      <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
      <div className="flex items-center gap-1.5">
        <span aria-hidden className="text-grape">◈</span>
        <span className="text-sm font-semibold leading-tight text-ink">{model.label}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <span className="rounded-full bg-grape/15 px-1.5 py-0.5 text-[10px] font-medium text-grape">döntés</span>
        {model.roleKey && (
          <span className="max-w-[130px] truncate rounded-full bg-ink/6 px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
            {model.roleKey}
          </span>
        )}
      </div>
      <p className="mt-1 text-[10px] text-grape">
        {outcomeCount > 0 ? `${outcomeCount} kimeneti ág` : 'nincs ág — kösd be a kimeneteket'}
      </p>
      <Handle type="source" position={Position.Right} className={`${HANDLE_CLASS} !bg-grape`} />
    </div>
  )
}

export function GateNode({ data, selected }: NodeProps) {
  const { model } = readModel(data)
  const crit = model.criticality
  const ring = selected ? ' ring-2 ring-honey/60' : ''
  const blocking = model.gate?.blocking
  return (
    <div className={`w-[170px] rounded-lg border border-honey/60 bg-honey/10 px-3 py-2 shadow-sm${ring}`}>
      <Handle type="target" position={Position.Left} className={`${HANDLE_CLASS} !bg-honey`} />
      <div className="flex items-center gap-1.5">
        <span aria-hidden className="text-honey">◆</span>
        <span className="text-sm font-semibold leading-tight text-ink">{model.label}</span>
      </div>
      <p className="mt-0.5 text-[10px] text-ink-soft">
        {(model.gate?.type ?? 'kapu').replace(/_/g, ' ')}
        {crit ? ` · ${crit}` : ''}
      </p>
      {blocking && <p className="mt-0.5 text-[9px] font-semibold text-coral">blokkoló</p>}
      <Handle type="source" position={Position.Right} className={`${HANDLE_CLASS} !bg-honey`} />
    </div>
  )
}

export const CANVAS_NODE_TYPES = {
  start: StartNode,
  end: EndNode,
  step: StepNode,
  decision: DecisionNode,
  gate: GateNode,
}
