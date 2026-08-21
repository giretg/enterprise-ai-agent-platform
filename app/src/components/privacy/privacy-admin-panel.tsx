'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState, useTransition } from 'react'
import {
  dryRunPrivacyText,
  getPrivacyAdminView,
  previewPrivacyObservability,
  setPrivacyCategoryPolicyAction,
  setPrivacyGatewayModeAction,
  setSensitivityLayerModeAction,
  type PrivacyAdminView,
} from '@/app/actions/privacy'
import { PrivacyObservabilityPanel } from '@/components/privacy/privacy-observability-panel'
import { Collapsible } from '@/components/ui/collapsible'
import { Badge, Card } from '@/components/ui/shell'
import {
  ALIAS_LAYER_INTRO,
  ALIAS_RULES_INTRO,
  PRIVACY_ACTION_LABELS,
  PRIVACY_CATEGORY_LABELS,
  PRIVACY_DRY_RUN_INTRO,
  PRIVACY_DRY_RUN_NO_HITS,
  PRIVACY_GLOSSARY,
  PRIVACY_INHERIT_EXPLANATION,
  PRIVACY_INHERIT_LABEL,
  PRIVACY_LAYER_LABELS,
  PRIVACY_LAYER_TABS_LABEL,
  PRIVACY_LEGACY_TOGGLE_WARNING,
  PRIVACY_MODE_CONTROL_LABEL,
  PRIVACY_MODE_LABELS,
  PRIVACY_MODE_PLATFORM_RETIRED,
  PRIVACY_PAGE_INTRO,
  PRIVACY_PAN_IBAN_CONFIRM_HINT,
  PRIVACY_RULES_HEADING,
  PRIVACY_SOURCE_LABELS,
  SCANNER_RULES_INTRO,
  SENSITIVITY_LAYER_INTRO,
  SENSITIVITY_MODE_LABELS,
  inheritedFromLabel,
} from '@/domain/privacy/privacy-admin-copy'
import {
  buildPrivacyPolicyEditorRows,
  categoryAllowsAliasTokenizeAction,
  isAliasPolicyEditorCategory,
  isSensitivityScannerCategory,
  type PrivacyCategoryAction,
  type PrivacyEditorLayer,
  type PrivacyPolicyEditorRow,
} from '@/domain/privacy/privacy-category-policy'
import type { PrivacyGatewayMode } from '@/domain/privacy/privacy-mode'
import type { PrivacyDryRunResult } from '@/domain/privacy/privacy-dry-run'
import type { PrivacyTurnChain } from '@/domain/privacy/privacy-observability'

const INHERIT = '__inherit__'
const ACTIONS: PrivacyCategoryAction[] = ['tokenize', 'local_only', 'block', 'allow']
const AGENT_LAYERS: PrivacyEditorLayer[] = ['agent']
const SYSTEM_LAYERS: PrivacyEditorLayer[] = ['tenant']
const MODE_LAYERS: PrivacyEditorLayer[] = ['tenant', 'agent']

type ModeCopy = Record<PrivacyGatewayMode, { label: string; explanation: string }>

function canEditLayer(view: PrivacyAdminView, layer: PrivacyEditorLayer): boolean {
  if (layer === 'platform') return view.canEditPlatform
  if (layer === 'tenant') return view.canEditTenant
  return view.canEditAgent
}

function selectClassName() {
  return 'rounded-lg border border-line bg-night-2 px-2 py-1.5 text-sm text-ink'
}

function modeValue(
  view: PrivacyAdminView,
  layer: PrivacyEditorLayer,
  kind: 'alias' | 'scanner',
): PrivacyGatewayMode | typeof INHERIT {
  if (kind === 'alias') {
    if (layer === 'platform') return view.platformMode
    if (layer === 'tenant') return view.tenantMode ?? INHERIT
    return view.agentMode ?? INHERIT
  }
  if (layer === 'platform') return view.platformSensitivityMode
  if (layer === 'tenant') return view.tenantSensitivityMode ?? INHERIT
  return view.agentSensitivityMode ?? INHERIT
}

