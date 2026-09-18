import { z } from 'zod'

export const GOOGLE_DRIVE_SEARCH_TOOL = 'google_drive_search'
export const GOOGLE_DRIVE_READ_FILE_TOOL = 'google_drive_read_file'
export const GOOGLE_DRIVE_CREATE_FOLDER_TOOL = 'google_drive_create_folder'

export const ENTERPRISE_DRIVE_WRITE_TOOLS = [GOOGLE_DRIVE_CREATE_FOLDER_TOOL] as const

export const ENTERPRISE_DRIVE_TOOLS = [
  GOOGLE_DRIVE_SEARCH_TOOL,
  GOOGLE_DRIVE_READ_FILE_TOOL,
  ...ENTERPRISE_DRIVE_WRITE_TOOLS,
] as const

export type EnterpriseDriveWriteTool = (typeof ENTERPRISE_DRIVE_WRITE_TOOLS)[number]
export type EnterpriseDriveTool = (typeof ENTERPRISE_DRIVE_TOOLS)[number]

const ENTERPRISE_DRIVE_TOOL_SET = new Set<string>(ENTERPRISE_DRIVE_TOOLS)
const ENTERPRISE_DRIVE_WRITE_TOOL_SET = new Set<string>(ENTERPRISE_DRIVE_WRITE_TOOLS)

export function isEnterpriseDriveTool(toolName: string): toolName is EnterpriseDriveTool {
  return ENTERPRISE_DRIVE_TOOL_SET.has(toolName)
}

export function isEnterpriseDriveWriteTool(toolName: string): toolName is EnterpriseDriveWriteTool {
  return ENTERPRISE_DRIVE_WRITE_TOOL_SET.has(toolName)
}

const definitionId = z.string().uuid()
const optionalAgentId = z.string().uuid().optional()

export const googleDriveSearchInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    query: z.string().max(1000).optional(),
    nameContains: z.string().max(200).optional(),
    mimeTypes: z.array(z.string().max(120)).max(10).optional(),
    modifiedAfter: z.string().max(40).optional(),
    driveId: z.string().optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
    pageToken: z.string().optional(),
  })
  .passthrough()

export const googleDriveReadFileInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    fileId: z.string().min(1).max(200),
    maxBytes: z.number().int().min(1).max(20_000_000).optional(),
  })
  .passthrough()

export const googleDriveCreateFolderInputSchema = z
  .object({
    definitionId,
    agentId: optionalAgentId,
    name: z.string().min(1).max(500),
    parentFolderId: z.string().max(200).optional(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .passthrough()

export function schemaForEnterpriseDriveTool(toolName: EnterpriseDriveTool) {
  if (toolName === GOOGLE_DRIVE_READ_FILE_TOOL) return googleDriveReadFileInputSchema
  if (toolName === GOOGLE_DRIVE_CREATE_FOLDER_TOOL) return googleDriveCreateFolderInputSchema
  return googleDriveSearchInputSchema
}
