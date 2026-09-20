import { GoogleDriveApiClient } from '@/domain/connector-grant/google-drive-api-client'
import { GoogleWorkspaceApiClient } from '@/domain/connector-grant/google-workspace-api-client'
import {
  GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
  GOOGLE_DRIVE_READ_FILE_TOOL,
  GOOGLE_DRIVE_SEARCH_TOOL,
  GOOGLE_DRIVE_UPLOAD_FILE_TOOL,
  GOOGLE_SHEETS_WRITE_RANGE_TOOL,
  type EnterpriseDriveTool,
} from '../tool-definitions'

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function mimeTypeList(value: unknown): string[] | undefined {
  const raw =
    typeof value === 'string'
      ? value.split(',')
      : Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : []
  const items = raw.map((entry) => entry.trim()).filter(Boolean).slice(0, 10)
  return items.length > 0 ? items : undefined
}

function parseSheetValues(raw: unknown): unknown[][] {
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('google_sheets_write_range values must be a JSON 2D array')
  }
  const rows: unknown[][] = []
  let cells = 0
  for (const row of parsed) {
    if (!Array.isArray(row)) {
      throw new Error('google_sheets_write_range values must be a JSON 2D array')
    }
    cells += row.length
    if (cells > 10_000) throw new Error('google_sheets_write_range exceeds 10000 cells')
    rows.push(row)
  }
  return rows
}

/** Drive tool executor. Write tools run only after GatewayOperation approval. */
export async function executeGoogleDriveTool(
  toolName: EnterpriseDriveTool | string,
  args: Record<string, unknown>,
  accessToken: string,
): Promise<unknown> {
  const drive = new GoogleDriveApiClient(accessToken)
  if (toolName === GOOGLE_DRIVE_SEARCH_TOOL) {
    return drive.search({
      query: optionalString(args.query),
      nameContains: optionalString(args.nameContains),
      mimeTypes: mimeTypeList(args.mimeTypes),
      modifiedAfter: optionalString(args.modifiedAfter),
      driveId: optionalString(args.driveId),
      pageSize: optionalNumber(args.pageSize),
      pageToken: optionalString(args.pageToken),
    })
  }
  if (toolName === GOOGLE_DRIVE_READ_FILE_TOOL) {
    const fileId = optionalString(args.fileId) ?? ''
    return drive.readFile({
      fileId,
      maxBytes: optionalNumber(args.maxBytes),
    })
  }
  if (toolName === GOOGLE_DRIVE_CREATE_FOLDER_TOOL) {
    const name = optionalString(args.name) ?? ''
    return drive.createFolder({
      name,
      parentFolderId: optionalString(args.parentFolderId),
    })
  }
  if (toolName === GOOGLE_DRIVE_UPLOAD_FILE_TOOL) {
    const name = optionalString(args.name) ?? ''
    const textContent = optionalString(args.textContent) ?? ''
    const convert = optionalString(args.convertToGoogleType)
    return drive.uploadFile({
      name,
      textContent,
      mimeType: optionalString(args.mimeType),
      parentFolderId: optionalString(args.parentFolderId),
      convertToGoogleType:
        convert === 'doc' || convert === 'sheet' || convert === 'slides' ? convert : undefined,
    })
  }
  if (toolName === GOOGLE_SHEETS_WRITE_RANGE_TOOL) {
    const sheets = new GoogleWorkspaceApiClient(accessToken)
    const mode = optionalString(args.mode)
    return sheets.writeSheetsRange({
      fileId: optionalString(args.fileId) ?? '',
      range: optionalString(args.range) ?? '',
      values: parseSheetValues(args.values),
      mode: mode === 'append' ? 'append' : 'replace',
    })
  }
  throw new Error(`unsupported drive tool: ${toolName}`)
}
