import { GMAIL_SCOPES } from '@/domain/connector-grant/gmail-scopes'
import {
  DRIVE_SCOPE_PROFILES,
  driveScopeProfile,
  parseDriveScopes,
} from '@/domain/connector-grant/google-drive-scopes'

const GMAIL_PROFILES = [
  { id: 'modify', label: 'Olvasás + írás', scopes: [GMAIL_SCOPES.modify] },
  { id: 'readonly', label: 'Csak olvasás', scopes: [GMAIL_SCOPES.readonly] },
  { id: 'compose', label: 'Piszkozat + küldés', scopes: [GMAIL_SCOPES.compose] },
  { id: 'send', label: 'Csak küldés', scopes: [GMAIL_SCOPES.send] },
  { id: 'full', label: 'Teljes Gmail', scopes: [GMAIL_SCOPES.full] },
] as const

function sameScopes(a: readonly string[], b: readonly string[]) {
  const norm = (scopes: readonly string[]) => [...scopes].map((s) => s.trim()).sort()
  const left = norm(a)
  const right = norm(b)
  return left.length === right.length && left.every((scope, index) => scope === right[index])
}

export type ScopeProfileSummary = {
  label: string
  description?: string
}

export function gmailGrantScopeSummary(scopes: unknown): ScopeProfileSummary {
  if (!Array.isArray(scopes)) return { label: 'Ismeretlen profil' }
  const normalized = scopes.filter((s): s is string => typeof s === 'string')
  const match = GMAIL_PROFILES.find((profile) => sameScopes(profile.scopes, normalized))
  return { label: match?.label ?? 'Egyedi Gmail jogosultság' }
}

export function driveGrantScopeSummary(scopes: unknown): ScopeProfileSummary {
  const profileId = driveScopeProfile(parseDriveScopes(scopes as never))
  const match = DRIVE_SCOPE_PROFILES.find((profile) => profile.id === profileId)
  return {
    label: match?.label ?? 'Ismeretlen profil',
    description: match?.description,
  }
}

export function connectorScopeProfileDescription(
  connectorType: string,
  profileId: string,
): string | undefined {
  if (connectorType === 'google_drive') {
    return DRIVE_SCOPE_PROFILES.find((profile) => profile.id === profileId)?.description
  }
  return undefined
}
