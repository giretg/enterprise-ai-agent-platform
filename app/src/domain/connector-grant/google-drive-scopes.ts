import type { Prisma } from '@prisma/client'

/** Google Drive OAuth scope-ok — issue #378 §5.1 */
export const DRIVE_SCOPES = {
  readonly: 'https://www.googleapis.com/auth/drive.readonly',
  file: 'https://www.googleapis.com/auth/drive.file',
  full: 'https://www.googleapis.com/auth/drive',
  metadataReadonly: 'https://www.googleapis.com/auth/drive.metadata.readonly',
  openid: 'openid',
  email: 'https://www.googleapis.com/auth/userinfo.email',
} as const

const ABBREVIATED_SCOPES: Record<string, string> = {
  'drive.readonly': DRIVE_SCOPES.readonly,
  'drive.file': DRIVE_SCOPES.file,
  drive: DRIVE_SCOPES.full,
  'drive.metadata.readonly': DRIVE_SCOPES.metadataReadonly,
}

export type DriveTool =
  | 'google_drive_search'
  | 'google_drive_get_file'
  | 'google_drive_read_file'
  | 'google_drive_list_drives'
  | 'google_drive_create_folder'
  | 'google_drive_upload_file'
  | 'google_drive_update_file'
  | 'google_drive_rename_file'
  | 'google_drive_move_file'
  | 'google_drive_copy_file'
  | 'google_drive_trash_file'
  | 'google_drive_restore_file'
  | 'google_drive_share_file'
  | 'google_docs_apply_edits'
  | 'google_sheets_write_range'
  | 'google_slides_apply_edits'

export type DriveScopeProfile = 'readonly' | 'selected_write' | 'full_write'

export function normalizeDriveScope(scope: string): string {
  const trimmed = scope.trim()
  return ABBREVIATED_SCOPES[trimmed] ?? trimmed
}

export function parseDriveScopes(scopes: Prisma.JsonValue | string[] | null | undefined): string[] {
  if (!Array.isArray(scopes)) return []
  return (scopes as unknown[])
    .filter((scope): scope is string => typeof scope === 'string')
    .map(normalizeDriveScope)
}

function hasAnyScope(grantedScopes: string[], requiredScopes: string[]): boolean {
  const granted = new Set(grantedScopes.map(normalizeDriveScope))
  return requiredScopes.some((scope) => granted.has(scope))
}

function hasFullDriveWrite(scopes: string[]): boolean {
  return hasAnyScope(scopes, [DRIVE_SCOPES.full])
}

function hasSelectedWrite(scopes: string[]): boolean {
  return hasAnyScope(scopes, [DRIVE_SCOPES.file])
}

function hasReadAccess(scopes: string[]): boolean {
  return hasAnyScope(scopes, [DRIVE_SCOPES.readonly, DRIVE_SCOPES.full])
}

const READ_TOOLS: readonly DriveTool[] = [
  'google_drive_search',
  'google_drive_get_file',
  'google_drive_read_file',
  'google_drive_list_drives',
]

const WRITE_TOOLS: readonly DriveTool[] = [
  'google_drive_create_folder',
  'google_drive_upload_file',
  'google_drive_update_file',
  'google_drive_rename_file',
  'google_drive_move_file',
  'google_drive_copy_file',
  'google_drive_trash_file',
  'google_drive_restore_file',
  'google_drive_share_file',
  'google_docs_apply_edits',
  'google_sheets_write_range',
  'google_slides_apply_edits',
]

/** Drive-írástool-e (a `WRITE_TOOLS` kanonikus halmaza alapján). */
export function isDriveWriteTool(toolName: string): boolean {
  return (WRITE_TOOLS as readonly string[]).includes(toolName)
}

export function driveToolAllowedByScopes(params: {
  tool: DriveTool
  scopes: Prisma.JsonValue | string[] | null | undefined
}): boolean {
  const scopes = parseDriveScopes(params.scopes)
  if (scopes.length === 0) return false

  if ((READ_TOOLS as readonly string[]).includes(params.tool)) {
    return hasReadAccess(scopes)
  }

  if (!(WRITE_TOOLS as readonly string[]).includes(params.tool)) return false

  // metadata.readonly alone cannot read content or write
  if (!hasReadAccess(scopes) && !hasFullDriveWrite(scopes) && !hasSelectedWrite(scopes)) {
    return false
  }

  return hasFullDriveWrite(scopes) || hasSelectedWrite(scopes)
}

