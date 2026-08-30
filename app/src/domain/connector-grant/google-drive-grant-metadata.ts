import type { Prisma } from '@prisma/client'

export type GoogleDrivePickerSelection = {
  fileId: string
  name: string
  mimeType: string
  kind: 'file' | 'folder'
  selectedAt: string
}

export type GoogleDriveAppCreatedEntry = {
  fileId: string
  name: string
  mimeType: string
  createdAt: string
}

export type GoogleDriveGrantMetadata = {
  pickerSelections: GoogleDrivePickerSelection[]
  appCreated: GoogleDriveAppCreatedEntry[]
}

const FOLDER_MIME = 'application/vnd.google-apps.folder'

export function emptyGoogleDriveGrantMetadata(): GoogleDriveGrantMetadata {
  return { pickerSelections: [], appCreated: [] }
}

export function parseGoogleDriveGrantMetadata(
  raw: Prisma.JsonValue | null | undefined,
): GoogleDriveGrantMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return emptyGoogleDriveGrantMetadata()
  }
  const rec = raw as Record<string, unknown>
  const pickerSelections = Array.isArray(rec.pickerSelections)
    ? rec.pickerSelections
        .map(parsePickerSelection)
        .filter((entry): entry is GoogleDrivePickerSelection => entry !== null)
    : []
  const appCreated = Array.isArray(rec.appCreated)
    ? rec.appCreated
        .map(parseAppCreatedEntry)
        .filter((entry): entry is GoogleDriveAppCreatedEntry => entry !== null)
    : []
  return { pickerSelections, appCreated }
}

function parsePickerSelection(raw: unknown): GoogleDrivePickerSelection | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  const fileId = typeof rec.fileId === 'string' ? rec.fileId.trim() : ''
  const name = typeof rec.name === 'string' ? rec.name.trim() : ''
  const mimeType = typeof rec.mimeType === 'string' ? rec.mimeType.trim() : ''
  const selectedAt = typeof rec.selectedAt === 'string' ? rec.selectedAt : new Date().toISOString()
  const kind = rec.kind === 'folder' ? 'folder' : rec.kind === 'file' ? 'file' : inferKind(mimeType)
  if (!fileId || !name) return null
  return { fileId, name, mimeType: mimeType || 'application/octet-stream', kind, selectedAt }
}

function parseAppCreatedEntry(raw: unknown): GoogleDriveAppCreatedEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  const fileId = typeof rec.fileId === 'string' ? rec.fileId.trim() : ''
  const name = typeof rec.name === 'string' ? rec.name.trim() : ''
  const mimeType = typeof rec.mimeType === 'string' ? rec.mimeType.trim() : ''
  const createdAt = typeof rec.createdAt === 'string' ? rec.createdAt : new Date().toISOString()
  if (!fileId) return null
  return { fileId, name: name || fileId, mimeType: mimeType || 'application/octet-stream', createdAt }
}

function inferKind(mimeType: string): 'file' | 'folder' {
  return mimeType === FOLDER_MIME ? 'folder' : 'file'
}

export function pickerSelectionKind(mimeType: string): 'file' | 'folder' {
  return inferKind(mimeType)
}

export function mergePickerSelections(
  current: GoogleDriveGrantMetadata,
  incoming: GoogleDrivePickerSelection[],
): GoogleDriveGrantMetadata {
  const byId = new Map(current.pickerSelections.map((entry) => [entry.fileId, entry]))
  for (const entry of incoming) {
    byId.set(entry.fileId, entry)
  }
  return {
    ...current,
    pickerSelections: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'hu')),
  }
}

export function removePickerSelection(
  current: GoogleDriveGrantMetadata,
  fileId: string,
): GoogleDriveGrantMetadata {
  return {
    ...current,
    pickerSelections: current.pickerSelections.filter((entry) => entry.fileId !== fileId),
  }
}

export function trackAppCreatedFile(
  current: GoogleDriveGrantMetadata,
  entry: Omit<GoogleDriveAppCreatedEntry, 'createdAt'> & { createdAt?: string },
): GoogleDriveGrantMetadata {
  const createdAt = entry.createdAt ?? new Date().toISOString()
  const nextEntry: GoogleDriveAppCreatedEntry = {
    fileId: entry.fileId,
    name: entry.name,
    mimeType: entry.mimeType,
    createdAt,
  }
  const without = current.appCreated.filter((item) => item.fileId !== entry.fileId)
  return {
    ...current,
    appCreated: [nextEntry, ...without].slice(0, 500),
  }
}

export function writableFileIds(metadata: GoogleDriveGrantMetadata): Set<string> {
  const ids = new Set<string>()
  for (const entry of metadata.pickerSelections) ids.add(entry.fileId)
  for (const entry of metadata.appCreated) ids.add(entry.fileId)
  return ids
}

export function writableFolderIds(metadata: GoogleDriveGrantMetadata): Set<string> {
  const ids = new Set<string>()
  for (const entry of metadata.pickerSelections) {
    if (entry.kind === 'folder') ids.add(entry.fileId)
  }
  for (const entry of metadata.appCreated) {
    if (entry.mimeType === FOLDER_MIME) ids.add(entry.fileId)
  }
  return ids
}

export function toGoogleDriveGrantMetadataJson(
  metadata: GoogleDriveGrantMetadata,
): Prisma.InputJsonObject {
  return metadata as unknown as Prisma.InputJsonObject
}
