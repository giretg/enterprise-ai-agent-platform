import { GoogleDriveApiClient } from '@/domain/connector-grant/google-drive-api-client'
import { recordGoogleDriveAppCreatedFile } from '@/domain/connector-grant/google-drive-grant-store'
import {
  assertGoogleDriveWriteAccess,
  createdDriveFilesFromResult,
  grantUsesSelectedWriteProfile,
} from '@/domain/connector-grant/google-drive-write-access'
import { GoogleWorkspaceApiClient } from '@/domain/connector-grant/google-workspace-api-client'
import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

const GOOGLE_DRIVE_TOOLS = new Set([
  'google_drive_search',
  'google_drive_get_file',
  'google_drive_read_file',
  'google_drive_list_drives',
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
])

const WRITE_TOOLS = new Set([
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
])

async function maybeTrackAppCreatedFiles(params: {
  grantId: string | undefined
  scopes: unknown
  tool: string
  result: unknown
}): Promise<void> {
  if (!params.grantId || !grantUsesSelectedWriteProfile(params.scopes as never)) return
  const created = createdDriveFilesFromResult(params.tool, params.result)
  for (const file of created) {
    await recordGoogleDriveAppCreatedFile({
      grantId: params.grantId,
      fileId: file.fileId,
      name: file.name,
      mimeType: file.mimeType,
    })
  }
}

function enforceWriteAccess(args: ToolHandlerArgs): void {
  const grant = args.authorization.grant
  if (!grant || !WRITE_TOOLS.has(args.input.tool)) return
  assertGoogleDriveWriteAccess({
    tool: args.input.tool,
    args: args.input.args as Record<string, unknown>,
    scopes: grant.scopes,
    metadata: grant.metadata,
  })
}

export const googleDriveHandler: ToolHandler = {
  id: 'google_drive',
  handles(tool) {
    return GOOGLE_DRIVE_TOOLS.has(tool)
  },
  async execute(args) {
    enforceWriteAccess(args)
    const accessToken = await args.ctx.resolveDelegatedAccessToken(args.input, args.authorization)
    const drive = new GoogleDriveApiClient(accessToken)
    const workspace = new GoogleWorkspaceApiClient(accessToken)
    const grant = args.authorization.grant

    switch (args.input.tool) {
      case 'google_drive_search':
        return drive.search(args.input.args)
      case 'google_drive_get_file':
        return drive.getFile(args.input.args)
      case 'google_drive_read_file':
        return drive.readFile(args.input.args)
      case 'google_drive_list_drives':
        return drive.listDrives(args.input.args)
      case 'google_drive_create_folder': {
        const result = await drive.createFolder(args.input.args)
        await maybeTrackAppCreatedFiles({
          grantId: grant?.id,
          scopes: grant?.scopes,
          tool: args.input.tool,
          result,
        })
        return result
      }
      case 'google_drive_rename_file': {
        const result = await drive.renameFile(args.input.args)
        await maybeTrackAppCreatedFiles({
          grantId: grant?.id,
          scopes: grant?.scopes,
          tool: args.input.tool,
          result,
        })
        return result
      }
      case 'google_drive_move_file': {
        const result = await drive.moveFile(args.input.args)
        await maybeTrackAppCreatedFiles({
          grantId: grant?.id,
          scopes: grant?.scopes,
          tool: args.input.tool,
          result,
        })
        return result
      }
      case 'google_drive_copy_file': {
        const result = await drive.copyFile(args.input.args)
        await maybeTrackAppCreatedFiles({
          grantId: grant?.id,
          scopes: grant?.scopes,
          tool: args.input.tool,
          result,
        })
        return result
      }
      case 'google_drive_trash_file': {
        return drive.trashFile(args.input.args)
      }
      case 'google_drive_restore_file': {
        return drive.restoreFile(args.input.args)
      }
      case 'google_drive_share_file':
        return drive.shareFile(args.input.args)
      case 'google_drive_update_file': {
        if (!args.input.args.textContent) {
          throw new Error('google_drive_update_file requires textContent in v1')
        }
        const result = await drive.updateTextContent({
          fileId: args.input.args.fileId,
          textContent: args.input.args.textContent,
          expectedModifiedTime: args.input.args.expectedModifiedTime,
        })
        await maybeTrackAppCreatedFiles({
          grantId: grant?.id,
          scopes: grant?.scopes,
          tool: args.input.tool,
          result,
        })
        return result
      }
      case 'google_drive_upload_file':
        throw new Error(
          'google_drive_upload_file requires artifactRef upload pipeline — használd a create_folder + update_file kombinációt stub módban.',
        )
      case 'google_docs_apply_edits': {
        await workspace.applyDocsEdits(args.input.args.fileId, args.input.args.operations)
        return { ok: true as const, fileId: args.input.args.fileId }
      }
      case 'google_sheets_write_range': {
        const sheetResult = await workspace.writeSheetsRange(args.input.args)
        return { ok: true as const, fileId: args.input.args.fileId, ...sheetResult }
      }
      case 'google_slides_apply_edits': {
        await workspace.applySlidesEdits(args.input.args.fileId, args.input.args.operations)
        return { ok: true as const, fileId: args.input.args.fileId }
      }
      default:
        throw new Error(`Unknown Google Drive tool: ${args.input.tool}`)
    }
  },
}
