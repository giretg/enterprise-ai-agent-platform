/**
 * Sensitivity-router réteg üzemmódja — külön a privacy gateway tokenizálásától.
 *
 * A mintaszűrő (TAJ, adószám, bankkártya, IBAN, titok) a teljes modell-prompton
 * fut, beleértve a tool-válaszokat. Nem a CRM mezőjelölés, és nem álnévcsere.
 *
 * Hierarchia ugyanaz, mint a privacy gatewayé: bármelyik szint lefelé kapcsolhat
 * (OFF < OBSERVE < ENFORCE), egyik sem oldhatja fel a szülő enyhébb tiltását.
 * Platform-alapértelmezés: ENFORCE — a mai fail-closed viselkedés marad, amíg
 * explicit nem kapcsolják megfigyelésre vagy ki.
 */
export const SENSITIVITY_LAYER_MODES = ['off', 'observe', 'enforce'] as const
export type SensitivityLayerMode = (typeof SENSITIVITY_LAYER_MODES)[number]

export const DEFAULT_SENSITIVITY_LAYER_MODE: SensitivityLayerMode = 'enforce'

export const SENSITIVITY_LAYER_CONTROLS_KEY = 'sensitivity.layer.controls'
export const SENSITIVITY_LAYER_TENANT_CONTROLS_KEY = 'sensitivity.layer.tenant_controls'
export const SENSITIVITY_LAYER_AGENT_CONTROLS_KEY = 'sensitivity.layer.agent_controls'
export const SENSITIVITY_LAYER_MODE_SET_ACTION = 'sensitivity.layer.mode.set' as const

const RANK: Record<SensitivityLayerMode, number> = {
  off: 0,
  observe: 1,
  enforce: 2,
}

export function isSensitivityLayerMode(value: unknown): value is SensitivityLayerMode {
  return value === 'off' || value === 'observe' || value === 'enforce'
}

export function parseSensitivityLayerMode(raw: unknown): SensitivityLayerMode | null {
  return isSensitivityLayerMode(raw) ? raw : null
}

export function resolveSensitivityLayerMode(layers: {
  platform?: SensitivityLayerMode | null
  tenant?: SensitivityLayerMode | null
  agent?: SensitivityLayerMode | null
}): SensitivityLayerMode {
  const modes: SensitivityLayerMode[] = [layers.platform ?? DEFAULT_SENSITIVITY_LAYER_MODE]
  if (layers.tenant) modes.push(layers.tenant)
  if (layers.agent) modes.push(layers.agent)
  return modes.reduce((weakest, next) => (RANK[next] < RANK[weakest] ? next : weakest))
}

/** OFF és OBSERVE: a hívás megy. ENFORCE: a mai fail-closed kapu. */
export function sensitivityLayerSkipsEnforcement(
  mode: SensitivityLayerMode | null | undefined,
): boolean {
  return mode === 'off' || mode === 'observe'
}

/** OBSERVE: feljegyezzük, mit tiltott / terelt volna. OFF: csendben ki. */
export function sensitivityLayerAuditsObservation(
  mode: SensitivityLayerMode | null | undefined,
): boolean {
  return mode === 'observe'
}

export type SensitivityModeResolver = (ctx: {
  tenantId: string | null
  agentId: string
}) => Promise<SensitivityLayerMode>
