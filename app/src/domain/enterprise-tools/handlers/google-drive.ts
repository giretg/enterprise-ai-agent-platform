import { GoogleDriveApiClient } from '@/domain/connector-grant/google-drive-api-client'
import {
  GOOGLE_DRIVE_CREATE_FOLDER_TOOL,
  GOOGLE_DRIVE_READ_FILE_TOOL,
  GOOGLE_DRIVE_SEARCH_TOOL,
  type EnterpriseDriveTool,
} from '../tool-definitions'

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((entry): entry is string => typeof entry === 'string')
  return items.length > 0 ? items : undefined
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
      mimeTypes: optionalStringArray(args.mimeTypes),
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
  throw new Error(`unsupported drive tool: ${toolName}`)
}
