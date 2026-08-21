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
import { Card } from '@/components/ui/shell'
import {
  PRIVACY_ACTION_LABELS,
  PRIVACY_CATEGORY_LABELS,
  PRIVACY_DRY_RUN_INTRO,
  PRIVACY_DRY_RUN_NO_HITS,
  PRIVACY_GLOSSARY,
  PRIVACY_INHERIT_EXPLANATION,
  PRIVACY_INHERIT_LABEL,
  PRIVACY_LAYER_LABELS,
  PRIVACY_LEGACY_TOGGLE_WARNING,
  PRIVACY_MODE_LABELS,
  PRIVACY_PAN_IBAN_CONFIRM_HINT,
  PRIVACY_SOURCE_LABELS,
  SENSITIVITY_LAYER_INTRO,
  SENSITIVITY_MODE_LABELS,
  inheritedFromLabel,
} from '@/domain/privacy/privacy-admin-copy'
import {
  buildPrivacyPolicyEditorRows,
  categorySupportsTokenize,
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

function canEditLayer(view: PrivacyAdminView, layer: PrivacyEditorLayer): boolean {
  if (layer === 'platform') return view.canEditPlatform
  if (layer === 'tenant') return view.canEditTenant
  return view.canEditAgent
}

function selectClassName() {
  return 'rounded-lg border border-line bg-night-2 px-2 py-1.5 text-sm text-ink'
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

  const modeHelp = PRIVACY_MODE_LABELS[view.resolvedMode]
  const sensitivityHelp = SENSITIVITY_MODE_LABELS[view.resolvedSensitivityMode]
  const tokenizeRows = rows.filter((row) => !isSensitivityScannerCategory(row.category))
  const scannerRows = rows.filter((row) => isSensitivityScannerCategory(row.category))

  return (
    <div className="space-y-6">
      <Card title="Álnevek — mit cserélünk a modell előtt">
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-ink-soft">
            Cégnév, személy, e-mail, telefon, ügyfélazonosító: álnévre cserélhető, ha a
            forrásrendszer megjelöli, vagy a begépelt szövegben felismerhető. Ez a réteg
            nem foglalkozik TAJ-jal, adószámmal, kártyával — arra a lenti mintaszűrő való.
          </p>

          <div className="rounded-lg border border-line bg-night-2 px-3 py-3">
            <p className="text-sm font-medium text-ink">
              Most: {modeHelp.label}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-ink-faint">{modeHelp.explanation}</p>
            <p className="mt-2 text-xs text-ink-faint">
              A védelem erősségénél a platform, a szervezet és az AI-munkatárs közül a
              szigorúbb érvényesül. A kikapcsolás nem oldja fel a fölötte lévő védelmet.
            </p>
          </div>

          {view.legacyAllowSensitiveExternalModel && layer === 'agent' ? (
            <p className="rounded-lg border border-honey/40 bg-honey/10 px-3 py-2 text-xs leading-relaxed text-honey">
              {PRIVACY_LEGACY_TOGGLE_WARNING}
            </p>
          ) : null}

          {visibleLayers.length > 1 ? (
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
          ) : null}

          <div className="grid gap-3 sm:grid-cols-3">
            {visibleLayers.includes('platform') ? (
              <ModeSelect
                label="Platform"
                value={view.platformMode}
                allowInherit={false}
                disabled={!view.canEditPlatform || pending}
                onChange={(value) => saveMode('platform', value)}
              />
            ) : null}
            {visibleLayers.includes('tenant') ? (
              <ModeSelect
                label="Szervezet"
                value={view.tenantMode ?? INHERIT}
                allowInherit
                disabled={!view.canEditTenant || pending}
                onChange={(value) => saveMode('tenant', value)}
              />
            ) : null}
            {visibleLayers.includes('agent') ? (
              <ModeSelect
                label="Ez az AI-munkatárs"
                value={view.agentMode ?? INHERIT}
                allowInherit
                disabled={!view.canEditAgent || pending}
                onChange={(value) => saveMode('agent', value)}
              />
            ) : null}
          </div>
        </div>
      </Card>

      <Card title="Mintaszűrő — TAJ, adószám, kártya, titok">
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-ink-soft">{SENSITIVITY_LAYER_INTRO}</p>

          <div className="rounded-lg border border-line bg-night-2 px-3 py-3">
            <p className="text-sm font-medium text-ink">Most: {sensitivityHelp.label}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-faint">{sensitivityHelp.explanation}</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {visibleLayers.includes('platform') ? (
              <ModeSelect
                label="Platform"
                value={view.platformSensitivityMode}
                allowInherit={false}
                disabled={!view.canEditPlatform || pending}
                onChange={(value) => saveSensitivityMode('platform', value)}
              />
            ) : null}
            {visibleLayers.includes('tenant') ? (
              <ModeSelect
                label="Szervezet"
                value={view.tenantSensitivityMode ?? INHERIT}
                allowInherit
                disabled={!view.canEditTenant || pending}
                onChange={(value) => saveSensitivityMode('tenant', value)}
              />
            ) : null}
            {visibleLayers.includes('agent') ? (
              <ModeSelect
                label="Ez az AI-munkatárs"
                value={view.agentSensitivityMode ?? INHERIT}
                allowInherit
                disabled={!view.canEditAgent || pending}
                onChange={(value) => saveSensitivityMode('agent', value)}
              />
            ) : null}
          </div>
        </div>
      </Card>

      <Card title="Forrásrendszerek, amik megmondják a védendő adatot">
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
      </Card>

      <Card title={`Álnév-szabályok — ${PRIVACY_LAYER_LABELS[layer]}`}>
        <p className="mb-4 text-xs leading-relaxed text-ink-faint">
          {PRIVACY_INHERIT_EXPLANATION} A „itt felülírva” jelzés azt mutatja, hogy ezen a
          szinten külön szabály van. Ezekre az adatfajtákra választható az álnév.
        </p>
        <CategoryPolicyTable
          rows={tokenizeRows}
          editable={editable}
          pending={pending}
          isSuperadmin={view.isSuperadmin}
          onSave={saveCategory}
        />

        {editable ? (
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <label className="block text-xs text-ink-faint">
              Saját minta azonosítója
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
              Hozzáadás álnévre cserével
            </button>
          </div>
        ) : (
          <p className="mt-3 text-xs text-ink-faint">A szabályokat csak admin módosíthatja.</p>
        )}
      </Card>

      <Card title={`Mintaszűrő-szabályok — ${PRIVACY_LAYER_LABELS[layer]}`}>
        <p className="mb-4 text-xs leading-relaxed text-ink-faint">
          TAJ, adószám, kártya, IBAN, titok: nincs álnév. A fenti mintaszűrő üzemmód
          dönti el, hogy a szabály érvényesül-e, vagy csak feljegyzés / ki van kapcsolva.
        </p>
        <CategoryPolicyTable
          rows={scannerRows}
          editable={editable}
          pending={pending}
          isSuperadmin={view.isSuperadmin}
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

      <PrivacyObservabilityPanel
        chain={observabilityChain}
        showAdminDetails={view.canEditPlatform || view.canEditTenant || view.canEditAgent}
      />

      <Card title="Rövid magyarázatok">
        <dl className="space-y-3">
          {PRIVACY_GLOSSARY.map((term) => (
            <div key={term.id}>
              <dt className="text-sm font-medium text-ink">{term.term}</dt>
              <dd className="mt-0.5 text-xs leading-relaxed text-ink-faint">{term.explanation}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {message ? (
        <p
          className={`text-sm ${message.tone === 'ok' ? 'text-sage' : 'text-coral'}`}
        >
          {message.text}
        </p>
      ) : null}
      {pending ? <p className="text-xs text-ink-faint">Mentés…</p> : null}
    </div>
  )
}

function CategoryPolicyTable({
  rows,
  editable,
  pending,
  isSuperadmin,
  onSave,
}: {
  rows: PrivacyPolicyEditorRow[]
  editable: boolean
  pending: boolean
  isSuperadmin: boolean
  onSave: (category: string, action: PrivacyCategoryAction | typeof INHERIT, kind: 'builtin' | 'custom') => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-sm">
        <thead>
          <tr className="border-b border-line/50 text-left text-xs text-ink-faint">
            <th className="py-2 pr-3 font-medium">Adatfajta</th>
            <th className="py-2 pr-3 font-medium">Mi történik</th>
            <th className="py-2 font-medium">Honnan jön</th>
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
                    <option value={INHERIT}>{PRIVACY_INHERIT_LABEL}</option>
                    {ACTIONS.filter((action) => {
                      if (lockedSecret) return action === 'block'
                      if (action === 'tokenize' && !categorySupportsTokenize(row.category)) {
                        return false
                      }
                      if (
                        (row.category === 'pan' || row.category === 'iban') &&
                        action === 'allow' &&
                        !isSuperadmin
                      ) {
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
                  <p className="text-xs text-ink-soft">
                    {row.inherited
                      ? inheritedFromLabel(row.source)
                      : `itt felülírva · érvényes: ${PRIVACY_SOURCE_LABELS[row.source]}`}
                  </p>
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
  allowInherit,
  disabled,
  onChange,
}: {
  label: string
  value: PrivacyGatewayMode | typeof INHERIT
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
        <option value="observe">{PRIVACY_MODE_LABELS.observe.label}</option>
        <option value="enforce">{PRIVACY_MODE_LABELS.enforce.label}</option>
        <option value="off">{PRIVACY_MODE_LABELS.off.label}</option>
      </select>
    </label>
  )
}