function statusBoxClass(mode: PrivacyGatewayMode) {
  if (mode === 'off') return 'border-coral/35 bg-coral/10'
  if (mode === 'observe') return 'border-honey/35 bg-honey/10'
  return 'border-sage/35 bg-sage/10'
}

export function PrivacyAdminPanel({
  initial,
  agentId,
  layers,
}: {
  initial?: PrivacyAdminView
  agentId?: string
  layers?: PrivacyEditorLayer[]
}) {
  const visibleLayers = layers ?? (agentId ? AGENT_LAYERS : SYSTEM_LAYERS)
  const modeLayers = visibleLayers.filter((item): item is 'tenant' | 'agent' =>
    MODE_LAYERS.includes(item),
  )
  const [view, setView] = useState<PrivacyAdminView | null>(initial ?? null)
  const [layer, setLayer] = useState<PrivacyEditorLayer>(
    initial?.layer ?? (agentId ? 'agent' : 'tenant'),
  )
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [confirmCategory, setConfirmCategory] = useState<string | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [customSlug, setCustomSlug] = useState('')
  const [dryText, setDryText] = useState('')
  const [dryResult, setDryResult] = useState<PrivacyDryRunResult | null>(null)
  const [observabilityChain, setObservabilityChain] = useState<PrivacyTurnChain | null>(null)
  const [hasServerInitial] = useState(() => Boolean(initial))

  useEffect(() => {
    if (hasServerInitial) return
    let cancelled = false
    void (async () => {
      const res = await getPrivacyAdminView({ agentId, layer: agentId ? 'agent' : 'tenant' })
      if (cancelled) return
      if (res.success) {
        setView(res.data)
        setLayer(res.data.layer)
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [agentId, hasServerInitial])

  const rows = useMemo(() => {
    if (!view) return []
    return buildPrivacyPolicyEditorRows({
      platform: view.platformPolicy,
      tenant: view.tenantPolicy,
      agent: view.agentPolicy,
      legacyAllowSensitiveExternalModel: view.legacyAllowSensitiveExternalModel,
      editingLayer: layer,
    })
  }, [view, layer])

  if (!view) {
    return (
      <Card title="Álnevek és mintaszűrő">
        <p className="text-sm text-ink-faint">{message?.text ?? 'Betöltés…'}</p>
      </Card>
    )
  }

  const editable = canEditLayer(view, layer)

  function applyView(next: PrivacyAdminView) {
    setView(next)
    setConfirmCategory(null)
    setConfirmText('')
  }

  function saveCategory(category: string, action: PrivacyCategoryAction | typeof INHERIT, kind: 'builtin' | 'custom') {
    setMessage(null)
    if (action === 'allow' && (category === 'pan' || category === 'iban')) {
      setConfirmCategory(category)
      return
    }
    startTransition(async () => {
      const value = action === INHERIT ? null : action
      const res = await setPrivacyCategoryPolicyAction({
        layer,
        agentId: view!.agentId ?? agentId,
        categories: kind === 'builtin' ? { [category]: value } : undefined,
        custom: kind === 'custom' ? { [category]: value } : undefined,
      })
      if (res.success) {
        applyView(res.data)
        setMessage({ tone: 'ok', text: 'Szabály mentve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  function saveConfirmedAllow() {
    if (!confirmCategory) return
    startTransition(async () => {
      const res = await setPrivacyCategoryPolicyAction({
        layer,
        agentId: view!.agentId ?? agentId,
        categories: { [confirmCategory]: 'allow' },
        confirmation: confirmText.trim(),
      })
      if (res.success) {
        applyView(res.data)
        setMessage({ tone: 'ok', text: 'Szabály mentve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  function saveMode(target: PrivacyEditorLayer, mode: PrivacyGatewayMode | typeof INHERIT) {
    setMessage(null)
    startTransition(async () => {
      const res = await setPrivacyGatewayModeAction({
        layer: target,
        agentId: view!.agentId ?? agentId,
        mode: mode === INHERIT ? null : mode,
      })
      if (res.success) {
        applyView(res.data)
        setMessage({ tone: 'ok', text: 'Üzemmód mentve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  function saveSensitivityMode(target: PrivacyEditorLayer, mode: PrivacyGatewayMode | typeof INHERIT) {
    setMessage(null)
    startTransition(async () => {
      const res = await setSensitivityLayerModeAction({
        layer: target,
        agentId: view!.agentId ?? agentId,
        mode: mode === INHERIT ? null : mode,
      })
      if (res.success) {
        applyView(res.data)
        setMessage({ tone: 'ok', text: 'Mintaszűrő üzemmód mentve.' })
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  function addCustom() {
    const slug = customSlug.trim().toLowerCase()
    if (!slug) return
    saveCategory(slug, 'tokenize', 'custom')
    setCustomSlug('')
  }

  function runDry() {
    setMessage(null)
    setDryResult(null)
    setObservabilityChain(null)
    startTransition(async () => {
      const res = await dryRunPrivacyText({
        text: dryText,
        agentId: view!.agentId ?? agentId,
      })
      if (res.success) {
        setDryResult(res.data)
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  function runObservabilityPreview() {
    setMessage(null)
    setObservabilityChain(null)
    startTransition(async () => {
      const res = await previewPrivacyObservability({
        text: dryText,
        agentId: view!.agentId ?? agentId,
      })
      if (res.success) {
        setObservabilityChain(res.data)
      } else {
        setMessage({ tone: 'err', text: res.error })
      }
    })
  }

  const aliasPolicyRows = rows.filter((row) => isAliasPolicyEditorCategory(row.category))
  const scannerRows = rows.filter((row) => isSensitivityScannerCategory(row.category))
  const singleModeLayer = modeLayers.length === 1

  return (
    <div className="space-y-6">
      <p className="text-sm leading-relaxed text-ink-soft">{PRIVACY_PAGE_INTRO}</p>

      {visibleLayers.length > 1 ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-ink-faint">{PRIVACY_LAYER_TABS_LABEL}</p>
          <div className="flex flex-wrap gap-2">
            {visibleLayers.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setLayer(item)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                  layer === item
                    ? 'bg-coral/15 text-coral-deep'
                    : 'border border-line text-ink-soft hover:bg-night-2'
                }`}
              >
                {PRIVACY_LAYER_LABELS[item]}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <Card title="Álnevek — forrásból és szabad szöveg">
        <div className="space-y-5">
          <p className="text-sm leading-relaxed text-ink-soft">{ALIAS_LAYER_INTRO}</p>

          {view.legacyAllowSensitiveExternalModel && layer === 'agent' ? (
            <p className="rounded-lg border border-honey/40 bg-honey/10 px-3 py-2 text-xs leading-relaxed text-honey">
              {PRIVACY_LEGACY_TOGGLE_WARNING}
            </p>
          ) : null}

          <ModeControl
            resolved={view.resolvedMode}
            labels={PRIVACY_MODE_LABELS}
            layers={modeLayers}
            singleLayer={singleModeLayer}
            view={view}
            kind="alias"
            pending={pending}
            onChange={saveMode}
          />

          <div className="border-t border-line/60 pt-4">
            <h3 className="font-display text-base font-semibold tracking-tight text-ink">
              {PRIVACY_RULES_HEADING}
              {visibleLayers.length > 1 ? (
                <span className="ml-2 text-sm font-medium text-ink-faint">
                  · {PRIVACY_LAYER_LABELS[layer]}
                </span>
              ) : null}
            </h3>
            <p className="mt-1 mb-4 text-xs leading-relaxed text-ink-faint">
              {ALIAS_RULES_INTRO} {PRIVACY_INHERIT_EXPLANATION}
            </p>
            <CategoryPolicyTable
              rows={aliasPolicyRows}
              editable={editable}
              pending={pending}
              onSave={saveCategory}
            />

            {editable ? (
              <div className="mt-4 flex flex-wrap items-end gap-2">
                <label className="block text-xs text-ink-faint">
                  Saját minta — álnévre cseréljük
                  <input
                    value={customSlug}
                    onChange={(event) => setCustomSlug(event.currentTarget.value)}
                    placeholder="pl. employee_id"
                    className="mt-1 block rounded-lg border border-line bg-night-2 px-3 py-1.5 text-sm text-ink"
                  />
                </label>
                <button
                  type="button"
                  disabled={pending || !customSlug.trim()}
                  onClick={addCustom}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-soft hover:bg-night-2 disabled:opacity-40"
                >
                  Hozzáadás
                </button>
              </div>
            ) : (
              <p className="mt-3 text-xs text-ink-faint">A szabályokat csak admin módosíthatja.</p>
            )}
          </div>

          <div className="border-t border-line/60 pt-4">
            <h3 className="mb-3 font-display text-base font-semibold tracking-tight text-ink">
              Honnan tudja a rendszer a neveket?
            </h3>
            {view.emptyState.kind === 'empty' ? (
              <div className="space-y-3">
                <p className="text-sm font-medium text-ink">{view.emptyState.title}</p>
                <p className="text-sm leading-relaxed text-ink-soft">{view.emptyState.body}</p>
                {view.emptyState.href && view.emptyState.cta ? (
                  <Link
                    href={view.emptyState.href}
                    className="inline-flex rounded-full border border-accent/50 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/10"
                  >
                    {view.emptyState.cta}
                  </Link>
                ) : null}
              </div>
            ) : (
              <ul className="space-y-2 text-sm">
                {view.emptyState.ready.map((row) => (
                  <li key={row.id} className="rounded-lg border border-line bg-night-2 px-3 py-2">
                    {row.name}
                    <span className="ml-2 text-xs text-ink-faint">védendő mezők megjelölve</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Card>

      <Card title="Mintaszűrő — TAJ, kártya, titok">
        <div className="space-y-5">
          <p className="text-sm leading-relaxed text-ink-soft">{SENSITIVITY_LAYER_INTRO}</p>

          <ModeControl
            resolved={view.resolvedSensitivityMode}
            labels={SENSITIVITY_MODE_LABELS}
            layers={modeLayers}
            singleLayer={singleModeLayer}
            view={view}
            kind="scanner"
            pending={pending}
            onChange={saveSensitivityMode}
          />

          <div className="border-t border-line/60 pt-4">
            <h3 className="font-display text-base font-semibold tracking-tight text-ink">
              {PRIVACY_RULES_HEADING}
              {visibleLayers.length > 1 ? (
                <span className="ml-2 text-sm font-medium text-ink-faint">
                  · {PRIVACY_LAYER_LABELS[layer]}
                </span>
              ) : null}
            </h3>
            <p className="mt-1 mb-4 text-xs leading-relaxed text-ink-faint">{SCANNER_RULES_INTRO}</p>
            <CategoryPolicyTable
              rows={scannerRows}
              editable={editable}
              pending={pending}
              onSave={saveCategory}
            />

            {confirmCategory ? (
              <div className="mt-4 space-y-2 rounded-lg border border-coral/35 bg-coral/10 p-3">
                <p className="text-xs leading-relaxed text-ink-soft">{PRIVACY_PAN_IBAN_CONFIRM_HINT}</p>
                <input
                  value={confirmText}
                  onChange={(event) => setConfirmText(event.currentTarget.value)}
                  className="block w-full max-w-sm rounded-lg border border-line bg-night-2 px-3 py-1.5 text-sm"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={saveConfirmedAllow}
                    className="rounded-lg bg-coral/20 px-3 py-1.5 text-sm font-medium text-coral"
                  >
                    Megerősítem
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmCategory(null)
                      setConfirmText('')
                    }}
                    className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-soft"
                  >
                    Mégse
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </Card>

      <Card title="Próba — modellhívás nélkül">
        <p className="mb-3 text-sm leading-relaxed text-ink-soft">{PRIVACY_DRY_RUN_INTRO}</p>
        <textarea
          value={dryText}
          onChange={(event) => setDryText(event.currentTarget.value)}
          rows={5}
          placeholder="Példa: Írj az anna@pelda.hu címre, TAJ: 123-456-789"
          className="w-full rounded-lg border border-line bg-night-2 px-3 py-2 text-sm text-ink"
        />
        <button
          type="button"
          disabled={pending || !dryText.trim()}
          onClick={runDry}
          className="mt-3 rounded-lg border border-accent/50 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/10 disabled:opacity-40"
        >
          {pending ? 'Vizsgálat…' : 'Mit cserélnénk?'}
        </button>
        <button
          type="button"
          disabled={pending || !dryText.trim()}
          onClick={runObservabilityPreview}
          className="mt-3 ml-2 rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink-soft hover:bg-night-2 disabled:opacity-40"
        >
          {pending ? 'Nyomkövetés…' : 'Lánc megtekintése'}
        </button>

        {dryResult ? (
          <div className="mt-4 space-y-3">
            {dryResult.hits.length === 0 ? (
              <p className="text-sm text-ink-soft">{PRIVACY_DRY_RUN_NO_HITS}</p>
            ) : (
              <ul className="space-y-2">
                {dryResult.hits.map((hit, index) => (
                  <li
                    key={`${hit.category}-${index}`}
                    className="rounded-lg border border-line bg-night-2 px-3 py-2 text-sm"
                  >
                    <p className="font-medium text-ink">
                      {hit.categoryLabel}
                      {hit.alias ? <span className="ml-2 font-mono text-accent">{hit.alias}</span> : null}
                    </p>
                    <p className="mt-1 break-all text-xs text-ink-faint">{hit.snippet}</p>
                    <p className="mt-1 text-xs text-ink-soft">{hit.outcome}</p>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-ink-faint">
              Ez a próba nem hívott külső modellt, és nem írt álnév-tárba.
            </p>
          </div>
        ) : null}
      </Card>

      {observabilityChain ? (
        <PrivacyObservabilityPanel
          chain={observabilityChain}
          showAdminDetails={view.canEditPlatform || view.canEditTenant || view.canEditAgent}
        />
      ) : null}

      <Collapsible title="Rövid magyarázatok" subtitle="Álnév, megfigyelés, mintaszűrő — egymondatos jelentések.">
        <dl className="space-y-3">
          {PRIVACY_GLOSSARY.map((term) => (
            <div key={term.id}>
              <dt className="text-sm font-medium text-ink">{term.term}</dt>
              <dd className="mt-0.5 text-xs leading-relaxed text-ink-faint">{term.explanation}</dd>
            </div>
          ))}
        </dl>
      </Collapsible>

      {message ? (
        <p className={`text-sm ${message.tone === 'ok' ? 'text-sage' : 'text-coral'}`}>{message.text}</p>
      ) : null}
      {pending ? <p className="text-xs text-ink-faint">Mentés…</p> : null}
    </div>
  )
}

function ModeControl({
  resolved,
  labels,
  layers,
  singleLayer,
  view,
  kind,
  pending,
  onChange,
}: {
  resolved: PrivacyGatewayMode
  labels: ModeCopy
  layers: Array<'tenant' | 'agent'>
  singleLayer: boolean
  view: PrivacyAdminView
  kind: 'alias' | 'scanner'
  pending: boolean
  onChange: (target: PrivacyEditorLayer, mode: PrivacyGatewayMode | typeof INHERIT) => void
}) {
  const help = labels[resolved]
  return (
    <div className={`space-y-3 rounded-lg border px-3 py-3 ${statusBoxClass(resolved)}`}>
      <div>
        <p className="text-sm font-medium text-ink">Most érvényes: {help.label}</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-faint">{help.explanation}</p>
      </div>

      {layers.length === 0 ? (
        <p className="text-xs leading-relaxed text-ink-faint">{PRIVACY_MODE_PLATFORM_RETIRED}</p>
      ) : (
        <div className={`grid gap-3 ${layers.length > 1 ? 'sm:grid-cols-2' : ''}`}>
          {layers.map((item) => (
            <ModeSelect
              key={`${kind}-${item}`}
              label={singleLayer ? PRIVACY_MODE_CONTROL_LABEL : PRIVACY_LAYER_LABELS[item]}
              value={modeValue(view, item, kind)}
              labels={labels}
              allowInherit
              disabled={
                pending || (item === 'tenant' ? !view.canEditTenant : !view.canEditAgent)
              }
              onChange={(value) => onChange(item, value)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function CategoryPolicyTable({
  rows,
  editable,
  pending,
  onSave,
}: {
  rows: PrivacyPolicyEditorRow[]
  editable: boolean
  pending: boolean
  onSave: (category: string, action: PrivacyCategoryAction | typeof INHERIT, kind: 'builtin' | 'custom') => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-sm">
        <thead>
          <tr className="border-b border-line/50 text-left text-xs text-ink-faint">
            <th className="py-2 pr-3 font-medium">Adatfajta</th>
            <th className="py-2 pr-3 font-medium">Mi történik</th>
            <th className="py-2 font-medium">Szint</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const copy = PRIVACY_CATEGORY_LABELS[row.category] ?? {
              label: row.category,
              explanation: 'Szervezeti, egyedi minta.',
            }
            const lockedSecret = row.category === 'secret_key'
            const current = row.overlayAction ?? INHERIT
            return (
              <tr key={row.category} className="border-b border-line/30 align-top last:border-0">
                <td className="py-3 pr-3">
                  <p className="font-medium text-ink">{copy.label}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-ink-faint">{copy.explanation}</p>
                </td>
                <td className="py-3 pr-3">
                  <select
                    className={selectClassName()}
                    disabled={!editable || pending || lockedSecret}
                    value={lockedSecret ? 'block' : current}
                    onChange={(event) =>
                      onSave(
                        row.category,
                        event.currentTarget.value as PrivacyCategoryAction | typeof INHERIT,
                        row.kind,
                      )
                    }
                  >
                    <option value={INHERIT}>
                      {row.inherited
                        ? `${PRIVACY_INHERIT_LABEL} — ${PRIVACY_ACTION_LABELS[row.resolvedAction].label}`
                        : PRIVACY_INHERIT_LABEL}
                    </option>
                    {ACTIONS.filter((action) => {
                      if (lockedSecret) return action === 'block'
                      if (action === 'tokenize' && !categoryAllowsAliasTokenizeAction(row.category)) {
                        return false
                      }
                      return true
                    }).map((action) => (
                      <option key={action} value={action}>
                        {PRIVACY_ACTION_LABELS[action].label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-ink-faint">
                    {PRIVACY_ACTION_LABELS[row.resolvedAction].explanation}
                  </p>
                </td>
                <td className="py-3">
                  {row.inherited ? (
                    <Badge tone="neutral">{inheritedFromLabel(row.source)}</Badge>
                  ) : (
                    <Badge tone="warning">itt beállítva · {PRIVACY_SOURCE_LABELS[row.source]}</Badge>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ModeSelect({
  label,
  value,
  labels,
  allowInherit,
  disabled,
  onChange,
}: {
  label: string
  value: PrivacyGatewayMode | typeof INHERIT
  labels: ModeCopy
  allowInherit: boolean
  disabled: boolean
  onChange: (value: PrivacyGatewayMode | typeof INHERIT) => void
}) {
  return (
    <label className="block text-xs text-ink-faint">
      {label}
      <select
        className={`mt-1 block w-full ${selectClassName()}`}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value as PrivacyGatewayMode | typeof INHERIT)}
      >
        {allowInherit ? <option value={INHERIT}>{PRIVACY_INHERIT_LABEL}</option> : null}
        <option value="observe">{labels.observe.label}</option>
        <option value="enforce">{labels.enforce.label}</option>
        <option value="off">{labels.off.label}</option>
      </select>
    </label>
  )
}
