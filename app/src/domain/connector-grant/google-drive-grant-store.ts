import type { Prisma } from '@prisma/client'
import { repositories } from '@/repositories/postgres'
import {
  mergePickerSelections,
  parseGoogleDriveGrantMetadata,
  pickerSelectionKind,
  removePickerSelection,
  toGoogleDriveGrantMetadataJson,
  trackAppCreatedFile,
  type GoogleDriveGrantMetadata,
  type GoogleDrivePickerSelection,
} from './google-drive-grant-metadata'

/** Picker remove + appCreated track párhuzamosan is ugyanarra a JSON-ra ír. */
const METADATA_CAS_ATTEMPTS = 8

export async function readGoogleDriveGrantMetadata(grantId: string): Promise<GoogleDriveGrantMetadata> {
  const grant = await repositories.connectorGrants.findById(grantId)
  if (!grant) throw new Error('Grant not found')
  return parseGoogleDriveGrantMetadata(grant.metadata)
}

/**
 * Grant metadata RMW — compare-and-swap a JSON-on.
 *
 * Enélkül a Picker-ből törölt fájl + párhuzamos `recordGoogleDriveAppCreatedFile`
 * (create/copy/rename/move) elveszítheti egymás írását: a visszavont
 * `pickerSelections` visszaáll, vagy egy `appCreated` id kiesik → selected_write
 * jogszivárgás / manifest adatvesztés.
 */
export async function updateGoogleDriveGrantMetadata(
  grantId: string,
  updater: (current: GoogleDriveGrantMetadata) => GoogleDriveGrantMetadata,
): Promise<GoogleDriveGrantMetadata> {
  for (let attempt = 0; attempt < METADATA_CAS_ATTEMPTS; attempt++) {
    const grant = await repositories.connectorGrants.findById(grantId)
    if (!grant) throw new Error('Grant not found')
    const currentMeta = grant.metadata
    const current = parseGoogleDriveGrantMetadata(currentMeta)
    const next = updater(current)
    const nextJson = toGoogleDriveGrantMetadataJson(next)
    const unchanged =
      JSON.stringify(currentMeta ?? null) === JSON.stringify(nextJson ?? null)
    if (unchanged) return next

    const wrote = await repositories.connectorGrants.updateMetadataIfMatch(
      grantId,
      currentMeta as Prisma.InputJsonValue,
      nextJson,
    )
    if (wrote) return next
  }
  throw new Error('Google Drive grant metadata update conflict — retry later')
}

export async function saveGoogleDrivePickerSelections(params: {
  grantId: string
  selections: Array<{ fileId: string; name: string; mimeType: string }>
}): Promise<GoogleDriveGrantMetadata> {
  const now = new Date().toISOString()
  const incoming: GoogleDrivePickerSelection[] = params.selections.map((entry) => ({
    fileId: entry.fileId,
    name: entry.name,
    mimeType: entry.mimeType,
    kind: pickerSelectionKind(entry.mimeType),
    selectedAt: now,
  }))
  return updateGoogleDriveGrantMetadata(params.grantId, (current) =>
    mergePickerSelections(current, incoming),
  )
}

export async function removeGoogleDrivePickerSelection(params: {
  grantId: string
  fileId: string
}): Promise<GoogleDriveGrantMetadata> {
  return updateGoogleDriveGrantMetadata(params.grantId, (current) =>
    removePickerSelection(current, params.fileId),
  )
}

export async function recordGoogleDriveAppCreatedFile(params: {
  grantId: string
  fileId: string
  name: string
  mimeType: string
}): Promise<void> {
  await updateGoogleDriveGrantMetadata(params.grantId, (current) =>
    trackAppCreatedFile(current, {
      fileId: params.fileId,
      name: params.name,
      mimeType: params.mimeType,
    }),
  )
}

export async function writeGoogleDriveGrantMetadata(
  grantId: string,
  metadata: GoogleDriveGrantMetadata,
): Promise<void> {
  await repositories.connectorGrants.updateMetadata(
    grantId,
    toGoogleDriveGrantMetadataJson(metadata),
  )
}
