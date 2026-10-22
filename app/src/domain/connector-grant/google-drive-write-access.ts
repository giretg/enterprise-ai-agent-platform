import type { Prisma } from '@prisma/client'
import {
  parseGoogleDriveGrantMetadata,
  writableFileIds,
  writableFolderIds,
  type GoogleDriveGrantMetadata,
} from './google-drive-grant-metadata'
import { driveScopeProfile } from './google-drive-scopes'

export class GoogleDriveWriteAccessError extends Error {
  readonly code = 'drive_write_not_allowed' as const

  constructor(message: string) {
    super(message)
    this.name = 'GoogleDriveWriteAccessError'
  }
}

export const DRIVE_PICKER_RESELECT_MESSAGE =
  'Ez a fájl vagy mappa nincs az írható kiválasztások között. Válaszd ki újra a Kapcsolt fiókok oldalon (Google Drive → Írható fájlok kiválasztása).'

type WriteToolArgs = Record<string, unknown>

const WRITE_TOOLS_REQUIRING_FILE = new Set([
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
])

export function requiresSelectedWriteManifestCheck(params: {
  scopes: Prisma.JsonValue | string[] | null | undefined
}): boolean {
  return driveScopeProfile(params.scopes) === 'selected_write'
}

export function assertGoogleDriveWriteAccess(params: {
  tool: string
  args: WriteToolArgs
  scopes: Prisma.JsonValue | string[] | null | undefined
  metadata: Prisma.JsonValue | null | undefined
}): void {
  if (!requiresSelectedWriteManifestCheck({ scopes: params.scopes })) return

  const manifest = parseGoogleDriveGrantMetadata(params.metadata)
  const allowedFiles = writableFileIds(manifest)
  const allowedFolders = writableFolderIds(manifest)

  if (params.tool === 'google_drive_create_folder') {
    // Fail-closed: hiányzó parent → Drive root (My Drive), ami megkerüli a Picker
    // manifesztet. selected_write alatt a szülő kötelező és a kiválasztásban kell lennie.
    assertParentInWritableManifest(params.args.parentFolderId, allowedFolders, allowedFiles)
    return
  }

  if (params.tool === 'google_drive_upload_file') {
    assertParentInWritableManifest(params.args.parentFolderId, allowedFolders, allowedFiles)
    return
  }

  if (params.tool === 'google_drive_move_file') {
    const fileId = readFileId(params.args)
    // Fail-closed: az áthelyezendő forrásfájl azonosítója kötelező; hiányzó/üres
    // id esetén nem „átcsúsztatjuk", hanem elutasítjuk.
    if (!fileId || !allowedFiles.has(fileId)) {
      throw new GoogleDriveWriteAccessError(DRIVE_PICKER_RESELECT_MESSAGE)
    }
    assertParentInWritableManifest(
      params.args.destinationFolderId,
      allowedFolders,
      allowedFiles,
    )
    return
  }

  if (params.tool === 'google_drive_copy_file') {
    // Forrás: Google ACL (olvasás elég). Cél-szülő: kötelező + manifesztben —
    // különben a másolat a forrás mappájába / rootba kerülhet a Pickeren kívül.
    assertParentInWritableManifest(params.args.parentFolderId, allowedFolders, allowedFiles)
    return
  }

  if (WRITE_TOOLS_REQUIRING_FILE.has(params.tool)) {
    // Fail-closed: ezek az eszközök konkrét fájlt módosítanak/osztanak meg; a
    // fájl-azonosító kötelező. Hiányzó/üres id NEM engedhet át (különben pl. a
    // `share_file` a manifeszt-kapu megkerülésével futhatna).
    const fileId = readFileId(params.args)
    if (!fileId || !allowedFiles.has(fileId)) {
      throw new GoogleDriveWriteAccessError(DRIVE_PICKER_RESELECT_MESSAGE)
    }
  }
}

export function createdDriveFilesFromResult(
  tool: string,
  result: unknown,
): Array<{ fileId: string; name: string; mimeType: string }> {
  if (!result || typeof result !== 'object') return []
  const rec = result as Record<string, unknown>
  if (rec.file && typeof rec.file === 'object' && rec.file !== null) {
    const file = rec.file as Record<string, unknown>
    const fileId = typeof file.id === 'string' ? file.id : ''
    if (!fileId) return []
    return [
      {
        fileId,
        name: typeof file.name === 'string' ? file.name : fileId,
        mimeType: typeof file.mimeType === 'string' ? file.mimeType : 'application/octet-stream',
      },
    ]
  }
  if (tool === 'google_drive_rename_file' || tool === 'google_drive_move_file') {
    const fileId = typeof rec.id === 'string' ? rec.id : ''
    if (!fileId) return []
    return [
      {
        fileId,
        name: typeof rec.name === 'string' ? rec.name : fileId,
        mimeType: typeof rec.mimeType === 'string' ? rec.mimeType : 'application/octet-stream',
      },
    ]
  }
  return []
}

function readFileId(args: WriteToolArgs): string {
  const fileId = typeof args.fileId === 'string' ? args.fileId.trim() : ''
  return fileId
}

function assertParentInWritableManifest(
  rawParent: unknown,
  allowedFolders: Set<string>,
  allowedFiles: Set<string>,
): void {
  const parentId = typeof rawParent === 'string' ? rawParent.trim() : ''
  if (!parentId || (!allowedFolders.has(parentId) && !allowedFiles.has(parentId))) {
    throw new GoogleDriveWriteAccessError(DRIVE_PICKER_RESELECT_MESSAGE)
  }
}

export function grantUsesSelectedWriteProfile(
  scopes: Prisma.JsonValue | string[] | null | undefined,
): boolean {
  return driveScopeProfile(scopes) === 'selected_write'
}

export type { GoogleDriveGrantMetadata }
