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

export async function readGoogleDriveGrantMetadata(grantId: string): Promise<GoogleDriveGrantMetadata> {
  const grant = await repositories.connectorGrants.findById(grantId)
  if (!grant) throw new Error('Grant not found')
  return parseGoogleDriveGrantMetadata(grant.metadata)
}

export async function updateGoogleDriveGrantMetadata(
  grantId: string,
  updater: (current: GoogleDriveGrantMetadata) => GoogleDriveGrantMetadata,
): Promise<GoogleDriveGrantMetadata> {
  const grant = await repositories.connectorGrants.findById(grantId)
  if (!grant) throw new Error('Grant not found')
  const next = updater(parseGoogleDriveGrantMetadata(grant.metadata))
  await repositories.connectorGrants.updateMetadata(grantId, toGoogleDriveGrantMetadataJson(next))
  return next
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
