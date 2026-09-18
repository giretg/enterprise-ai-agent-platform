/**
 * Sensitivity-router réteg üzemmódja — külön a privacy gateway tokenizálásától.
 *
 * Tenant default → agent override (issue #320 D9). Platform-szint megszűnt.
 */
export const SENSITIVITY_LAYER_MODES = ['off', 'observe', 'enforce'] as const
export type SensitivityLayerMode = (typeof SENSITIVITY_LAYER_MODES)[number]

export const DEFAULT_SENSITIVITY_LAYER_MODE: SensitivityLayerMode = 'enforce'

/** @deprecated Platform-szint megszűnt (#320). Csak migráció olvassa. */
export const SENSITIVITY_LAYER_CONTROLS_KEY = 'sensitivity.layer.controls'
export const SENSITIVITY_LAYER_TENANT_CONTROLS_KEY = 'sensitivity.layer.tenant_controls'
export const SENSITIVITY_LAYER_AGENT_CONTROLS_KEY = 'sensitivity.layer.agent_controls'
export const SENSITIVITY_LAYER_MODE_SET_ACTION = 'sensitivity.layer.mode.set' as const

export function isSensitivityLayerMode(value: unknown): value is SensitivityLayerMode {
  return value === 'off' || value === 'observe' || value === 'enforce'
}

export function parseSensitivityLayerMode(raw: unknown): SensitivityLayerMode | null {
  return isSensitivityLayerMode(raw) ? raw : null
}

/** Felülírás-lánc: agent → tenant → default (ENFORCE). */
export function resolveSensitivityLayerMode(layers: {
  platform?: SensitivityLayerMode | null
  tenant?: SensitivityLayerMode | null
  agent?: SensitivityLayerMode | null
}): SensitivityLayerMode {
  if (layers.agent) return layers.agent
  if (layers.tenant) return layers.tenant
  if (layers.platform) return layers.platform
  return DEFAULT_SENSITIVITY_LAYER_MODE
}

export function sensitivityLayerSkipsEnforcement(
  mode: SensitivityLayerMode | null | undefined,
): boolean {
  return mode === 'off' || mode === 'observe'
}

export function sensitivityLayerAuditsObservation(
  mode: SensitivityLayerMode | null | undefined,
): boolean {
  return mode === 'observe'
}

export type SensitivityModeResolver = (ctx: {
  tenantId: string | null
  agentId: string
}) => Promise<SensitivityLayerMode>
