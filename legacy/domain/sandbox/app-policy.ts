/**
 * A0 app-policy validáció (Feature-spec — App Registry §3.4).
 * Az A0 policy deklaratív, de erősen korlátozott: hálózat / connector /
 * secret / nem-beágyazott adat tilos. Bármely tiltott érték → POLICY_NOT_ALLOWED_FOR_A0.
 */
import { SandboxAppError } from './errors'
import { DEFAULT_MAX_ARTIFACT_SIZE_BYTES } from './html-validator'

export type SandboxAppPolicy = {
  level: 'A0'
  network: 'none'
  connectors: string[]
  secrets: 'none'
  dataAccess: 'embedded_only'
  requiresApprovalToActivate: boolean
  maxArtifactSizeBytes: number
}

export function defaultA0Policy(maxArtifactSizeBytes = DEFAULT_MAX_ARTIFACT_SIZE_BYTES): SandboxAppPolicy {
  return {
    level: 'A0',
    network: 'none',
    connectors: [],
    secrets: 'none',
    dataAccess: 'embedded_only',
    requiresApprovalToActivate: false,
    maxArtifactSizeBytes,
  }
}

/**
 * Egy (részleges) policy-kérést validál és A0-kompatibilis policy-vé normalizál.
 * `tenantMaxBytes` a tenantonként konfigurálható felső plafon (§3.4).
 */
export function validateAndNormalizeA0Policy(
  requested: Record<string, unknown> | undefined,
  tenantMaxBytes = DEFAULT_MAX_ARTIFACT_SIZE_BYTES,
): SandboxAppPolicy {
  const policy = requested ?? {}

  if (policy.level !== undefined && policy.level !== 'A0') {
    throw new SandboxAppError('POLICY_NOT_ALLOWED_FOR_A0', `level must be A0, got ${String(policy.level)}`)
  }
  if (policy.network !== undefined && policy.network !== 'none') {
    throw new SandboxAppError('POLICY_NOT_ALLOWED_FOR_A0', 'network must be "none" for A0')
  }
  if (policy.connectors !== undefined) {
    if (!Array.isArray(policy.connectors) || policy.connectors.length > 0) {
      throw new SandboxAppError('POLICY_NOT_ALLOWED_FOR_A0', 'connectors must be an empty array for A0')
    }
  }
  if (policy.secrets !== undefined && policy.secrets !== 'none') {
    throw new SandboxAppError('POLICY_NOT_ALLOWED_FOR_A0', 'secrets must be "none" for A0')
  }
  if (policy.dataAccess !== undefined && policy.dataAccess !== 'embedded_only') {
    throw new SandboxAppError('POLICY_NOT_ALLOWED_FOR_A0', 'dataAccess must be "embedded_only" for A0')
  }

  let maxArtifactSizeBytes = DEFAULT_MAX_ARTIFACT_SIZE_BYTES
  if (policy.maxArtifactSizeBytes !== undefined) {
    const requestedMax = Number(policy.maxArtifactSizeBytes)
    if (!Number.isFinite(requestedMax) || requestedMax <= 0) {
      throw new SandboxAppError('POLICY_NOT_ALLOWED_FOR_A0', 'maxArtifactSizeBytes must be a positive number')
    }
    if (requestedMax > tenantMaxBytes) {
      throw new SandboxAppError(
        'POLICY_NOT_ALLOWED_FOR_A0',
        `maxArtifactSizeBytes ${requestedMax} exceeds tenant cap ${tenantMaxBytes}`,
      )
    }
    maxArtifactSizeBytes = requestedMax
  }

  return defaultA0Policy(maxArtifactSizeBytes)
}