export function driveScopeProfile(scopes: Prisma.JsonValue | string[] | null | undefined): DriveScopeProfile {
  const normalized = parseDriveScopes(scopes)
  if (hasFullDriveWrite(normalized)) return 'full_write'
  if (hasSelectedWrite(normalized)) return 'selected_write'
  return 'readonly'
}

/**
 * Egy toolhoz a LEGKISEBB szükséges scope — az OAuth-kérés ebből épül.
 *
 * FONTOS: itt szándékosan NEM szerepel a teljes `drive` scope. A teljes írás
 * (`full_write`) admin-döntés (l. `DRIVE_SCOPE_PROFILES.adminOnly`), nem pedig
 * egy eszközhöz automatikusan kért jogosultság. Ha ide bekerülne a `full`, akkor
 * a tool-vezérelt „Hozzáférés megadása" folyamat — még egy sima olvasásnál is —
 * a teljes Drive írási jogát kérné el, megkerülve a Picker-alapú, kijelölt-fájlos
 * korlátozást. Ezért olvasáshoz `readonly`, íráshoz `file` (selected_write) a
 * minimum; a teljes írást csak az explicit admin scope-profil kérheti.
 */
export function driveToolMinimalScopes(toolName: string): string[] {
  if ((READ_TOOLS as readonly string[]).includes(toolName)) {
    return [DRIVE_SCOPES.readonly]
  }
  if ((WRITE_TOOLS as readonly string[]).includes(toolName)) {
    // A `selected_write` profil DEFINÍCIÓJA `drive.readonly` + `drive.file`: a
    // `drive.file` önmagában NEM ad teljes Drive-keresést/olvasást, ezért a
    // kereső/olvasó eszközök egy csak-`file` granton elakadnának. Mindkettőt
    // kérjük — de a teljes `drive` scope-ot SOHA (az admin-döntés marad).
    return [DRIVE_SCOPES.readonly, DRIVE_SCOPES.file]
  }
  return []
}

export const DRIVE_SCOPE_PROFILES = [
  {
    id: 'readonly' as const,
    label: 'Csak olvasás',
    description: 'Keresés és olvasás a Google ACL szerint, írás nélkül.',
    scopes: [DRIVE_SCOPES.openid, DRIVE_SCOPES.email, DRIVE_SCOPES.readonly],
  },
  {
    id: 'selected_write' as const,
    label: 'Olvasás + írás kijelölt fájlokon',
    description:
      'Teljes olvasás; írás csak az app által létrehozott vagy Pickerrel kiválasztott fájlokon.',
    scopes: [DRIVE_SCOPES.openid, DRIVE_SCOPES.email, DRIVE_SCOPES.readonly, DRIVE_SCOPES.file],
  },
  {
    id: 'full_write' as const,
    label: 'Teljes olvasás + írás',
    description: 'Minden kezelhető fájl írása — csak admin engedéllyel.',
    scopes: [DRIVE_SCOPES.openid, DRIVE_SCOPES.email, DRIVE_SCOPES.full],
    adminOnly: true,
  },
] as const

/**
 * Admin-jogot igényel-e a kért scope-készlet által feloldott profil.
 *
 * Ugyanabból a `DRIVE_SCOPE_PROFILES.adminOnly` metaadatból dolgozik, amit a UI
 * a profil-választó elrejtéséhez használ — így a kliensoldali „elrejtés" és a
 * szerveroldali kapu egyazon forrás-igazságra épül, nem tud szétcsúszni.
 */
export function driveScopeProfileRequiresAdmin(
  scopes: Prisma.JsonValue | string[] | null | undefined,
): boolean {
  const profileId = driveScopeProfile(scopes)
  const profile = DRIVE_SCOPE_PROFILES.find((entry) => entry.id === profileId)
  return Boolean(profile && 'adminOnly' in profile && profile.adminOnly)
}
